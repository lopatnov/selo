const { test, expect } = require('@playwright/test');

/**
 * Feed + comments end-to-end.
 *
 * Everything the page talks to is mocked inside the browser: `/api/*` through
 * Playwright routes and the WebSocket through a stub installed before the app
 * boots. That makes the AI discussion deterministic and keeps the suite away
 * from a real Meterless runtime.
 */

const NEWS_ID = 'n1';

const NEWS = [
  {
    id: NEWS_ID,
    sourceId: 's1',
    sourceName: 'Test Wire',
    title: 'Agents take over the newsroom',
    content: 'A short article body used by the end-to-end suite.',
    link: 'https://example.com/article',
    pubDate: '2026-10-27T00:00:00.000Z',
    fetchedAt: '2026-10-27T00:00:00.000Z'
  }
];

const PARTICIPANT = {
  id: 'p1',
  name: 'Local User',
  modelName: 'human',
  personality: 'Human participant',
  isAI: false
};

const AI_ANSWER = 'An answer produced by the model.';

const AI_COMMENT = {
  id: 'c1',
  newsId: NEWS_ID,
  userId: 'a1',
  userName: 'Alice',
  text: AI_ANSWER,
  isAI: true,
  timestamp: '2026-10-27T00:00:05.000Z',
  logEntryId: 7
};

const LOG_ENTRY = {
  id: 7,
  at: '2026-10-27T00:00:05.000Z',
  newsId: NEWS_ID,
  userName: 'Alice',
  model: 'meterless/auto',
  durationMs: 1200,
  ask: 'PROMPT-SENT-TO-THE-MODEL',
  think: 'REASONING-BEFORE-THE-ANSWER',
  answer: AI_ANSWER,
  error: null
};

const ACTIVITY = {
  updatedAt: '2026-10-27T00:00:06.000Z',
  inFlight: 1,
  completed: 2,
  failed: 0,
  requests: [
    {
      id: 9,
      userName: 'Alice',
      userId: 'a1',
      model: 'meterless/auto',
      newsId: NEWS_ID,
      startedAt: new Date().toISOString(),
      elapsedMs: 400
    }
  ],
  agents: [
    { userName: 'Alice', model: 'meterless/auto', inFlight: 1, completed: 2, failed: 0 }
  ],
  settings: { agentsPerNews: 2 },
  activeDiscussions: 1
};

/**
 * A WebSocket stub the test can drive from the outside.
 *
 * Only the app's own socket (port 3001) is stubbed: the CRA dev server opens
 * its own HMR socket on the page origin, and that one must keep using the real
 * implementation so hot reload keeps working.
 */
async function installSocketStub(page) {
  await page.addInitScript(() => {
    const RealWebSocket = window.WebSocket;
    const sockets = [];

    function isAppSocket(url) {
      return String(url || '').includes(':3001');
    }

    class StubWebSocket {
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          const openNow = sockets.filter(socket => socket.readyState === 1).length;
          window.__maxOpenSockets = Math.max(window.__maxOpenSockets || 0, openNow);
          if (this.onopen) this.onopen({});
        }, 0);
      }

      send() {}

      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1000, reason: 'test' });
      }

      emit(type, data) {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ type, data }) });
      }
    }

    function WebSocketWrapper(url, protocols) {
      if (isAppSocket(url)) return new StubWebSocket(url);
      return new RealWebSocket(url, protocols);
    }
    WebSocketWrapper.CONNECTING = 0;
    WebSocketWrapper.OPEN = 1;
    WebSocketWrapper.CLOSING = 2;
    WebSocketWrapper.CLOSED = 3;
    WebSocketWrapper.prototype = RealWebSocket.prototype;

    window.__sockets = sockets;
    window.WebSocket = WebSocketWrapper;
  });
}

async function mockApi(page, { postedComments = [], settingsPuts = [] } = {}) {
  let settingsValue = 1;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const json = body => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body)
    });

    if (path === '/participant' && method === 'GET') return json(PARTICIPANT);
    if (path === '/users' && method === 'GET') return json([]);
    if (path === '/news' && method === 'GET') return json(NEWS);
    if (path === `/news/${NEWS_ID}` && method === 'GET') {
      return json({
        ...NEWS[0],
        comments: [AI_COMMENT, ...postedComments],
        discussionActive: false,
        discussionStoppedReason: null,
        discussionAgents: [{ id: 'a1', name: 'Alice', model: 'meterless/auto' }],
        discussionSkippedAgents: []
      });
    }
    if (path === '/meterless/log' && method === 'GET') {
      return json({ entries: [LOG_ENTRY], total: 1 });
    }
    if (path === '/activity' && method === 'GET') return json(ACTIVITY);
    if (path === '/settings' && method === 'GET') {
      return json({ agentsPerNews: settingsValue, limits: { agentsPerNews: { min: 1, max: 5 } } });
    }
    if (path === '/settings' && method === 'PUT') {
      const body = request.postDataJSON();
      settingsPuts.push(body);
      settingsValue = Number(body.agentsPerNews) || settingsValue;
      return json({ agentsPerNews: settingsValue, limits: { agentsPerNews: { min: 1, max: 5 } } });
    }
    if (path === '/comments' && method === 'POST') {
      const body = request.postDataJSON();
      return json({
        id: 'human-1',
        newsId: body.newsId,
        userId: body.userId,
        userName: PARTICIPANT.name,
        text: body.text,
        isAI: false,
        timestamp: '2026-10-27T00:00:09.000Z'
      });
    }
    if (path === '/discussion/start' && method === 'POST') {
      return json({
        success: true,
        started: true,
        aiParticipants: 1,
        agentsPerNews: 1,
        agents: [{ id: 'a1', name: 'Alice', model: 'meterless/auto' }],
        skippedAgents: [],
        message: 'Discussion started.'
      });
    }
    if (path === '/discussion/stop' && method === 'POST') return json({ success: true });

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `unmocked ${method} ${path}` })
    });
  });
}

async function openExpandedNews(page) {
  await page.goto('/feed');
  await expect(page.getByRole('heading', { name: 'Agents take over the newsroom' })).toBeVisible();
  await page.locator('.news-header').first().click();
  await expect(page.locator('.discussion-panel')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await installSocketStub(page);
});

test('the answer is the message and ask / thinking open on demand', async ({ page }) => {
  await mockApi(page);
  await openExpandedNews(page);

  // The posted answer is the comment body itself.
  await expect(page.locator('.comment-text').first()).toHaveText(AI_ANSWER);

  // Nothing is fetched or shown until the corner toggle is used.
  const ask = page.getByRole('button', { name: '🧾 Ask' }).first();
  const thinking = page.getByRole('button', { name: '💭 Thinking' }).first();
  await expect(ask).toBeVisible();
  await expect(thinking).toBeVisible();
  await expect(page.getByText('PROMPT-SENT-TO-THE-MODEL')).toHaveCount(0);

  await ask.click();
  await expect(page.getByText('PROMPT-SENT-TO-THE-MODEL')).toBeVisible();

  await thinking.click();
  await expect(page.getByText('REASONING-BEFORE-THE-ANSWER')).toBeVisible();
  // The answer stays on screen next to the opened reasoning.
  await expect(page.locator('.comment-text').first()).toHaveText(AI_ANSWER);
});

test('a posted comment appears in the thread immediately', async ({ page }) => {
  const posted = [];
  await mockApi(page, { postedComments: posted });
  await openExpandedNews(page);

  const box = page.locator('.add-comment-form textarea');
  await expect(box).toBeEnabled();
  await box.fill('My own take on this story.');
  await page.getByRole('button', { name: 'Send' }).click();

  // No WebSocket message is involved here: the UI must trust the POST answer.
  await expect(page.locator('.comment-text')).toContainText(['My own take on this story.']);
  await expect(box).toHaveValue('');
});

test('a live new_comment from the socket is appended to the thread', async ({ page }) => {
  await mockApi(page);
  await openExpandedNews(page);

  await page.evaluate(
    ({ newsId }) => {
      const socket = window.__sockets[0];
      socket.emit('new_comment', {
        id: 'c2',
        newsId,
        userId: 'a2',
        userName: 'John',
        text: 'A live reaction over the socket.',
        isAI: true,
        timestamp: new Date().toISOString()
      });
    },
    { newsId: NEWS_ID }
  );

  await expect(page.getByText('A live reaction over the socket.')).toBeVisible();
});

const openSockets = page => page.evaluate(
  () => window.__sockets.filter(socket => socket.readyState === 1).length
);

test('an open page never holds more than one WebSocket connection', async ({ page }) => {
  await mockApi(page);
  await openExpandedNews(page);
  await expect.poll(() => openSockets(page)).toBe(1);

  // Leaving the feed must release the socket instead of leaving a zombie that
  // keeps reconnecting in the background.
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByText('No users yet')).toBeVisible();
  await expect.poll(() => openSockets(page)).toBe(0);

  // Coming back opens exactly one connection again.
  await page.getByRole('link', { name: 'News Feed' }).click();
  await expect(page.getByRole('heading', { name: 'Agents take over the newsroom' })).toBeVisible();
  await expect.poll(() => openSockets(page)).toBe(1);

  const maxOpen = await page.evaluate(() => window.__maxOpenSockets || 0);
  expect(maxOpen).toBe(1);
});

test('the Users page stores how many agents see one news item', async ({ page }) => {
  const settingsPuts = [];
  await mockApi(page, { settingsPuts });
  await page.goto('/users');

  const settings = page.getByTestId('agent-settings');
  await expect(settings).toBeVisible();
  const select = settings.locator('#agents-per-news');
  await expect(select).toHaveValue('1');

  await select.selectOption('3');
  await expect.poll(() => settingsPuts.length).toBe(1);
  expect(settingsPuts[0]).toEqual({ agentsPerNews: 3 });
  await expect(select).toHaveValue('3');
});

test('the discussion badge follows the live status', async ({ page }) => {
  await mockApi(page);
  await openExpandedNews(page);

  await page.evaluate(
    ({ newsId }) => {
      const socket = window.__sockets[0];
      socket.emit('discussion_status', {
        newsId,
        active: true,
        agents: [{ id: 'a1', name: 'Alice', model: 'meterless/auto' }]
      });
    },
    { newsId: NEWS_ID }
  );

  await expect(page.getByText('🟢 Discussion Active')).toBeVisible();
  await expect(page.getByText(/Alice · meterless\/auto/)).toBeVisible();
});
