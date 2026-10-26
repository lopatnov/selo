import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';

import API_BASE from '../api';

const STATUS_LABELS = {
  online: 'Online',
  unauthorized: 'Unauthorized',
  offline: 'Offline',
  unconfigured: 'Not configured',
  checking: 'Checking…'
};

const DEFAULT_MODELS = ['auto', 'fast', 'deep', 'cheap', 'local', 'fusion'].map(
  disposition => `meterless/${disposition}`
);

const TOKEN_SOURCE_LABELS = {
  env: 'environment',
  settings: 'saved in this app',
  'proxy-token': 'runtime proxy-token file',
  none: 'missing'
};

const BASE_URL_SOURCE_LABELS = {
  env: 'environment',
  settings: 'saved in this app',
  default: 'built-in default'
};

function readError(error) {
  return error.response?.data?.error || error.message || 'Request failed';
}

function StatusBadge({ status, testId }) {
  const kind = STATUS_LABELS[status] ? status : 'offline';
  return (
    <span
      className={`provider-status status-${kind === 'unconfigured' ? 'offline' : kind}`}
      data-testid={testId}
    >
      <span className="provider-dot" />
      {STATUS_LABELS[kind] || kind}
    </span>
  );
}

function ProviderSettings() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState({ status: 'checking' });
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [routingModes, setRoutingModes] = useState(DEFAULT_MODELS);
  const [otherModels, setOtherModels] = useState([]);
  const [modelsMeta, setModelsMeta] = useState({
    source: 'defaults',
    status: 'checking',
    httpStatus: null,
    total: DEFAULT_MODELS.length,
    checkedAt: null,
    reason: ''
  });
  const [loading, setLoading] = useState(true);

  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8088/v1');
  const [token, setToken] = useState('');
  const [connectLink, setConnectLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [testModel, setTestModel] = useState('meterless/auto');
  const [testPrompt, setTestPrompt] = useState('Say hello in one short sentence.');
  const [testResult, setTestResult] = useState('');
  const [testError, setTestError] = useState('');

  const [zetaris, setZetaris] = useState(null);
  const [zetarisBusy, setZetarisBusy] = useState('');
  const [zetarisSql, setZetarisSql] = useState('SELECT 1 AS one');
  const [zetarisResult, setZetarisResult] = useState(null);
  const [zetarisError, setZetarisError] = useState('');

  const applyConfig = useCallback(data => {
    setConfig(data);
    if (data?.baseUrl) setBaseUrl(data.baseUrl);
    if (data?.status) setStatus(data.status);
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/providers/meterless/models`);
      const runtimeModels = Array.isArray(data.models) ? data.models : [];
      const list = runtimeModels.length > 0 ? runtimeModels : DEFAULT_MODELS;
      const routing = Array.isArray(data.routingModes)
        ? data.routingModes
        : list.filter(model => model.startsWith('meterless/'));
      const others = Array.isArray(data.otherModels)
        ? data.otherModels
        : list.filter(model => !model.startsWith('meterless/'));

      setModels(list);
      setRoutingModes(routing);
      setOtherModels(others);
      setModelsMeta({
        source: data.source || 'runtime',
        status: data.status || 'unknown',
        httpStatus: data.httpStatus ?? null,
        total: Number.isInteger(data.total) ? data.total : list.length,
        checkedAt: data.checkedAt || null,
        reason: data.reason || ''
      });
      setTestModel(current => (list.includes(current) ? current : list[0]));
    } catch (err) {
      setModels(DEFAULT_MODELS);
      setRoutingModes(DEFAULT_MODELS);
      setOtherModels([]);
      setModelsMeta({
        source: 'defaults',
        status: 'offline',
        httpStatus: null,
        total: DEFAULT_MODELS.length,
        checkedAt: null,
        reason: readError(err)
      });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.get(`${API_BASE}/providers/meterless`);
      applyConfig(data);
      await fetchModels();
    } catch (err) {
      setError(readError(err));
    } finally {
      setLoading(false);
    }
  }, [applyConfig, fetchModels]);

  const loadZetaris = useCallback(async () => {
    setZetarisBusy('status');
    setZetarisError('');
    try {
      const { data } = await axios.get(`${API_BASE}/zetaris`);
      setZetaris(data);
    } catch (err) {
      setZetarisError(readError(err));
    } finally {
      setZetarisBusy('');
    }
  }, []);

  useEffect(() => {
    load();
    loadZetaris();
  }, [load, loadZetaris]);

  const handleSave = async event => {
    event.preventDefault();
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const payload = { baseUrl };
      if (token.trim()) payload.token = token.trim();
      const { data } = await axios.put(`${API_BASE}/providers/meterless/config`, payload);
      applyConfig(data);
      setToken('');
      setNotice(
        `Saved on the server. Status re-checked with GET /v1/models: ${
          data.status?.status || 'unknown'
        }.`
      );
      await fetchModels();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleDetect = async () => {
    setBusy('detect');
    setError('');
    setNotice('');
    try {
      const { data } = await axios.post(`${API_BASE}/providers/meterless/detect`);
      if (data.found) {
        const detectedStatus =
          data.detectionStatus ||
          (typeof data.status === 'string' ? data.status : data.status?.status) ||
          'unknown';
        setNotice(`Found a runtime at ${data.baseUrl} (${detectedStatus}). The base URL was saved.`);
        setBaseUrl(data.config?.baseUrl || data.baseUrl);
        await load();
      } else {
        setError(
          `No runtime answered on the usual ports (tried ${data.tried ?? 0} candidates). ` +
            'Start Meterless Runtime and try again, or paste its Connect link.'
        );
      }
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleConnect = async event => {
    event.preventDefault();
    if (!connectLink.trim()) return;
    setBusy('connect');
    setError('');
    setNotice('');
    try {
      const { data } = await axios.post(`${API_BASE}/providers/meterless/connect`, {
        link: connectLink.trim()
      });
      // The link contains a secret in its fragment; drop it from the field.
      setConnectLink('');
      setNotice(
        `Connect link applied. Base URL and key were saved on the server; status: ${
          data.status?.status || 'unknown'
        }. The key is never returned by the API or shown again.`
      );
      await load();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleTest = async event => {
    event.preventDefault();
    setBusy('test');
    setTestError('');
    setTestResult('');
    try {
      const { data } = await axios.post(`${API_BASE}/providers/meterless/chat`, {
        model: testModel,
        messages: [{ role: 'user', content: testPrompt }]
      });
      if (typeof data.content === 'string') {
        setTestResult(data.content);
      } else {
        setTestError('The provider did not return a plain string.');
      }
    } catch (err) {
      setTestError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleZetarisQuery = async event => {
    event.preventDefault();
    setZetarisBusy('query');
    setZetarisError('');
    setZetarisResult(null);
    try {
      const { data } = await axios.post(`${API_BASE}/zetaris/query`, {
        sql: zetarisSql,
        limit: 25
      });
      setZetarisResult(data);
    } catch (err) {
      setZetarisError(readError(err));
    } finally {
      setZetarisBusy('');
    }
  };

  const statusKind = status?.status || 'checking';
  const unauthorized = statusKind === 'unauthorized';
  const tokenSource = config?.tokenSource || 'none';
  const zetarisStatus = zetaris?.status?.status || 'checking';
  const zetarisAuth =
    zetaris == null
      ? '…'
      : zetaris.hasKey
        ? 'API key (ZETARIS_API_KEY)'
        : zetaris.hasPassword
          ? 'login (ZETARIS_USERNAME + ZETARIS_PASSWORD)'
          : 'not configured';

  return (
    <div>
      <div className="card-header" style={{ paddingBottom: 0 }}>
        <h2 className="card-title">🔌 AI Providers</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <StatusBadge status={statusKind} testId="meterless-status" />
          <StatusBadge status={zetarisStatus} testId="zetaris-status" />
        </div>
      </div>

      {loading && <div className="card">Checking Meterless Runtime…</div>}

      {error && (
        <div className="provider-alert error" data-testid="provider-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="provider-alert success" data-testid="provider-notice">
          {notice}
        </div>
      )}

      {unauthorized && (
        <div className="provider-alert warning">
          The runtime rejected the token. Paste the token written to{' '}
          <code>{'<stateDir>/proxy-token'}</code>, or set{' '}
          <code>METERLESS_API_KEY</code> / <code>METERLESS_RUNTIME_TOKEN</code> in{' '}
          <code>.env</code>. The placeholder <code>rt-local</code> is rejected.
        </div>
      )}

      <div className="card">
        <h3 className="provider-section-title">Meterless Runtime</h3>
        <p className="provider-note">
          Provider <code>meterless</code> · OpenAI-compatible · status is decided by{' '}
          <code>GET /v1/models</code>, never by <code>/healthz</code>. A wrong token shows
          Unauthorized instead of Offline.
        </p>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="meterless-base-url">Base URL</label>
            <input
              id="meterless-base-url"
              type="text"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:8088/v1"
              spellCheck="false"
            />
            <small className="provider-hint">
              You can paste a host, <code>/v1</code>, <code>/v1/models</code>,{' '}
              <code>/v1/chat/completions</code> or <code>/healthz</code>. It is normalised to{' '}
              <code>{'<host>/v1'}</code>.
            </small>
          </div>

          <div className="form-group">
            <label htmlFor="meterless-token">Runtime token</label>
            <input
              id="meterless-token"
              type="password"
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder={
                config?.hasToken
                  ? 'Token already stored — paste a new one to replace it'
                  : 'Paste the token from <stateDir>/proxy-token'
              }
              autoComplete="off"
              spellCheck="false"
            />
            <small className="provider-hint">
              Precedence: a token saved here, then the environment, then the runtime{' '}
              <code>proxy-token</code> file. It is never returned by the API. A saved token is
              written to the server's provider settings file next to <code>state.json</code>{' '}
              (or <code>SELO_SETTINGS_FILE</code>), not to browser storage.
              {config?.tokenSource === 'env' && (
                <>
                  {' '}Currently taken from <code>{config.tokenEnvVar || 'METERLESS_API_KEY'}</code> in{' '}
                  <code>.env</code>.
                </>
              )}
              {config?.tokenSource === 'proxy-token' && ' Currently using proxy-token from the runtime state directory.'}
            </small>
          </div>

          <div className="provider-actions">
            <button type="submit" className="btn btn-primary" disabled={busy === 'save'}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDetect}
              disabled={busy === 'detect'}
              title="Probe 8088, 8090, 8787 and 11434 on 127.0.0.1, localhost and [::1]; save the first runtime that answers."
            >
              {busy === 'detect' ? 'Detecting…' : 'Auto Detect'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={load}
              disabled={loading}
              title="Re-read the saved config and call GET /v1/models again. Settings are not changed."
            >
              {loading ? 'Checking…' : 'Re-check status'}
            </button>
          </div>
          <small className="provider-hint">
            <strong>Auto Detect</strong> probes the usual runtime ports and saves the first
            online or unauthorized answer. <strong>Re-check status</strong> only re-reads the
            saved configuration and calls <code>GET /v1/models</code>; it never changes
            settings.
          </small>
        </form>

        <dl className="provider-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={statusKind} testId="meterless-status-fact" />
              {status?.httpStatus ? ` · HTTP ${status.httpStatus}` : ''}
              {status?.reason ? ` · ${status.reason}` : ''}
            </dd>
          </div>
          <div>
            <dt>Base URL source</dt>
            <dd data-testid="base-url-source">
              {BASE_URL_SOURCE_LABELS[config?.baseUrlSource] ||
                config?.baseUrlSource ||
                (config ? 'not reported by this server' : 'checking')}
            </dd>
          </div>
          <div>
            <dt>Token source</dt>
            <dd data-testid="token-source">{TOKEN_SOURCE_LABELS[tokenSource] || tokenSource}</dd>
          </div>
          <div>
            <dt>App id</dt>
            <dd><code>{config?.appId || 'ai-news-discussion'}</code></dd>
          </div>
          <div>
            <dt>Timeout</dt>
            <dd>180 s per chat request</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <h3 className="provider-section-title">Connect link</h3>
        <p className="provider-note">
          A connect link is the one-time link Meterless Runtime shows under{' '}
          <strong>Settings → Connect</strong>. It looks like{' '}
          <code>{'http://<host>:<port>/connect#k=<key>'}</code>. The link origin becomes the
          Base URL and the <code>k</code> value becomes the runtime token. Both are saved in the
          server's provider settings file; the token is never returned by the API, never
          shown again, and the link is never logged. Nothing is stored in the browser.
        </p>
        <p className="provider-note">
          If this app runs in Docker, do not use <code>127.0.0.1</code> in the link — that is the
          container itself. Use an address the container can reach, such as{' '}
          <code>host.docker.internal</code> or the runtime host's LAN address. The link
          carries the key, so use HTTPS whenever the app is not on localhost.
        </p>
        <form onSubmit={handleConnect} className="provider-inline-form">
          <input
            type="text"
            value={connectLink}
            onChange={event => setConnectLink(event.target.value)}
            placeholder="http://192.168.1.20:8088/connect#k=…"
            aria-label="Connect link"
            autoComplete="off"
            spellCheck="false"
          />
          <button type="submit" className="btn btn-primary" disabled={busy === 'connect'}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-header" style={{ paddingBottom: '0.5rem' }}>
          <h3 className="provider-section-title">Models / routing modes</h3>
          <button type="button" className="btn btn-secondary" onClick={fetchModels}>
            Refresh
          </button>
        </div>
        <p className="provider-note">
          The server asked the runtime for <code>GET /v1/models</code> and keeps every id it
          returned. Routing modes (<code>meterless/*</code>) are served by the local runtime; any
          other id is still a runtime id, but this app's AI personalities send
          non-<code>meterless/*</code> ids to the hosted endpoint.
        </p>

        <dl className="provider-facts">
          <div>
            <dt>Answer source</dt>
            <dd data-testid="models-source">
              {modelsMeta.source === 'runtime' ? 'runtime GET /v1/models' : 'built-in fallback'}
            </dd>
          </div>
          <div>
            <dt>Runtime status</dt>
            <dd data-testid="models-status">
              {modelsMeta.status}
              {modelsMeta.httpStatus ? ` · HTTP ${modelsMeta.httpStatus}` : ''}
            </dd>
          </div>
          <div>
            <dt>Ids returned</dt>
            <dd data-testid="models-count">{modelsMeta.total}</dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd>
              {modelsMeta.checkedAt ? new Date(modelsMeta.checkedAt).toLocaleString() : 'not yet'}
            </dd>
          </div>
        </dl>

        {modelsMeta.source === 'defaults' && (
          <div className="provider-alert warning" data-testid="models-fallback">
            The runtime catalogue is unavailable
            {modelsMeta.reason ? `: ${modelsMeta.reason}` : ''}. These are the built-in routing
            modes, not an answer from the runtime.
          </div>
        )}

        <div data-testid="models-list">
          {routingModes.length > 0 && (
            <>
              <div className="provider-output-label">Routing modes ({routingModes.length})</div>
              <div className="provider-models">
                {routingModes.map(model => (
                  <span key={model} className="model-chip">{model}</span>
                ))}
              </div>
            </>
          )}

          {otherModels.length > 0 && (
            <>
              <div className="provider-output-label">
                Other ids reported by the runtime ({otherModels.length})
              </div>
              <div className="provider-models provider-models-secondary">
                {otherModels.map(model => (
                  <span key={model} className="model-chip">{model}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="provider-section-title">Test plain-text request</h3>
        <p className="provider-note">
          Sends a plain string message, exactly like OpenAI. The response must come back as a
          string.
        </p>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="meterless-test-model">Model</label>
            <input
              id="meterless-test-model"
              type="text"
              list="meterless-test-models"
              value={testModel}
              onChange={event => setTestModel(event.target.value)}
              spellCheck="false"
            />
            <datalist id="meterless-test-models">
              {models.map(model => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </div>
          <div className="form-group">
            <label htmlFor="meterless-test-prompt">Message</label>
            <input
              id="meterless-test-prompt"
              type="text"
              value={testPrompt}
              onChange={event => setTestPrompt(event.target.value)}
            />
          </div>
        </div>
        <div className="provider-actions">
          <button
            type="button"
            className="btn btn-success"
            onClick={handleTest}
            disabled={busy === 'test'}
          >
            {busy === 'test' ? 'Waiting…' : 'Send test request'}
          </button>
        </div>

        {testError && <div className="provider-alert error">{testError}</div>}
        {testResult && (
          <div>
            <div className="provider-output-label">Response (string)</div>
            <pre className="provider-output">{testResult}</pre>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header" style={{ paddingBottom: '0.5rem' }}>
          <h3 className="provider-section-title">Zetaris</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <StatusBadge status={zetarisStatus} />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={loadZetaris}
              disabled={zetarisBusy === 'status'}
            >
              {zetarisBusy === 'status' ? 'Checking…' : 'Re-check status'}
            </button>
          </div>
        </div>
        <p className="provider-note">
          Read from <code>ZETARIS_ORG_ID</code>, <code>ZETARIS_API_KEY</code> (or{' '}
          <code>ZETARIS_USERNAME</code> + <code>ZETARIS_PASSWORD</code>) and{' '}
          <code>ZETARIS_REST_URL</code> in <code>.env</code>. The status is honest:{' '}
          <code>SELECT 1</code> must come back with <code>1</code> through{' '}
          <code>POST /sql-editor/sqls/run</code>.
        </p>

        {zetaris?.status?.status === 'unauthorized' && (
          <div className="provider-alert warning">
            Zetaris refused the credentials. <code>X-Org-ID</code> must be the numeric
            organisation id behind that token, not the organisation name; without an API key the
            client logs in with <code>ZETARIS_USERNAME</code> and <code>ZETARIS_PASSWORD</code>.
          </div>
        )}

        {zetaris?.status?.status === 'offline' && /reserved|Nothing is listening/i.test(
          zetaris?.status?.reason || ''
        ) && (
          <div className="provider-alert warning">
            The REST port is not reachable. On Windows the TCP range 8871-9070 is reserved, so a
            Docker mapping for 8888 never listens; publish the API on a free port (for example
            14088) and point <code>ZETARIS_REST_URL</code> at it.
          </div>
        )}

        <dl className="provider-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={zetarisStatus} />
              {zetaris?.status?.latencyMs !== undefined ? ` · ${zetaris.status.latencyMs} ms` : ''}
              {zetaris?.status?.reason ? ` · ${zetaris.status.reason}` : ''}
            </dd>
          </div>
          <div>
            <dt>REST URL</dt>
            <dd><code>{zetaris?.restUrl || '…'}</code></dd>
          </div>
          <div>
            <dt>Organisation id</dt>
            <dd><code>{zetaris?.orgId || '…'}</code></dd>
          </div>
          <div>
            <dt>Web UI</dt>
            <dd><code>{zetaris?.uiUrl || '…'}</code></dd>
          </div>
          <div>
            <dt>Auth</dt>
            <dd>{zetarisAuth}</dd>
          </div>
        </dl>

        <form onSubmit={handleZetarisQuery} style={{ marginTop: '1rem' }}>
          <div className="form-group">
            <label htmlFor="zetaris-sql">Read-only SQL</label>
            <textarea
              id="zetaris-sql"
              value={zetarisSql}
              onChange={event => setZetarisSql(event.target.value)}
              rows={3}
              spellCheck="false"
              placeholder="SELECT 1 AS one"
            />
            <small className="provider-hint">
              Only a single <code>SELECT</code>, <code>SHOW</code>, <code>DESCRIBE</code> or{' '}
              <code>WITH</code> statement is accepted here.
            </small>
          </div>
          <div className="provider-actions">
            <button
              type="submit"
              className="btn btn-success"
              disabled={zetarisBusy === 'query'}
            >
              {zetarisBusy === 'query' ? 'Running…' : 'Run query'}
            </button>
          </div>
        </form>

        {zetarisError && <div className="provider-alert error">{zetarisError}</div>}
        {zetarisResult && (
          <div>
            <div className="provider-output-label">
              {zetarisResult.rows?.length || 0} row(s)
              {zetarisResult.timeUsedMs ? ` · ${zetarisResult.timeUsedMs} ms` : ''}
            </div>
            <pre className="provider-output">
              {[zetarisResult.headers?.join(' | '), ...(zetarisResult.rows || []).map(row => row.join(' | '))]
                .filter(Boolean)
                .join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProviderSettings;
