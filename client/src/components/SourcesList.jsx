import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE, { WS_URL } from '../api';

function readError(error) {
  return error.response?.data?.error || error.message || 'Request failed';
}

function formatStamp(dateString) {
  if (!dateString) return 'never';
  return new Date(dateString).toLocaleString('uk-UA', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Every source in this list is polled; the server keeps the list in
 * server/data/state.json, so it survives restarts.
 */
function SourcesList() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const wsRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API_BASE}/rss-sources`);
      setSources(Array.isArray(data) ? data : []);
      setError('');
    } catch (err) {
      setError(readError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    wsRef.current = new WebSocket(WS_URL);
    wsRef.current.onmessage = event => {
      try {
        const { type, data } = JSON.parse(event.data);
        if (type === 'rss_sources_updated' && Array.isArray(data)) setSources(data);
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [load]);

  const handleFetchOne = async id => {
    setBusy(`fetch-${id}`);
    setError('');
    setNotice('');
    try {
      const { data } = await axios.post(`${API_BASE}/rss-sources/${id}/fetch`);
      setNotice(
        data.ok
          ? `${data.name}: +${data.added} new item(s)`
          : `${data.name}: ${data.error}`
      );
      if (!data.ok) setError(`${data.name}: ${data.error}`);
      await load();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleFetchAll = async () => {
    setBusy('fetch-all');
    setError('');
    setNotice('');
    try {
      const { data } = await axios.post(`${API_BASE}/news/fetch`);
      const failed = (data.sources || []).filter(result => !result.ok);
      setNotice(`Fetched ${data.sources?.length || 0} source(s), +${data.added} new item(s).`);
      if (failed.length > 0) {
        setError(failed.map(result => `${result.name}: ${result.error}`).join(' · '));
      }
      await load();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  const handleDelete = async source => {
    if (!window.confirm(`Remove "${source.name}" from the list?`)) return;
    setBusy(`delete-${source.id}`);
    setError('');
    setNotice('');
    try {
      await axios.delete(`${API_BASE}/rss-sources/${source.id}`);
      setSources(previous => previous.filter(item => item.id !== source.id));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <div className="card-header" style={{ paddingBottom: 0 }}>
        <h2 className="card-title">📡 RSS Sources ({sources.length})</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/add-rss" className="btn btn-primary">+ Add Source</Link>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleFetchAll}
            disabled={busy === 'fetch-all' || sources.length === 0}
          >
            {busy === 'fetch-all' ? 'Fetching…' : 'Fetch all now'}
          </button>
          <Link to="/feed" className="btn btn-secondary">To News Feed</Link>
        </div>
      </div>

      <p className="provider-note" style={{ marginTop: '0.75rem' }}>
        All sources in this list are polled every 10 minutes and right after a restart. The list is
        stored in <code>server/data/state.json</code> (the <code>server-data</code> volume in Docker), so it
        does not disappear when the server restarts.
      </p>

      {error && <div className="provider-alert error">{error}</div>}
      {notice && <div className="provider-alert success">{notice}</div>}
      {loading && <div className="card">Loading sources…</div>}

      {!loading && sources.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: '#95a5a6', marginBottom: '1rem' }}>No RSS sources yet.</p>
          <Link to="/add-rss" className="btn btn-primary">Add RSS Source</Link>
        </div>
      )}

      {sources.length > 0 && (
        <div className="users-grid">
          {sources.map(source => (
            <div key={source.id} className="user-card">
              <div className="user-name">{source.name}</div>
              <div className="user-model" style={{ wordBreak: 'break-all' }}>
                <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3498db' }}>
                  {source.url}
                </a>
              </div>
              <div className="user-personality">
                {source.itemCount} item(s) in the feed · last fetch {formatStamp(source.lastFetchedAt)}
              </div>
              {source.lastError ? (
                <div className="provider-alert error" style={{ marginTop: '0.5rem' }}>
                  {source.lastError}
                </div>
              ) : (
                <div className="provider-alert success" style={{ marginTop: '0.5rem' }}>
                  {source.lastFetchedAt ? `OK · +${source.lastItemCount || 0} last run` : 'Not fetched yet'}
                </div>
              )}
              <div className="user-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleFetchOne(source.id)}
                  disabled={busy === `fetch-${source.id}`}
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem' }}
                >
                  {busy === `fetch-${source.id}` ? 'Fetching…' : 'Fetch now'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(source)}
                  disabled={busy === `delete-${source.id}`}
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem', marginLeft: '0.5rem' }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SourcesList;
