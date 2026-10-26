const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const http = require('node:http');
require('dotenv').config();

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

// In-memory storage (replace with Zetaris in production)
const storage = {
  rssSources: [],
  users: [],
  news: [],
  comments: [],
  discussions: new Map() // newsId -> { active: boolean, interval: timer }
};

// Zetaris configuration
const ZETARIS_URL = process.env.ZETARIS_URL || 'http://localhost:8080';
const ZETARIS_API_KEY = process.env.ZETARIS_API_KEY || '';

// Meterless configuration
const METERLESS_API_URL = process.env.METERLESS_API_URL || 'https://api.meterless.ai/v1';
const METERLESS_API_KEY = process.env.METERLESS_API_KEY || '';

// RSS Parser
const parser = new Parser();

// Helper: Call Zetaris API
async function zetarisRequest(endpoint, method = 'GET', data = null) {
  const url = `${ZETARIS_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ZETARIS_API_KEY}`
    }
  };
  if (data) options.body = JSON.stringify(data);
  
  try {
    const response = await fetch(url, options);
    return await response.json();
  } catch (error) {
    console.error('Zetaris request failed:', error);
    // Fallback to in-memory storage
    return null;
  }
}

// Helper: Call Meterless AI
async function callMeterlessAI(modelName, prompt, personality) {
  const url = `${METERLESS_API_URL}/chat/completions`;
  
  const systemPrompt = `You are an AI with the following personality: ${personality}. 
  You are discussing a news article and comments. Keep responses concise (2-3 sentences max).
  React naturally to both the news content and other comments.`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${METERLESS_API_KEY}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        max_tokens: 150,
        temperature: 0.8
      })
    });
    
    const data = await response.json();
    return data.choices[0]?.message?.content || 'No response from AI';
  } catch (error) {
    console.error('Meterless AI request failed:', error);
    return `[AI Error: ${error.message}]`;
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
  
  // Initial AI responses to the news
  for (const user of storage.users) {
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
    const aiUsers = storage.users.filter(u => u.isAI !== false);
    if (aiUsers.length === 0) return;
    
    const user = aiUsers[Math.floor(Math.random() * aiUsers.length)];
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
  
  // Try to save to Zetaris
  await zetarisRequest('/comments', 'POST', comment);
  
  broadcast('new_comment', comment);
  return comment;
}

// Fetch news from RSS sources
async function fetchNewsFromRSS() {
  for (const source of storage.rssSources) {
    try {
      const feed = await parser.parseURL(source.url);
      
      for (const item of feed.items.slice(0, 10)) {
        const exists = storage.news.some(n => n.link === item.link);
        if (exists) continue;
        
        const newsItem = {
          id: randomUUID(),
          sourceId: source.id,
          sourceName: source.name,
          title: item.title,
          content: item.contentSnippet || item.content || '',
          link: item.link,
          pubDate: item.pubDate,
          fetchedAt: new Date().toISOString()
        };
        
        storage.news.unshift(newsItem);
        
        // Try to save to Zetaris
        await zetarisRequest('/news', 'POST', newsItem);
      }
    } catch (error) {
      console.error(`Error fetching RSS from ${source.url}:`, error);
    }
  }
  
  broadcast('news_updated', storage.news);
}

// API Routes

// RSS Sources
app.get('/api/rss-sources', (req, res) => {
  res.json(storage.rssSources);
});

app.post('/api/rss-sources', async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL required' });
  }
  
  const source = { id: randomUUID(), name, url, createdAt: new Date().toISOString() };
  storage.rssSources.push(source);
  
  await zetarisRequest('/rss-sources', 'POST', source);
  
  // Fetch news immediately
  fetchNewsFromRSS();
  
  res.json(source);
});

app.delete('/api/rss-sources/:id', async (req, res) => {
  storage.rssSources = storage.rssSources.filter(s => s.id !== req.params.id);
  await zetarisRequest(`/rss-sources/${req.params.id}`, 'DELETE');
  res.json({ success: true });
});

// Users (AI Personalities)
app.get('/api/users', (req, res) => {
  res.json(storage.users);
});

app.post('/api/users', async (req, res) => {
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
  await zetarisRequest('/users', 'POST', user);
  
  res.json(user);
});

app.delete('/api/users/:id', async (req, res) => {
  storage.users = storage.users.filter(u => u.id !== req.params.id);
  await zetarisRequest(`/users/${req.params.id}`, 'DELETE');
  res.json({ success: true });
});

// Session handling for human participants (in-memory, no password store yet)
app.post('/api/auth/login', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  let user = storage.users.find(u => u.name === name);
  if (!user) {
    user = {
      id: randomUUID(),
      name,
      modelName: 'human',
      personality: 'Human participant',
      isAI: false,
      createdAt: new Date().toISOString()
    };
    storage.users.push(user);
  }

  const token = Buffer.from(user.id, 'utf8').toString('base64url');
  res.json({ token, user });
});

app.get('/api/auth/me', (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const userId = token ? Buffer.from(token, 'base64url').toString('utf8') : '';
  const user = storage.users.find(u => u.id === userId);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(user);
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
  const comment = await addComment(newsId, userId, text, false);
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

// Manual news fetch
app.post('/api/news/fetch', async (req, res) => {
  await fetchNewsFromRSS();
  res.json({ success: true });
});

// Periodic news fetch (every 10 minutes)
setInterval(fetchNewsFromRSS, 10 * 60 * 1000);

// Initial fetch
fetchNewsFromRSS();

// Express error handler (Express 5 forwards rejected async handlers here)
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));