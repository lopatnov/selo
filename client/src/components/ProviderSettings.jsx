import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';

import API_BASE from '../api';

const STATUS_LABELS = {
  online: 'Online',
  unauthorized: 'Unauthorized',
  offline: 'Offline',
  checking: 'Checking…'
};

const DEFAULT_MODELS = ['auto', 'fast', 'deep', 'cheap', 'local', 'fusion'].map(
  disposition => `meterless/${disposition}`
);

function readError(error) {
  return error.response?.data?.error || error.message || 'Request failed';
}

function StatusBadge({ status }) {
  const kind = STATUS_LABELS[status] ? status : 'offline';
  return (
    <span className={`provider-status status-${kind}`}>
      <span className="provider-dot" />
      {STATUS_LABELS[kind] || kind}
    </span>
  );
}

function ProviderSettings() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState({ status: 'checking' });
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [modelsSource, setModelsSource] = useState('defaults');
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

  const applyConfig = useCallback(data => {
    setConfig(data);
    if (data?.baseUrl) setBaseUrl(data.baseUrl);
    if (data?.status) setStatus(data.status);
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/providers/meterless/models`);
      const list = Array.isArray(data.models) && data.models.length > 0 ? data.models : DEFAULT_MODELS;
      setModels(list);
      setModelsSource(data.source || 'runtime');
      setTestModel(current => (list.includes(current) ? current : list[0]));
    } catch {
      setModels(DEFAULT_MODELS);
      setModelsSource('defaults');
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

  useEffect(() => {
    load();
  }, [load]);

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
      setNotice('Saved. Status re-checked with GET /v1/models.');
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
        setNotice(`Found a runtime at ${data.baseUrl} (${data.status}).`);
        setBaseUrl(data.baseUrl);
        await load();
      } else {
        setError('No runtime answered on the usual ports. Start Meterless Runtime and try again.');
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
      await axios.post(`${API_BASE}/providers/meterless/connect`, { link: connectLink.trim() });
      // The link contains a secret in its fragment; drop it from the field.
      setConnectLink('');
      setNotice('Connect link applied. The key was stored locally and is not shown again.');
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

  const statusKind = status?.status || 'checking';
  const unauthorized = statusKind === 'unauthorized';

  return (
    <div>
      <div className="card-header" style={{ paddingBottom: 0 }}>
        <h2 className="card-title">🔌 AI Providers</h2>
        <StatusBadge status={statusKind} />
      </div>

      {loading && <div className="card">Checking Meterless Runtime…</div>}

      {error && <div className="provider-alert error">{error}</div>}
      {notice && <div className="provider-alert success">{notice}</div>}

      {unauthorized && (
        <div className="provider-alert warning">
          The runtime rejected the token. Paste the token written to{' '}
          <code>{'<stateDir>/proxy-token'}</code>. The placeholder <code>rt-local</code> is rejected.
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
              Stored under <code>meterless_runtime_token</code> and sent as{' '}
              <code>Authorization: Bearer</code> on every call. It is never returned by the API.
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
            >
              {busy === 'detect' ? 'Detecting…' : 'Auto Detect'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
              Re-check status
            </button>
          </div>
        </form>

        <dl className="provider-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={statusKind} />
              {status?.httpStatus ? ` · HTTP ${status.httpStatus}` : ''}
              {status?.reason ? ` · ${status.reason}` : ''}
            </dd>
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
          Paste <code>{'http://<host>:<port>/connect#k=<key>'}</code>. The base URL
          comes from the link origin and the key is stored locally. The link is never logged.
        </p>
        <form onSubmit={handleConnect} className="provider-inline-form">
          <input
            type="text"
            value={connectLink}
            onChange={event => setConnectLink(event.target.value)}
            placeholder="http://192.168.1.20:8088/connect#k=…"
            aria-label="Connect link"
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
          Model ids are routing modes, not model names. Unknown <code>meterless/*</code> ids from
          the runtime are kept.
          {modelsSource === 'defaults' && ' Showing the standard modes because the runtime list is unavailable.'}
        </p>
        <div className="provider-models">
          {models.map(model => (
            <span key={model} className="model-chip">{model}</span>
          ))}
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
    </div>
  );
}

export default ProviderSettings;
