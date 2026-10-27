const { test, expect } = require('@playwright/test');

const DEFAULT_MODELS = ['auto', 'fast', 'deep', 'cheap', 'local', 'fusion'].map(
  mode => `meterless/${mode}`
);

const RUNTIME_BASE_URL = 'http://127.0.0.1:8088/v1';

function makeConfig(overrides = {}) {
  return {
    id: 'meterless',
    name: 'Meterless Runtime',
    kind: 'openai-compatible',
    baseUrl: RUNTIME_BASE_URL,
    baseUrlSource: 'settings',
    defaultBaseUrl: RUNTIME_BASE_URL,
    appId: 'ai-news-discussion',
    hasToken: true,
    tokenSource: 'settings',
    tokenEnvVar: null,
    chatTimeoutMs: 180000,
    status: {
      status: 'online',
      baseUrl: RUNTIME_BASE_URL,
      httpStatus: 200,
      latencyMs: 12,
      checkedAt: new Date().toISOString(),
      modelCount: 4
    },
    ...overrides
  };
}

function makeModels(overrides = {}) {
  return {
    status: 'online',
    httpStatus: 200,
    latencyMs: 9,
    checkedAt: new Date().toISOString(),
    models: [
      'meterless/auto',
      'meterless/deep',
      'gpt-4o',
      'local-runtime/llama-3.1-8b-instruct'
    ],
    routingModes: ['meterless/auto', 'meterless/deep'],
    otherModels: ['gpt-4o', 'local-runtime/llama-3.1-8b-instruct'],
    total: 4,
    source: 'runtime',
    ...overrides
  };
}

function offlineConfig() {
  return makeConfig({
    baseUrlSource: 'default',
    hasToken: false,
    tokenSource: 'none',
    status: {
      status: 'offline',
      httpStatus: null,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      reason: 'Could not reach /v1/models.'
    }
  });
}

function offlineModels() {
  return makeModels({
    status: 'offline',
    httpStatus: null,
    source: 'defaults',
    models: DEFAULT_MODELS,
    routingModes: DEFAULT_MODELS,
    otherModels: [],
    total: DEFAULT_MODELS.length,
    reason: 'Could not reach /v1/models.'
  });
}

function makeClasses(overrides = {}) {
  return {
    status: 'online',
    httpStatus: 200,
    source: 'runtime',
    checkedAt: new Date().toISOString(),
    classes: [
      {
        id: 'meterless/text',
        state: 'ready',
        label: 'ready',
        why: '',
        chatCarrier: true,
        routes: ['POST /v1/chat/completions']
      },
      {
        id: 'meterless/image',
        state: 'unavailable',
        label: 'unavailable',
        why: 'no GPU lane seated',
        chatCarrier: false,
        routes: ['POST /v1/jobs']
      },
      {
        id: 'meterless/judge',
        state: 'starting',
        label: 'may take a moment',
        why: '',
        chatCarrier: true,
        routes: []
      }
    ],
    ...overrides
  };
}

function zetarisPayload() {
  return {
    restUrl: 'http://127.0.0.1:8888',
    orgId: '1',
    hasKey: true,
    status: {
      status: 'online',
      latencyMs: 5,
      reason: ''
    }
  };
}

function normalizeBaseUrl(value) {
  const withScheme = value.includes('://') ? value : `http://${value}`;
  return `${new URL(withScheme).origin}/v1`;
}

/**
 * Mock the three API areas the page touches. The React client is real; only
 * the JSON responses are replaced, so the suite never writes provider
 * settings or talks to a runtime.
 */
async function installProviderMocks(page, options = {}) {
  const state = {
    config: options.config || makeConfig(),
    models: options.models || makeModels(),
    classes: options.classes || makeClasses(),
    detect: options.detect || {
      found: true,
      baseUrl: 'http://192.168.1.20:8088/v1',
      status: 'online',
      httpStatus: 200,
      tried: 1,
      candidates: [{ baseUrl: 'http://192.168.1.20:8088/v1', status: 'online' }]
    },
    connectLink: null,
    requests: []
  };

  await page.route('**/api/providers/**', async route => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/providers/, '');

    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }

    state.requests.push({ method, path, body });

    if (method === 'GET' && path === '/meterless') {
      return route.fulfill({ json: state.config });
    }

    if (method === 'GET' && path === '/meterless/models') {
      return route.fulfill({ json: state.models });
    }

    if (method === 'GET' && path === '/meterless/classes') {
      return route.fulfill({ json: state.classes });
    }

    if (method === 'POST' && path === '/meterless/detect') {
      const baseUrl = normalizeBaseUrl(state.detect.baseUrl);
      state.config = {
        ...state.config,
        baseUrl,
        baseUrlSource: 'settings',
        status: {
          ...state.config.status,
          status: state.detect.status,
          baseUrl,
          httpStatus: state.detect.httpStatus
        }
      };
      return route.fulfill({
        json: {
          ...state.detect,
          baseUrl,
          detectionStatus: state.detect.status,
          config: state.config,
          status: state.config.status
        }
      });
    }

    if (method === 'POST' && path === '/meterless/connect') {
      const link = body && typeof body.link === 'string' ? body.link : '';
      state.connectLink = link;
      const baseUrl = normalizeBaseUrl(link);
      state.config = {
        ...state.config,
        baseUrl,
        baseUrlSource: 'settings',
        hasToken: true,
        tokenSource: 'settings',
        status: {
          ...state.config.status,
          status: 'online',
          baseUrl,
          httpStatus: 200,
          reason: undefined
        }
      };
      return route.fulfill({ json: state.config });
    }

    if (method === 'PUT' && path === '/meterless/config') {
      const next = { ...state.config };
      if (body && body.baseUrl) {
        next.baseUrl = normalizeBaseUrl(body.baseUrl);
        next.baseUrlSource = 'settings';
      }
      if (body && body.token) {
        next.hasToken = true;
        next.tokenSource = 'settings';
      }
      next.status = {
        ...next.status,
        status: 'online',
        baseUrl: next.baseUrl,
        httpStatus: 200
      };
      state.config = next;
      return route.fulfill({ json: next });
    }

    if (method === 'POST' && path === '/meterless/chat') {
      return route.fulfill({
        json: {
          model: (body && body.model) || 'meterless/auto',
          content: 'Hello from the mocked runtime',
          contentType: 'string'
        }
      });
    }

    return route.fulfill({
      status: 404,
      json: { error: `Unmocked provider route: ${method} ${path}` }
    });
  });

  await page.route('**/api/zetaris', route => route.fulfill({ json: zetarisPayload() }));

  return state;
}

test('explains the Connect link and stores it without echoing the secret', async ({ page }) => {
  const state = await installProviderMocks(page, {
    config: offlineConfig(),
    models: offlineModels()
  });

  await page.goto('/providers');

  const connectCard = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Connect link' })
  });
  await expect(connectCard).toBeVisible();
  await expect(connectCard.getByText(/Settings → Connect/)).toBeVisible();
  await expect(connectCard.getByText(/never returned by the API/)).toBeVisible();

  const link = 'http://192.168.1.20:8088/connect#k=super-secret-key';
  await page.getByLabel('Connect link').fill(link);
  await page.getByRole('button', { name: 'Connect' }).click();

  await expect(page.getByTestId('provider-notice')).toContainText('Connect link applied');
  await expect(page.getByTestId('provider-notice')).toContainText('online');
  await expect(page.getByLabel('Connect link')).toHaveValue('');
  await expect(page.getByTestId('base-url-source')).toHaveText(/saved in this app/);
  await expect(page.getByTestId('token-source')).toHaveText(/saved in this app/);
  await expect(page.locator('body')).not.toContainText('super-secret-key');

  expect(state.connectLink).toBe(link);
  expect(
    state.requests.some(entry => entry.method === 'POST' && entry.path === '/meterless/connect')
  ).toBe(true);
});

test('Auto Detect saves the discovered runtime and reports the detection result', async ({
  page
}) => {
  const state = await installProviderMocks(page, {
    config: offlineConfig(),
    models: offlineModels()
  });

  await page.goto('/providers');
  await page.getByRole('button', { name: 'Auto Detect' }).click();

  await expect(page.getByTestId('provider-notice')).toContainText(
    'Found a runtime at http://192.168.1.20:8088/v1 (online)'
  );
  await expect(page.locator('#meterless-base-url')).toHaveValue(
    'http://192.168.1.20:8088/v1'
  );

  expect(
    state.requests.some(entry => entry.method === 'POST' && entry.path === '/meterless/detect')
  ).toBe(true);
});

test('Re-check status re-reads GET /v1/models and can show a changed status', async ({ page }) => {
  const state = await installProviderMocks(page);

  await page.goto('/providers');
  await expect(page.getByTestId('meterless-status')).toHaveText('Online');
  await expect(page.getByTestId('models-count')).toHaveText('4');

  // The next poll sees an unreachable runtime.
  state.config = offlineConfig();
  state.models = offlineModels();
  const requestsBefore = state.requests.length;

  await page.getByRole('button', { name: 'Re-check status' }).first().click();

  await expect(page.getByTestId('meterless-status')).toHaveText('Offline');
  await expect(page.getByTestId('models-fallback')).toContainText('built-in routing modes');
  expect(state.requests.length).toBeGreaterThanOrEqual(requestsBefore + 2);
});

test('shows every id returned by the runtime and proves the answer source', async ({ page }) => {
  await installProviderMocks(page, { models: makeModels() });

  await page.goto('/providers');

  await expect(page.getByTestId('models-source')).toHaveText('runtime GET /v1/models');
  await expect(page.getByTestId('models-status')).toContainText('online');
  await expect(page.getByTestId('models-count')).toHaveText('4');
  await expect(page.getByTestId('models-list')).toContainText('meterless/auto');
  await expect(page.getByTestId('models-list')).toContainText('meterless/deep');
  await expect(page.getByTestId('models-list')).toContainText('gpt-4o');
  await expect(page.getByTestId('models-list')).toContainText(
    'local-runtime/llama-3.1-8b-instruct'
  );
  await expect(page.getByTestId('models-fallback')).toHaveCount(0);
});

test('labels the built-in fallback honestly when the runtime does not answer', async ({
  page
}) => {
  await installProviderMocks(page, {
    config: offlineConfig(),
    models: offlineModels()
  });

  await page.goto('/providers');

  await expect(page.getByTestId('models-source')).toHaveText('built-in fallback');
  await expect(page.getByTestId('models-status')).toContainText('offline');
  await expect(page.getByTestId('models-count')).toHaveText(String(DEFAULT_MODELS.length));
  await expect(page.getByTestId('models-fallback')).toContainText(
    'not an answer from the runtime'
  );
});

test('Save sends the base URL and token and never renders the token back', async ({ page }) => {
  const state = await installProviderMocks(page, {
    config: makeConfig({ hasToken: false, tokenSource: 'none' })
  });

  await page.goto('/providers');

  await page.locator('#meterless-base-url').fill('localhost:8787/v1/models');
  await page.locator('#meterless-token').fill('rt-test-token');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('provider-notice')).toContainText('Saved on the server');
  await expect(page.locator('#meterless-token')).toHaveValue('');
  await expect(page.getByTestId('base-url-source')).toHaveText(/saved in this app/);
  await expect(page.getByTestId('token-source')).toHaveText(/saved in this app/);
  await expect(page.locator('body')).not.toContainText('rt-test-token');

  const putRequest = state.requests.find(
    entry => entry.method === 'PUT' && entry.path === '/meterless/config'
  );
  expect(putRequest).toBeTruthy();
  expect(putRequest.body).toEqual({
    baseUrl: 'localhost:8787/v1/models',
    token: 'rt-test-token'
  });
});

test('shows live class state with unavailable classes dimmed', async ({ page }) => {
  await installProviderMocks(page, { classes: makeClasses() });

  await page.goto('/providers');

  const list = page.getByTestId('classes-list');
  await expect(list).toContainText('meterless/text');
  await expect(list).toContainText('ready');
  await expect(list).toContainText('meterless/image');
  await expect(list).toContainText('unavailable');
  await expect(list).toContainText('may take a moment');
});
