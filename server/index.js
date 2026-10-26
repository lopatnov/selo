const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const http = require('node:http');
require('dotenv').config();

const { meterlessCloud, meterlessRuntime, providers } = require('./providers');
const { createProvidersRouter } = require('./providers/routes');
const { createZetaris, ZetarisError } = require('./zetaris');
const { createStateStore } = require('./state-store');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
// Express 5 leaves req.body undefined when no JSON payload was sent
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// AI providers (Meterless Runtime + existing hosted Meterless endpoint)
app.use('/api/providers', createProvidersRouter({ runtime: meterlessRuntime, providers }));

// Zetaris is the SQL surface of this app. It speaks one documented contract:
// POST <rest url>/sql-editor/sqls/run with a bearer API key and X-Org-ID.
const zetaris = createZetaris();

// This app has no accounts and no login. Everything below is open by design;
// the single human participant is created lazily on first use.
//
// State lives in one JSON file (server/data/state.json, the `server-data`
// volume in Docker), so RSS sources, AI personalities, news and comments
// survive a restart. SELO_STATE_FILE overrides the path.
const stateStore = createStateStore();

const storage = {
  rssSources: [],
  users: [],
  news: [],
  comments: [],
  discussions: new Map(), // newsId -> { active: boolean, interval: timer }
  participantId: null
};

function hydrateStorage() {
  const saved = stateStore.read();
  storage.rssSources = saved.rssSources;
  storage.users = saved.users;
  storage.news = saved.news;
  storage.comments = saved.comments;
  storage.participantId = saved.participantId;
  return saved;
}

// Every mutation funnels through here: one debounced write per burst.
function persist() {
  stateStore.write({
    participantId: storage.participantId,
    rssSources: storage.rssSources,
    users: storage.users,
    news: storage.news,
    comments: storage.comments
  });
}

const PARTICIPANT_NAME = process.env.SELO_PARTICIPANT_NAME || 'Local User';

function ensureParticipant() {
  let participant = storage.users.find(user => user.id === storage.participantId);
  if (!participant) {
    participant = {
      id: storage.participantId || randomUUID(),
      name: PARTICIPANT_NAME,
      modelName: 'human',
      personality: 'Human participant',
      isAI: false,
      createdAt: new Date().toISOString()
    };
    storage.participantId = participant.id;
    storage.users.push(participant);
    persist();
  }
  return participant;
}

// RSS Parser
const parser = new Parser();

// Helper: Call Meterless AI.
// `meterless/<routing-mode>` ids go to the local Meterless Runtime provider;
// every other model id keeps using the existing hosted endpoint.
async function callMeterlessAI(modelName, prompt, personality) {
  const systemPrompt = `You are an AI with the following personality: ${personality}.
  You are discussing a news article and comments. Keep responses concise (2-3 sentences max).
  React naturally to both the news content and other comments.`;

  const model = typeof modelName === 'string' && modelName.trim() ? modelName.trim() : 'meterless/auto';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  try {
    if (model.startsWith('meterless/')) {
      return await meterlessRuntime.chat({ model, messages, max_tokens: 150, temperature: 0.8 });
    }
    return await meterlessCloud.chat({ model, messages, max_tokens: 150, temperature: 0.8 });
  } catch (error) {
    // Never log the token or a connect link. Only the safe error message.
    console.error(`Meterless request failed (${error.code || 'error'}): ${error.message}`);
    return error.code === 'unauthorized'
      ? '[Meterless rejected the token. Open AI Provider settings and check the token.]'
      : `[AI Error: ${error.message}]`;
  }
}

// Broadcast to WebSocket clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const { type, data } = JSON.parse(message);
      handleWebSocketMessage(ws, type, data);
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

async function handleWebSocketMessage(ws, type, data) {
  switch (type) {
    case 'start_discussion':
      await startDiscussion(data.newsId);
      break;
    case 'stop_discussion':
      stopDiscussion(data.newsId);
      break;
    case 'add_comment':
      await addComment(data.newsId, data.userId, data.text, data.isAI);
      break;
  }
}

// Start AI discussion for a news item
async function startDiscussion(newsId) {
  const news = storage.news.find(n => n.id === newsId);
  if (!news) return;

  const discussion = storage.discussions.get(newsId);
  if (discussion?.active) return;

  storage.discussions.set(newsId, { active: true, interval: null });
  broadcast('discussion_status', { newsId, active: true });

  const aiUsers = storage.users.filter(user => user.isAI !== false);

  // Initial AI responses to the news
  for (const user of aiUsers) {
    const prompt = `News: "${news.title}"\n${news.content}\n\nReact to this news as ${user.name} (${user.modelName}).`;
    const response = await callMeterlessAI(user.modelName, prompt, user.personality);

    await addComment(newsId, user.id, response, true);

    // Small delay between AI responses
    await new Promise(r => setTimeout(r, 1000));
  }

  // Continue discussion periodically
  const interval = setInterval(async () => {
    const activeDiscussion = storage.discussions.get(newsId);
    if (!activeDiscussion?.active) {
      clearInterval(interval);
      return;
    }

    // Get recent comments for context
    const recentComments = storage.comments
      .filter(c => c.newsId === newsId)
      .slice(-5);

    if (recentComments.length === 0) return;

    // Pick a random AI user to respond
    const candidates = storage.users.filter(u => u.isAI !== false);
    if (candidates.length === 0) return;

    const user = candidates[Math.floor(Math.random() * candidates.length)];
    const lastComment = recentComments[recentComments.length - 1];

    const prompt = `Previous comment by ${lastComment.isAI ? 'AI' : 'User'} ${lastComment.userName}: "${lastComment.text}"\n\nRespond to this comment as ${user.name} (${user.modelName}).`;
    const response = await callMeterlessAI(user.modelName, prompt, user.personality);

    await addComment(newsId, user.id, response, true);
  }, 30000); // Every 30 seconds

  storage.discussions.set(newsId, { active: true, interval });
}

// Stop AI discussion
function stopDiscussion(newsId) {
  const discussion = storage.discussions.get(newsId);
  if (discussion?.interval) {
    clearInterval(discussion.interval);
  }
  storage.discussions.set(newsId, { active: false, interval: null });
  broadcast('discussion_status', { newsId, active: false });
}

// Add comment (user or AI)
async function addComment(newsId, userId, text, isAI = false) {
  const user = storage.users.find(u => u.id === userId);
  if (!user) return null;

  const comment = {
    id: randomUUID(),
    newsId,
    userId,
    userName: user.name,
    text,
    isAI,
    timestamp: new Date().toISOString()
  };

  storage.comments.push(comment);
  persist();
  broadcast('new_comment', comment);
  return comment;
}

const RSS_ITEMS_PER_FETCH = 10;

// Fetch one source and remember how it went, so the UI can show it.
async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const known = new Set(storage.news.map(item => item.link));
    let added = 0;

    // Oldest first so unshift() leaves the newest item on top.
    for (const item of feed.items.slice(0, RSS_ITEMS_PER_FETCH).reverse()) {
      if (!item.link || known.has(item.link)) continue;
      known.add(item.link);
      storage.news.unshift({
        id: randomUUID(),
        sourceId: source.id,
        sourceName: source.name,
        title: item.title || '(untitled)',
        content: item.contentSnippet || item.content || '',
        link: item.link,
        pubDate: item.pubDate,
        fetchedAt: new Date().toISOString()
      });
      added += 1;
    }

    source.lastFetchedAt = new Date().toISOString();
    source.lastError = null;
    source.lastItemCount = added;
    return { ok: true, added };
  } catch (error) {
    source.lastFetchedAt = new Date().toISOString();
    source.lastError = error.message;
    source.lastItemCount = 0;
    console.error(`Error fetching RSS from ${source.url}:`, error.message);
    return { ok: false, added: 0, error: error.message };
  }
}

// Fetch every configured source (all of them, not just the newest).
async function fetchNewsFromRSS() {
  const results = [];
  for (const source of storage.rssSources) {
    results.push({ id: source.id, name: source.name, ...(await fetchSource(source)) });
  }

  persist();
  broadcast('news_updated', storage.news);
  broadcast('rss_sources_updated', storage.rssSources.map(sourceWithStats));
  return results;
}

// API Routes

// The single local participant: no login, no password, no token.
app.get('/api/participant', (req, res) => {
  res.json(ensureParticipant());
});

app.put('/api/participant', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const participant = ensureParticipant();
  participant.name = name.slice(0, 80);
  persist();
  res.json(participant);
});

// RSS Sources — every source in the list is polled, not just one.
function sourceWithStats(source) {
  const items = storage.news.filter(item => item.sourceId === source.id);
  return {
    ...source,
    itemCount: items.length,
    latestItemAt: items[0]?.fetchedAt || null
  };
}

app.get('/api/rss-sources', (req, res) => {
  res.json(storage.rssSources.map(sourceWithStats));
});

app.post('/api/rss-sources', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL required' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }
  const duplicate = storage.rssSources.find(
    source => source.url.toLowerCase() === url.toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ error: 'That feed is already in the list', id: duplicate.id });
  }

  const source = {
    id: randomUUID(),
    name,
    url,
    createdAt: new Date().toISOString(),
    lastFetchedAt: null,
    lastError: null,
    lastItemCount: 0
  };
  storage.rssSources.push(source);
  persist();

  // Fetch this source immediately (do not block the response).
  fetchSource(source)
    .then(() => {
      persist();
      broadcast('rss_sources_updated', storage.rssSources.map(sourceWithStats));
      broadcast('news_updated', storage.news);
    })
    .catch(error => console.error('RSS fetch failed:', error.message));

  res.json(sourceWithStats(source));
});

app.post('/api/rss-sources/:id/fetch', async (req, res) => {
  const source = storage.rssSources.find(s => s.id === req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });

  const result = await fetchSource(source);
  persist();
  broadcast('rss_sources_updated', storage.rssSources.map(sourceWithStats));
  broadcast('news_updated', storage.news);
  res.json({ ...sourceWithStats(source), ...result });
});

app.delete('/api/rss-sources/:id', (req, res) => {
  const before = storage.rssSources.length;
  storage.rssSources = storage.rssSources.filter(s => s.id !== req.params.id);
  if (storage.rssSources.length === before) {
    return res.status(404).json({ error: 'Not found' });
  }
  persist();
  res.json({ success: true });
});

// Users (AI Personalities)
app.get('/api/users', (req, res) => {
  res.json(storage.users);
});

app.post('/api/users', (req, res) => {
  const { name, modelName, personality, isAI = true } = req.body;
  if (!name || !modelName || !personality) {
    return res.status(400).json({ error: 'Name, modelName, and personality required' });
  }

  const user = {
    id: randomUUID(),
    name,
    modelName,
    personality,
    isAI,
    createdAt: new Date().toISOString()
  };

  storage.users.push(user);
  persist();
  res.json(user);
});

app.delete('/api/users/:id', (req, res) => {
  if (req.params.id === storage.participantId) {
    return res.status(400).json({ error: 'The local participant cannot be deleted' });
  }
  const before = storage.users.length;
  storage.users = storage.users.filter(u => u.id !== req.params.id);
  if (storage.users.length === before) {
    return res.status(404).json({ error: 'Not found' });
  }
  persist();
  res.json({ success: true });
});

// News
app.get('/api/news', (req, res) => {
  res.json(storage.news);
});

app.get('/api/news/:id', (req, res) => {
  const news = storage.news.find(n => n.id === req.params.id);
  if (!news) return res.status(404).json({ error: 'Not found' });

  const comments = storage.comments.filter(c => c.newsId === news.id);
  const discussion = storage.discussions.get(news.id);

  res.json({ ...news, comments, discussionActive: discussion?.active || false });
});

// Comments
app.post('/api/comments', async (req, res) => {
  const { newsId, userId, text } = req.body;
  if (!newsId || !text) {
    return res.status(400).json({ error: 'newsId and text are required' });
  }
  const comment = await addComment(newsId, userId || storage.participantId, text, false);
  if (!comment) return res.status(400).json({ error: 'Invalid user' });
  res.json(comment);
});

// Discussion control
app.post('/api/discussion/start', async (req, res) => {
  await startDiscussion(req.body.newsId);
  res.json({ success: true });
});

app.post('/api/discussion/stop', (req, res) => {
  stopDiscussion(req.body.newsId);
  res.json({ success: true });
});

// Manual news fetch: every source is polled, and the per-source result is returned.
app.post('/api/news/fetch', async (req, res) => {
  const results = await fetchNewsFromRSS();
  res.json({ success: true, sources: results, added: results.reduce((sum, r) => sum + r.added, 0) });
});

// Zetaris: configuration + honest status
app.get('/api/zetaris', async (req, res) => {
  const status = await zetaris.probe();
  res.json({ ...zetaris.getConfig(), status });
});

// Zetaris: read-only SQL. Anything that is not a single SELECT/SHOW/DESCRIBE/WITH
// statement is refused, so the browser can never write to the platform.
const READ_ONLY_SQL = /^\s*(select|show|describe|with)\b/i;

app.post('/api/zetaris/query', async (req, res) => {
  const sql = typeof req.body?.sql === 'string' ? req.body.sql.trim() : '';
  if (!sql) {
    return res.status(400).json({ error: 'sql is required', code: 'invalid_request' });
  }
  if (sql.includes(';')) {
    return res.status(400).json({ error: 'Send exactly one statement.', code: 'invalid_request' });
  }
  if (!READ_ONLY_SQL.test(sql)) {
    return res.status(400).json({
      error: 'Only SELECT, SHOW, DESCRIBE and WITH statements are allowed here.',
      code: 'invalid_request'
    });
  }

  try {
    const limit = Number.isInteger(req.body?.limit) ? req.body.limit : undefined;
    const result = await zetaris.runSql(sql, limit ? { limit } : undefined);
    res.json(result);
  } catch (error) {
    if (error instanceof ZetarisError) {
      const status = error.code === 'unauthorized' ? 401 : error.code === 'invalid_request' ? 400 : 502;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
});

// AI provider summary used by the AI Provider page header
app.get('/api/providers/status', async (req, res) => {
  const [meterless, zetarisStatus] = await Promise.all([
    meterlessRuntime.getStatus(),
    zetaris.probe()
  ]);
  res.json({ meterless, zetaris: zetarisStatus });
});

// Express error handler (Express 5 forwards rejected async handlers here)
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Load the saved state before anything can be served.
const savedState = hydrateStorage();

// Periodic news fetch (every 10 minutes). Only timers that can do work are kept.
if (storage.rssSources.length > 0) {
  setInterval(fetchNewsFromRSS, 10 * 60 * 1000).unref();
  // Refresh once shortly after boot so a restarted server is not stale.
  setTimeout(() => {
    fetchNewsFromRSS().catch(error => console.error('Startup RSS fetch failed:', error.message));
  }, 3000).unref();
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `State: ${stateStore.filePath} · ${storage.rssSources.length} RSS source(s) · ` +
      `${storage.users.length} user(s) · ${storage.news.length} news · ${storage.comments.length} comment(s)` +
      (savedState.updatedAt ? ` · saved ${savedState.updatedAt}` : ' · new file')
  );
  console.log(`WebSocket server ready`);

  const zetarisConfig = zetaris.getConfig();
  console.log(
    `Zetaris: ${zetarisConfig.restUrl} · org ${zetarisConfig.orgId} · key ${zetarisConfig.hasKey ? 'set' : 'MISSING'}`
  );
  const meterlessConfig = meterlessRuntime.getConfig();
  console.log(
    `Meterless Runtime: ${meterlessConfig.baseUrl} · token ${meterlessConfig.hasToken ? meterlessConfig.tokenSource : 'MISSING'}`
  );

  // Report both providers once at boot so `docker logs` tells the truth.
  Promise.all([meterlessRuntime.getStatus(), zetaris.probe()])
    .then(([meterless, zetarisStatus]) => {
      console.log(`Meterless Runtime status: ${meterless.status}`);
      console.log(
        `Zetaris status: ${zetarisStatus.status}${zetarisStatus.reason ? ` (${zetarisStatus.reason})` : ''}`
      );
    })
    .catch(error => console.error('Provider status check failed:', error.message));
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  // Do not lose a debounced write on the way out.
  stateStore.flush();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => stateStore.flush());
