'use strict';

const { normalizeBaseUrl } = require('./base-url');
const {
  CHAT_TIMEOUT_MS,
  ProviderError,
  createMeterlessRuntime
} = require('./meterless-runtime');

/**
 * The app's existing hosted Meterless endpoint. It stays available for plain
 * model ids (`gpt-4`, `llama-3-70b`, ...) while `meterless/<routing-mode>` ids
 * go to the local Meterless Runtime provider.
 */
function createMeterlessCloud() {
  const id = 'meterless-cloud';
  const name = 'Meterless Cloud (legacy)';

  function baseUrl() {
    return normalizeBaseUrl(process.env.METERLESS_API_URL || 'https://api.meterless.ai/v1');
  }

  function apiKey() {
    return process.env.METERLESS_API_KEY || '';
  }

  function getConfig() {
    return {
      id,
      name,
      kind: 'openai-compatible',
      baseUrl: baseUrl(),
      envManaged: true,
      hasToken: Boolean(apiKey()),
      tokenSource: apiKey() ? 'env' : 'none',
      chatTimeoutMs: CHAT_TIMEOUT_MS
    };
  }

  async function chat({ model, messages = [], ...options } = {}) {
    const key = apiKey();
    if (!key) {
      throw new ProviderError(
        'unauthorized',
        'METERLESS_API_KEY is not configured for the hosted Meterless endpoint.'
      );
    }

    let response;
    try {
      response = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({ ...options, model, messages }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderError(
        'offline',
        timedOut ? 'Meterless Cloud did not answer within 180 s.' : 'Could not reach Meterless Cloud.',
        { cause: error }
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('unauthorized', 'Meterless Cloud rejected METERLESS_API_KEY.', {
        status: response.status
      });
    }
    if (!response.ok) {
      throw new ProviderError('offline', `Meterless Cloud returned HTTP ${response.status}.`, {
        status: response.status
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new ProviderError('invalid_response', 'Meterless Cloud returned invalid JSON.', {
        cause: error
      });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('invalid_response', 'Meterless Cloud returned no text content.');
    }
    return content;
  }

  return {
    id,
    name,
    kind: 'openai-compatible',
    descriptor: getConfig,
    getConfig,
    chat
  };
}

const meterlessRuntime = createMeterlessRuntime();
const meterlessCloud = createMeterlessCloud();
const providers = [meterlessRuntime, meterlessCloud];

function getProvider(id) {
  return providers.find(provider => provider.id === id) || null;
}

module.exports = {
  getProvider,
  meterlessCloud,
  meterlessRuntime,
  providers
};
