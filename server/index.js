const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const http = require('node:http');
// Provider credentials follow .env even when a Windows user-level variable
// exists; everything else keeps plain dotenv semantics (see server/load-env.js).
require('./load-env').loadEnv();

const { meterlessCloud, meterlessRuntime, providers } = require('./providers');
const { createProvidersRouter } = require('./providers/routes');
const { createZetaris, ZetarisError } = require('./zetaris');
const { createStateStore } = require('./state-store');
const { sanitizeModelText } = require('./meterless-text');
const { createMeterlessLog, defaultLogFile } = require('./meterless-log');
const { createActivityTracker } = require('./activity');
const {
  APP_SETTINGS_LIMITS,
  normalizeAppSettings
} = require('./app-settings');
const {
  canPostMessage,
  nextDelayMs,
  normalizeDiscussionSettings
} = require('./discussion-settings');

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
// ask / think / answer records for every Meterless call, newest first. They are
// persisted next to the app state, so the **Ask** / **Thinking** toggles under a
// comment still work after a restart.
const meterlessLog = createMeterlessLog({ limit: 200, file: defaultLogFile() });
// Per-agent request counters, served by `GET /api/activity` for diagnostics.
const activity = createActivityTracker();

const storage = {
  rssSources: [],
  users: [],
  news: [],
  comments: [],
  discussions: new Map(), // newsId -> { active: boolean, runner, agentIds, ... }
  participantId: null,
  settings: normalizeAppSettings()
};

function hydrateStorage() {
  const saved = stateStore.read();
  storage.rssSources = saved.rssSources;
  storage.users = saved.users;
  storage.news = saved.news;
  storage.comments = saved.comments;
  storage.participantId = saved.participantId;
  storage.settings = normalizeAppSettings(saved.settings);
  return saved;
}

/**
 * Every mutation funnels through here: one debounced write per burst.
 *
 * `immediate` is used for comments: an AI answer costs a model call and cannot
 * be regenerated, so it must reach the disk before the next (possibly forced)
 * shutdown instead of waiting for the debounce window.
 */
function persist({ immediate = false } = {}) {
  stateStore.write({
    participantId: storage.participantId,
    rssSources: storage.rssSources,
    users: storage.users,
    news: storage.news,
    comments: storage.comments,
    settings: normalizeAppSettings(storage.settings)
  });
  if (immediate) stateStore.flush();
}

/**
 * The payload behind `GET /api/activity`: the request counters plus how many
 * discussions are running right now. Diagnostics only — the UI does not poll it.
 */
function activityPayload(snapshot = activity.snapshot()) {
  let activeDiscussions = 0;
  for (const discussion of storage.discussions.values()) {
    if (discussion?.active) activeDiscussions += 1;
  }
  return {
    ...snapshot,
    settings: normalizeAppSettings(storage.settings),
    activeDiscussions
  };
}

function currentSettings() {
  return normalizeAppSettings(storage.settings);
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

// Every Meterless call is recorded as ask → think → answer, kept in memory and
// served to the UI (GET /api/meterless/log). The console prints one concise
// line per call; the full prompt and reasoning stay available in the Meterless
// Log panel, so a busy discussion does not flood the terminal with the same
// prompt over and over.
function shortPreview(text, max = 80) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function logMeterlessCall(entry) {
  const who = entry.userName || 'unknown user';
  const model = entry.model || 'unknown model';
  if (entry.error) {
    console.log(`[Meterless] ❌ ${who} · ${model} · ${entry.error}`);
    return;
  }
  console.log(
    `[Meterless] ✅ ${who} · ${model} · ${entry.durationMs ?? '?'} ms · ${shortPreview(entry.answer) || '(empty answer)'}`
  );
}

const AI_MAX_ATTEMPTS = 3;
const AI_RETRY_DELAY_MS = 900;
// A rejected token or a missing key cannot be fixed by repeating the request.
const AI_NON_RETRYABLE = new Set(['unauthorized', 'invalid_token', 'invalid_request']);

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------
// The Meterless Runtime is this app's AI. It routes every model id the user can
// configure: routing modes (`meterless/auto`, …), provider ids from its own
// catalogue (`openrouter/qwen/qwen3.8-27b:free`, `local-runtime/…`) and plain
// aliases such as `qwen3-8-27b-free`, which the Provider page's "test request"
// already accepts. The catalogue is therefore *not* a whitelist — an id that is
// missing from it can still be served, so no personality is ever skipped for
// "unknown model".
//
// The legacy hosted endpoint stays reachable, but only for ids that say so
// explicitly (`cloud/<model>`): silently posting plain ids to a dead endpoint
// was the reason a discussion could end without a single usable answer.
const CLOUD_MODEL_PREFIX = /^(cloud|meterless-cloud)\//i;

/** Routing decisions must not depend on a network round trip per message. */
function providerForModel(model) {
  return CLOUD_MODEL_PREFIX.test(model) ? meterlessCloud : meterlessRuntime;
}

function providerModelName(model) {
  return CLOUD_MODEL_PREFIX.test(model) ? model.replace(CLOUD_MODEL_PREFIX, '') : model;
}

/**
 * Is this personality's model callable at all?
 *
 * Only a configuration gap is refused here — a missing id (which falls back to
 * `meterless/auto` anyway) or a `cloud/` id without `METERLESS_API_KEY`. The
 * runtime itself decides what it can route, and its own error is reported.
 *
 * @returns {{ ok: boolean, provider?: string, model?: string, reason?: string, detail?: string }}
 */
function checkModelSupport(model) {
  const raw = typeof model === 'string' ? model.trim() : '';
  const id = raw || 'meterless/auto';

  if (CLOUD_MODEL_PREFIX.test(id)) {
    return meterlessCloud.getConfig().hasToken
      ? { ok: true, provider: meterlessCloud.id, model: providerModelName(id) }
      : {
          ok: false,
          reason: 'cloud_not_configured',
          detail: 'METERLESS_API_KEY is not configured for the legacy cloud endpoint.'
        };
  }

  return { ok: true, provider: meterlessRuntime.id, model: id };
}

// Turn the final failure into a message a personality can actually say, plus
// the machine-readable details the UI shows behind an error button.
function describeMeterlessFailure(error, model = '') {
  const code = error?.code || 'error';
  const message = error?.message || 'Meterless request failed.';
  const attempts = Number.isInteger(error?.attempts) ? error.attempts : null;
  const label = model ? ` (model "${model}")` : '';

  if (code === 'unauthorized' || code === 'invalid_token') {
    return {
      code,
      message,
      attempts,
      text: `I can't answer yet — my Meterless token was rejected${label}, so the request never reached a model.`
    };
  }

  if (code === 'offline' || code === 'empty_answer') {
    return {
      code,
      message,
      attempts,
      text: `I honestly don't know what to make of this — my request${label} never produced an answer.`
    };
  }

  // The runtime did answer, but with a refusal: repeat what it said instead of
  // pretending the model was unreachable.
  return {
    code,
    message,
    attempts,
    text: `I can't answer right now${label} — ${message}`
  };
}

// Helper: Call Meterless AI.
// `cloud/<model>` ids go to the legacy hosted endpoint; every other model id is
// sent to the Meterless Runtime as-is (routing mode, catalogue id or plain
// alias), because the runtime is what decides how it is routed.
// Each request is retried a few times before the failure is reported, because
// a single network hiccup must not end a discussion. Every attempt is visible
// in the activity tracker, so the header shows what is being processed now.
// Returns { answer, think, entry, error }: `answer` is sanitised text safe to
// post, `think` is the reasoning that must never become a comment, `error`
// carries { code, message, attempts } when no answer could be produced.
async function callMeterlessAI({ newsId = null, user, prompt, systemPrompt }) {
  const model =
    typeof user?.modelName === 'string' && user.modelName.trim()
      ? user.modelName.trim()
      : 'meterless/auto';

  const system =
    typeof systemPrompt === 'string' && systemPrompt.trim()
      ? systemPrompt.trim()
      : `You are ${user?.name || 'an AI participant'}. Personality: ${
          user?.personality || 'an opinionated participant'
        }. Reply with the reaction only, 2-3 sentences.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  const startedAt = Date.now();
  const record = {
    newsId,
    userName: user?.name || '',
    model,
    ask: `[system]\n${system}\n\n[user]\n${prompt}`
  };

  const provider = providerForModel(model);
  const providerModel = providerModelName(model);
  let lastError = null;
  let attempts = 0;

  console.log(`[Meterless] 🚀 ${user?.name || 'unknown user'} · ${model} — request sent`);

  while (attempts < AI_MAX_ATTEMPTS) {
    attempts += 1;

    // Visible in the header statistics while the model is working.
    const handle = activity.begin({
      userName: user?.name || '',
      userId: user?.id || null,
      model,
      newsId
    });
    let succeeded = false;

    try {
      // Reasoning models spend tokens on the chain of thought before the answer,
      // so a tight cap truncates them into "reasoning only" replies.
      const result = await provider.chatDetailed({
        model: providerModel,
        messages,
        max_tokens: 700,
        temperature: 0.8
      });

      // Reasoning may come as a separate field and/or inline in the content.
      const { think, answer } = sanitizeModelText(result?.content);
      const reasoning = [result?.reasoning, think]
        .map(part => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join('\n\n');

      if (answer) {
        const entry = meterlessLog.push({
          ...record,
          think: reasoning,
          answer,
          durationMs: Date.now() - startedAt,
          error: null
        });
        logMeterlessCall(entry);
        broadcast('meterless_log_entry', entry);
        succeeded = true;
        return { answer, think: reasoning, entry, error: null };
      }

      lastError = {
        code: 'empty_answer',
        message: 'The model returned reasoning only; there was no answer to post.'
      };
      console.warn(
        `[Meterless] ⚠ ${user?.name || 'unknown user'} · ${model} · attempt ${attempts}/${AI_MAX_ATTEMPTS} produced no postable answer`
      );
    } catch (error) {
      lastError = {
        code: error?.code || 'error',
        message: error?.message || 'Meterless request failed.'
      };
      console.error(
        `[Meterless] ❌ ${user?.name || 'unknown user'} · ${model} · attempt ${attempts}/${AI_MAX_ATTEMPTS} · ${lastError.code}: ${lastError.message}`
      );
      if (AI_NON_RETRYABLE.has(lastError.code)) break;
    } finally {
      activity.end(handle, { ok: succeeded });
    }

    if (attempts < AI_MAX_ATTEMPTS) await sleep(AI_RETRY_DELAY_MS * attempts);
  }

  const reported = { ...lastError, attempts };
  const entry = meterlessLog.push({
    ...record,
    think: '',
    answer: '',
    durationMs: Date.now() - startedAt,
    error: `${reported.message} (after ${attempts} attempt${attempts === 1 ? '' : 's'})`
  });
  logMeterlessCall(entry);
  broadcast('meterless_log_entry', entry);

  return { answer: '', think: '', entry, error: reported };
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

function sendTo(ws, type, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, data }));
}

// One socket per browser tab is enough, so dead peers must be noticed and
// dropped quickly: proxies silently kill idle connections, and without a
// heartbeat the server keeps dead sockets (and the client keeps reconnecting
// on top of a socket that is actually fine).
const WS_HEARTBEAT_MS = 30000;

let socketSequence = 0;

wss.on('connection', (ws) => {
  socketSequence += 1;
  const socketId = socketSequence;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // The count tells whether a flood is real: one open page must mean one
  // socket. A close line with its code shows who dropped the connection.
  const openCount = () => wss.clients.size;
  console.log(`WebSocket #${socketId} connected (${openCount()} open)`);

  ws.on('close', (code, reason) => {
    const detail = reason ? ` ${reason}` : '';
    console.log(`WebSocket #${socketId} closed (${code}${detail}, ${openCount()} open)`);
  });

  ws.on('message', (message) => {
    try {
      const { type, data } = JSON.parse(message);
      handleWebSocketMessage(ws, type, data);
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  // A freshly opened page must not wait for the next change to show the
  // current discussion settings.
  sendTo(ws, 'settings_updated', currentSettings());
});

const wsHeartbeat = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) {
      client.terminate();
      return;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      // The socket vanished between the loop and the ping.
    }
  });
}, WS_HEARTBEAT_MS);
if (typeof wsHeartbeat.unref === 'function') wsHeartbeat.unref();

// The runner below paces every AI personality with that personality's own
// settings: send immediately, a min/max delay range, a cap on messages per
// news item and a cap on consecutive messages.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DISCUSSION_MIN_WAIT_SLICE_MS = 250;
const DISCUSSION_IDLE_RECHECK_MS = 5000;
// After a failed turn the personality rests while the others keep talking.
// Repeated failures back off further, up to a couple of minutes.
const DISCUSSION_FAILURE_COOLDOWN_MS = 15000;
const DISCUSSION_MAX_COOLDOWN_MS = 120000;

// AI users only: the local human participant (isAI: false, modelName: "human")
// never posts AI replies.
function aiParticipants() {
  return storage.users.filter(user => user.isAI !== false && user.modelName !== 'human');
}

function isDiscussionActive(newsId) {
  return Boolean(storage.discussions.get(newsId)?.active);
}

function commentThread(newsId) {
  return storage.comments.filter(comment => comment.newsId === newsId);
}

// Error notices are not opinions: they never consume the message budget.
function messageCountFor(newsId, userId) {
  return commentThread(newsId).filter(
    comment => comment.userId === userId && !comment.isError
  ).length;
}

// Own messages at the tail of the thread: this is what "consecutive" means.
// Somebody else's error notice still counts as them speaking, so a broken
// provider never traps the healthy personalities behind their own limit.
function consecutiveCountFor(newsId, userId) {
  const thread = commentThread(newsId);
  let count = 0;
  for (let index = thread.length - 1; index >= 0; index -= 1) {
    const comment = thread[index];
    if (comment.isError) {
      if (comment.userId !== userId) break;
      continue;
    }
    if (comment.userId !== userId) break;
    count += 1;
  }
  return count;
}

// Wait, but abandon the wait the moment the discussion is stopped.
async function waitForDiscussion(newsId, ms) {
  const deadline = Date.now() + Math.max(0, ms);
  for (;;) {
    if (!isDiscussionActive(newsId)) return false;
    const left = deadline - Date.now();
    if (left <= 0) return true;
    await sleep(Math.min(left, DISCUSSION_MIN_WAIT_SLICE_MS));
  }
}

/**
 * Pick the next speaker at random among the personalities that may post right
 * now. Random instead of round-robin on purpose: the order of the discussion
 * should not be predictable from the order in which the personalities happen
 * to be stored.
 *
 * `random` is injectable so the choice is testable.
 */
function pickNextAiUser(newsId, users, cooldowns = new Map(), random = Math.random) {
  const now = Date.now();
  const candidates = [];

  for (const user of users) {
    if ((cooldowns.get(user.id) || 0) > now) continue;
    const settings = normalizeDiscussionSettings(user);
    const { allowed } = canPostMessage({
      messageCount: messageCountFor(newsId, user.id),
      consecutiveCount: consecutiveCountFor(newsId, user.id),
      settings
    });
    if (allowed) candidates.push({ user, settings });
  }

  if (candidates.length === 0) return null;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}

/**
 * Draw the personalities that will discuss this news item. A news item is
 * "seen" by at most `agentsPerNews` (1..5, default 1) personalities; they are
 * sampled at random, and only from the ones that can still post.
 */
function sampleAiUsers(users, count, random = Math.random) {
  const pool = users.slice();
  // Fisher–Yates, so every personality has the same chance of being drawn.
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, Math.max(0, count));
}

function allAiAtMessageLimit(newsId, users) {
  return users.every(user => {
    const settings = normalizeDiscussionSettings(user);
    return messageCountFor(newsId, user.id) >= settings.maxMessagesPerNews;
  });
}

/** The personalities assigned to one discussion (and still existing). */
function discussionAgents(discussion) {
  const assigned = Array.isArray(discussion?.agentIds) ? new Set(discussion.agentIds) : null;
  const users = aiParticipants();
  if (!assigned || assigned.size === 0) return users;
  return users.filter(user => assigned.has(user.id));
}

async function handleWebSocketMessage(ws, type, data) {
  switch (type) {
    case 'start_discussion': {
      const result = await startDiscussion(data?.newsId);
      if (!result.ok) {
        console.warn(`WebSocket start_discussion refused: ${result.error}`);
        // Tell this socket why nothing will happen; a silent refusal is what
        // makes the UI look frozen.
        sendTo(ws, 'discussion_error', {
          newsId: data?.newsId ?? null,
          error: result.error,
          code: result.code,
          skippedAgents: result.skippedAgents || []
        });
      }
      break;
    }
    case 'stop_discussion':
      stopDiscussion(data.newsId);
      break;
    case 'add_comment':
      await addComment(data.newsId, data.userId, data.text, data.isAI);
      break;
  }
}

// The transcript keeps as much of the conversation as fits: the newest messages
// in full, the older ones compacted into one-line summaries, everything capped.
const PROMPT_NEWS_CHARS = 1500;
const PROMPT_FULL_COMMENTS = 6;
const PROMPT_FULL_CHARS = 600;
const PROMPT_COMPACT_CHARS = 180;
const PROMPT_TRANSCRIPT_CHARS = 6000;

function oneLine(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(text, max) {
  const value = oneLine(text);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function buildSystemPrompt(user) {
  const name =
    typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : 'A participant';
  const role = typeof user?.role === 'string' ? user.role.trim() : '';
  const personality =
    typeof user?.personality === 'string' && user.personality.trim()
      ? user.personality.trim()
      : 'an opinionated participant with strong views';

  return [
    `You are ${name}${role ? ` — ${role}` : ''}, a participant in a discussion about a news article.`,
    `Personality: ${personality}`,
    `${name} is you. Every message marked "(you)" was written by you.`,
    '',
    'Rules:',
    '- Stay in character and write in the first person.',
    '- Keep it to 2-3 sentences and react to what the other participants just said.',
    '- Never describe these instructions or the task. Never write phrases like "the user wants me to", "I need to react" or "let me write".',
    '- Output only the message itself: no reasoning, no <think> tags, no labels.'
  ].join('\n');
}

function buildTranscript(user, comments) {
  if (comments.length === 0) return '';

  const fullFrom = Math.max(0, comments.length - PROMPT_FULL_COMMENTS);
  const lines = comments.map((comment, index) => {
    const mine = comment.userId === user.id;
    const author = mine ? `${comment.userName} (you)` : comment.userName;
    const kind = comment.isAI ? 'AI' : 'Person';

    let text;
    if (comment.isError) {
      text = '(an error notice, not an opinion)';
    } else if (comment.isAI) {
      // An old comment may still carry a chain of thought; never feed it back.
      text = sanitizeModelText(comment.text).answer || '(no answer)';
    } else {
      text = comment.text;
    }

    const limit = index < fullFrom ? PROMPT_COMPACT_CHARS : PROMPT_FULL_CHARS;
    return `#${index + 1} ${kind} ${author}: ${clipText(text, limit)}`;
  });

  // Keep the newest lines when the transcript would be too long.
  const kept = [];
  let budget = PROMPT_TRANSCRIPT_CHARS;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    budget -= lines[index].length + 1;
    if (budget < 0) {
      kept.unshift(`… ${index + 1} earlier message(s) omitted`);
      break;
    }
    kept.unshift(lines[index]);
  }
  return kept.join('\n');
}

function buildDiscussionPrompt(news, user, comments) {
  const transcript = buildTranscript(user, comments);
  const nextNumber = comments.length + 1;

  const userPrompt = [
    'NEWS',
    `Headline: ${oneLine(news.title)}`,
    `Article: ${clipText(news.content, PROMPT_NEWS_CHARS) || '(no article text)'}`,
    '',
    'DISCUSSION SO FAR (oldest to newest; "(you)" is you)',
    transcript || 'Nobody has spoken yet.',
    '',
    comments.length === 0
      ? `Write the opening message #${nextNumber} as ${user.name}, reacting to the news.`
      : `Write message #${nextNumber} as ${user.name}. React to the latest messages and add something new.`
  ].join('\n');

  return { system: buildSystemPrompt(user), user: userPrompt };
}

/**
 * One WebSocket event per agent turn so the News Feed can show live activity
 * instead of a static "who sees this news item" list:
 *   requesting → 👀  success → ✅  error → ❌
 * After a successful comment the UI hides the badge again.
 */
function broadcastAgentActivity(newsId, user, status, extra = {}) {
  broadcast('agent_activity', {
    newsId,
    status,
    agent: {
      id: user.id,
      name: user.name,
      model: user.modelName || ''
    },
    ...extra
  });
}

function finishDiscussion(newsId, reason) {
  const current = storage.discussions.get(newsId);
  if (!current?.active) return;
  storage.discussions.set(newsId, {
    ...current,
    active: false,
    stoppedReason: reason,
    stoppedAt: new Date().toISOString()
  });
  broadcast('discussion_status', { newsId, active: false, reason });
  console.log(`Discussion stopped for ${newsId}: ${reason}`);
}

/**
 * One background runner per news item. Only the personalities assigned to that
 * news item take part (1..5 of them, drawn at random when the discussion
 * starts); the next speaker is chosen at random among those that may post, and
 * every personality keeps its own pacing and limits.
 *
 * Runs in the background on purpose: a cold routing mode can take minutes, so
 * the HTTP request must never wait for the first answer.
 */
async function runDiscussion(newsId, news) {
  const discussion = storage.discussions.get(newsId);
  if (!discussion) return;

  // Per-turn state: who is resting after a failure, who already showed an
  // error notice (so a dead provider does not spam the thread), and how many
  // times each personality failed in a row.
  const cooldowns = discussion.cooldowns || new Map();
  const apologized = discussion.apologies || new Set();
  const failuresByUser = discussion.failuresByUser || new Map();
  discussion.cooldowns = cooldowns;
  discussion.apologies = apologized;
  discussion.failuresByUser = failuresByUser;

  while (isDiscussionActive(newsId)) {
    const users = discussionAgents(discussion);
    if (users.length === 0) {
      finishDiscussion(newsId, 'no_ai_users');
      return;
    }

    const picked = pickNextAiUser(newsId, users, cooldowns);
    if (!picked) {
      if (allAiAtMessageLimit(newsId, users)) {
        finishDiscussion(newsId, 'max_messages');
        return;
      }
      // Either somebody is waiting for another participant to speak, or every
      // personality is resting after a provider failure. Keep the discussion
      // alive and try again shortly; never freeze on one bad request.
      if (!(await waitForDiscussion(newsId, DISCUSSION_IDLE_RECHECK_MS))) return;
      continue;
    }

    const delayMs = nextDelayMs(picked.settings);
    if (delayMs > 0 && !(await waitForDiscussion(newsId, delayMs))) return;

    const prompt = buildDiscussionPrompt(news, picked.user, commentThread(newsId));
    broadcastAgentActivity(newsId, picked.user, 'requesting');
    const result = await callMeterlessAI({
      newsId,
      user: picked.user,
      prompt: prompt.user,
      systemPrompt: prompt.system
    });

    if (!isDiscussionActive(newsId)) return;

    if (result.answer && !result.error) {
      cooldowns.delete(picked.user.id);
      apologized.delete(picked.user.id);
      failuresByUser.delete(picked.user.id);
      const comment = await addComment(newsId, picked.user.id, result.answer, true, {
        logEntryId: result.entry?.id ?? null
      });
      broadcastAgentActivity(newsId, picked.user, 'success', {
        commentId: comment?.id ?? null
      });
      continue;
    }

    // The provider failed after all retries. Say it in the personality's own
    // voice once, keep the machine details behind an error button, and let the
    // other participants carry the discussion.
    const failure = describeMeterlessFailure(result.error, picked.user.modelName);
    const strikes = (failuresByUser.get(picked.user.id) || 0) + 1;
    failuresByUser.set(picked.user.id, strikes);
    const cooldownMs = Math.min(
      DISCUSSION_MAX_COOLDOWN_MS,
      DISCUSSION_FAILURE_COOLDOWN_MS * strikes
    );
    cooldowns.set(picked.user.id, Date.now() + cooldownMs);

    broadcastAgentActivity(newsId, picked.user, 'error', {
      code: failure.code,
      message: failure.message
    });

    if (!apologized.has(picked.user.id)) {
      apologized.add(picked.user.id);
      await addComment(newsId, picked.user.id, failure.text, true, {
        isError: true,
        logEntryId: result.entry?.id ?? null,
        error: {
          code: failure.code,
          message: failure.message,
          attempts: failure.attempts
        }
      });
    }
  }
}

/**
 * Start AI discussion for a news item.
 *
 * Only personalities whose model the Meterless Runtime can actually serve are
 * given the news item, and at most `agentsPerNews` (1..5, default 1) of them
 * are drawn at random for it. Returns { ok: true, … } immediately, or a refusal
 * with the HTTP status the route should use. Replies are broadcast over the
 * WebSocket.
 */
async function startDiscussion(newsId) {
  if (typeof newsId !== 'string' || !newsId.trim()) {
    return { ok: false, status: 400, code: 'invalid_request', error: 'newsId is required.' };
  }

  const news = storage.news.find(n => n.id === newsId);
  if (!news) {
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      error: 'That news item is no longer in the feed. Refresh the feed and try again.'
    };
  }

  const aiUsers = aiParticipants();
  if (aiUsers.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'no_ai_users',
      error:
        'No AI participants yet. Create an AI user under Users (with a personality and a model), then start the discussion again.'
    };
  }

  const existing = storage.discussions.get(newsId);
  if (existing?.active) {
    return {
      ok: true,
      alreadyRunning: true,
      aiParticipants: discussionAgents(existing).length,
      agentIds: existing.agentIds || []
    };
  }

  // Only a real configuration gap removes a personality from the pool (a
  // `cloud/` id without METERLESS_API_KEY). The runtime routes plain ids, so a
  // model that is absent from its catalogue is still tried and its own error is
  // shown instead of an invented "unknown model".
  const usable = [];
  const skippedAgents = [];

  for (const user of aiUsers) {
    const support = checkModelSupport(user.modelName);
    if (support.ok) {
      usable.push(user);
    } else {
      skippedAgents.push({
        userId: user.id,
        userName: user.name,
        model: user.modelName || '',
        reason: support.reason,
        detail: support.detail
      });
      console.warn(`Skipping ${user.name} (${user.modelName}): ${support.detail}`);
    }
  }

  if (usable.length === 0) {
    const details = skippedAgents
      .map(agent => `${agent.userName} (${agent.model}): ${agent.detail}`)
      .join(' ');
    return {
      ok: false,
      status: 409,
      code: 'no_usable_models',
      error: `No AI personality can be called. ${details}`,
      skippedAgents
    };
  }

  // Restarting must not look like a silent no-op: say exactly why nobody can
  // speak instead of starting and finishing a discussion in the same tick.
  const withBudget = usable.filter(user => {
    const settings = normalizeDiscussionSettings(user);
    return messageCountFor(newsId, user.id) < settings.maxMessagesPerNews;
  });

  if (withBudget.length === 0) {
    return {
      ok: false,
      status: 409,
      code: 'message_limit_reached',
      error:
        'Every AI that can speak here already reached its "Max messages per news" limit on this news item. Raise that number under Users → Edit to continue the discussion.'
    };
  }

  const settings = currentSettings();
  const roster = sampleAiUsers(withBudget, settings.agentsPerNews);

  const discussion = {
    active: true,
    startedAt: new Date().toISOString(),
    stoppedReason: null,
    // The personalities that "see" this news item, frozen for this run.
    agentIds: roster.map(user => user.id),
    agentModels: roster.map(user => ({
      id: user.id,
      name: user.name,
      model: user.modelName
    })),
    skippedAgents,
    // Memory-only per-discussion state for the runner.
    cooldowns: new Map(),
    apologies: new Set(),
    failuresByUser: new Map()
  };
  storage.discussions.set(newsId, discussion);
  broadcast('discussion_status', {
    newsId,
    active: true,
    agents: discussion.agentModels
  });
  discussion.runner = runDiscussion(newsId, news).catch(error => {
    console.error(`Discussion runner failed for ${newsId}:`, error.message);
    finishDiscussion(newsId, 'error');
  });

  console.log(
    `Discussion started for ${newsId}: ${discussion.agentModels
      .map(agent => `${agent.name} (${agent.model})`)
      .join(', ')}`
  );

  return {
    ok: true,
    aiParticipants: roster.length,
    agentsPerNews: settings.agentsPerNews,
    agentIds: discussion.agentIds,
    agents: discussion.agentModels,
    skippedAgents
  };
}

// Stop AI discussion (a user action, or the end of an exhausted discussion).
function stopDiscussion(newsId) {
  if (typeof newsId !== 'string' || !newsId.trim()) return;
  const discussion = storage.discussions.get(newsId) || {};
  storage.discussions.set(newsId, {
    ...discussion,
    active: false,
    stoppedReason: 'stopped',
    stoppedAt: new Date().toISOString()
  });
  broadcast('discussion_status', { newsId, active: false, reason: 'stopped' });
}

// Add comment (user or AI). An empty model answer never becomes a comment.
// `extra` links the comment to its Meterless log entry and, for an error
// notice, carries the machine-readable failure the UI expands on demand.
async function addComment(newsId, userId, text, isAI = false, extra = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

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

  if (Number.isInteger(extra.logEntryId)) comment.logEntryId = extra.logEntryId;
  if (extra.isError) comment.isError = true;
  if (extra.error && typeof extra.error === 'object') {
    comment.error = {
      code: typeof extra.error.code === 'string' ? extra.error.code : 'error',
      message: typeof extra.error.message === 'string' ? extra.error.message : '',
      attempts: Number.isInteger(extra.error.attempts) ? extra.error.attempts : null
    };
  }

  storage.comments.push(comment);
  persist({ immediate: true });
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
// Legacy users saved before the discussion settings existed are answered with
// the defaults filled in, so the client never has to guess.
app.get('/api/users', (req, res) => {
  res.json(
    storage.users.map(user =>
      user.isAI === false ? user : { ...user, ...normalizeDiscussionSettings(user) }
    )
  );
});

// "Who am I?" — the archetype the model is told to be, e.g.
// "The Workaholic (The Career-driven Professional)".
function readRole(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

app.post('/api/users', (req, res) => {
  const { name, modelName, personality, isAI = true } = req.body;
  if (!name || !modelName || !personality) {
    return res.status(400).json({ error: 'Name, modelName, and personality required' });
  }

  const user = {
    id: randomUUID(),
    name,
    role: readRole(req.body.role),
    modelName,
    personality,
    isAI,
    ...normalizeDiscussionSettings(req.body),
    createdAt: new Date().toISOString()
  };

  storage.users.push(user);
  persist();
  res.json(user);
});

// Edit an existing personality, including its discussion settings.
app.put('/api/users/:id', (req, res) => {
  const user = storage.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  if (typeof body.name === 'string' && body.name.trim()) {
    user.name = body.name.trim().slice(0, 80);
  }
  if (typeof body.role === 'string') {
    user.role = readRole(body.role);
  }
  if (typeof body.modelName === 'string' && body.modelName.trim()) {
    user.modelName = body.modelName.trim().slice(0, 120);
  }
  if (typeof body.personality === 'string' && body.personality.trim()) {
    user.personality = body.personality.trim().slice(0, 4000);
  }
  if (typeof body.isAI === 'boolean') {
    user.isAI = body.isAI;
  }
  if (user.isAI !== false) {
    // Merge, so a partial settings update keeps every value it did not send.
    Object.assign(user, normalizeDiscussionSettings({ ...user, ...body }));
  }
  user.updatedAt = new Date().toISOString();

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

  // AI comments written before the reasoning filter existed are cleaned here too,
  // so a previously leaked <think> block is never shown again.
  const comments = storage.comments
    .filter(c => c.newsId === news.id)
    .map(comment =>
      comment.isAI && !comment.isError
        ? {
            ...comment,
            text:
              sanitizeModelText(comment.text).answer ||
              '[The model returned reasoning only; there was no answer.]'
          }
        : comment
    );
  const discussion = storage.discussions.get(news.id);

  res.json({
    ...news,
    comments,
    discussionActive: discussion?.active || false,
    discussionStoppedReason: discussion?.stoppedReason || null,
    // Which personalities "see" this news item right now.
    discussionAgents: discussion
      ? discussionAgents(discussion).map(user => ({
          id: user.id,
          name: user.name,
          model: user.modelName
        }))
      : [],
    discussionSkippedAgents: discussion?.skippedAgents || []
  });
});

// Comments
app.post('/api/comments', async (req, res) => {
  const { newsId, userId, text } = req.body;
  if (!newsId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'newsId and a non-empty text are required' });
  }
  const comment = await addComment(newsId, userId || storage.participantId, text, false);
  if (!comment) return res.status(400).json({ error: 'Invalid user' });
  res.json(comment);
});

// Discussion control
// Answers in milliseconds: the AI replies themselves are streamed over the
// WebSocket, so a slow (cold) model can never make this call look like a
// configuration error.
app.post('/api/discussion/start', async (req, res) => {
  const result = await startDiscussion(req.body?.newsId);

  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      code: result.code,
      skippedAgents: result.skippedAgents || []
    });
  }

  res.status(202).json({
    success: true,
    started: true,
    alreadyRunning: Boolean(result.alreadyRunning),
    aiParticipants: result.aiParticipants,
    agentsPerNews: result.agentsPerNews,
    agents: result.agents || [],
    skippedAgents: result.skippedAgents || [],
    message: result.alreadyRunning
      ? 'The discussion is already running.'
      : `Discussion started. ${result.aiParticipants} AI participant(s) will answer over the WebSocket.`
  });
});

app.post('/api/discussion/stop', (req, res) => {
  stopDiscussion(req.body?.newsId);
  res.json({ success: true });
});

// Meterless request log: the same ask → think → answer view as the console.
app.get('/api/meterless/log', (req, res) => {
  const newsId = typeof req.query.newsId === 'string' && req.query.newsId ? req.query.newsId : null;
  const limit = Number.parseInt(req.query.limit, 10);
  const entries = meterlessLog.list({
    newsId,
    limit: Number.isInteger(limit) ? limit : null
  });
  res.json({ entries, total: entries.length });
});

app.delete('/api/meterless/log', (req, res) => {
  const newsId = typeof req.query.newsId === 'string' && req.query.newsId ? req.query.newsId : null;
  meterlessLog.clear({ newsId });
  res.json({ success: true });
});

// Which agent, with which model, is processing how many requests right now.
// Diagnostics endpoint: `curl http://localhost:3001/api/activity`.
app.get('/api/activity', (req, res) => {
  res.json(activityPayload());
});

// Deployment-wide discussion settings: how many agents see one news item.
app.get('/api/settings', (req, res) => {
  res.json({ ...currentSettings(), limits: APP_SETTINGS_LIMITS });
});

app.put('/api/settings', (req, res) => {
  const next = normalizeAppSettings({ ...storage.settings, ...(req.body || {}) });
  storage.settings = next;
  persist();
  broadcast('settings_updated', next);
  res.json({ ...next, limits: APP_SETTINGS_LIMITS });
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
  meterlessLog.flush();
  clearInterval(wsHeartbeat);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => {
  stateStore.flush();
  meterlessLog.flush();
});
