import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';

import API_BASE from '../api';
import { subscribe } from '../ws';

const TABS = [
  { id: 'ask', label: 'Ask' },
  { id: 'think', label: 'Think' },
  { id: 'answer', label: 'Answer' }
];

const EMPTY_TEXT = {
  ask: 'No prompt was recorded for this request.',
  think: 'The model returned no separate reasoning.',
  answer: 'This request produced no answer, so nothing was posted as a comment.'
};

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Shows the server-side Meterless request log for one news item:
 * the prompt that was asked, the reasoning the model returned and the clean
 * answer that became a comment. Mirrors the ask → think → answer console log.
 */
function MeterlessLogPanel({ newsId }) {
  const [entries, setEntries] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeTab, setActiveTab] = useState('ask');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/meterless/log`, {
        params: newsId ? { newsId } : {}
      });
      const list = Array.isArray(data.entries) ? data.entries : [];
      setEntries(list);
      setError('');
      setSelectedId(current =>
        list.some(entry => entry.id === current) ? current : list[0]?.id ?? null
      );
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load the Meterless log.');
    } finally {
      setLoading(false);
    }
  }, [newsId]);

  useEffect(() => {
    setLoading(true);
    load();
    // The discussion keeps producing requests, so keep the view fresh.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  // New entries arrive over the shared socket the moment the server records
  // them, so an open panel follows a running discussion without waiting for the
  // next 5-second poll.
  useEffect(() => {
    const unsubscribe = subscribe((type, data) => {
      if (type !== 'meterless_log_entry' || !data) return;
      if (newsId && data.newsId !== newsId) return;
      setEntries(prev => {
        if (prev.some(entry => entry.id === data.id)) return prev;
        return [data, ...prev];
      });
    });
    return unsubscribe;
  }, [newsId]);

  const selected = useMemo(
    () => entries.find(entry => entry.id === selectedId) || entries[0] || null,
    [entries, selectedId]
  );

  const handleClear = async () => {
    try {
      await axios.delete(`${API_BASE}/meterless/log`, { params: newsId ? { newsId } : {} });
      setEntries([]);
      setSelectedId(null);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to clear the log.');
    }
  };

  return (
    <div className="meterless-log" data-testid="meterless-log">
      <div className="meterless-log-header">
        <h4>🧠 Meterless requests ({entries.length})</h4>
        <div className="meterless-log-actions">
          <button type="button" className="btn btn-secondary" onClick={load}>
            🔄 Refresh
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClear}
            disabled={entries.length === 0}
          >
            🗑 Clear
          </button>
        </div>
      </div>

      {error && <div className="provider-alert error">{error}</div>}

      {loading && entries.length === 0 && <div className="no-comments">Loading the Meterless log…</div>}

      {!loading && entries.length === 0 && (
        <div className="no-comments">
          No Meterless request yet for this news item. Start a discussion to fill the log.
        </div>
      )}

      {entries.length > 0 && (
        <div className="meterless-log-body">
          <div className="meterless-log-list">
            {entries.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={`meterless-log-item ${selected?.id === entry.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="meterless-log-item-top">
                  <span className="meterless-log-item-id">#{entry.id}</span>
                  <span className="meterless-log-item-time">{formatTime(entry.at)}</span>
                </span>
                <span className="meterless-log-item-user">{entry.userName || 'unknown user'}</span>
                <span className="meterless-log-item-model">{entry.model || 'unknown model'}</span>
                {entry.error && (
                  <span className="meterless-log-item-error">⚠ {entry.error}</span>
                )}
              </button>
            ))}
          </div>

          {selected && (
            <div className="meterless-log-detail">
              <div className="meterless-log-meta">
                <span>
                  <strong>#{selected.id}</strong>
                </span>
                <span>{selected.model || 'unknown model'}</span>
                <span>{selected.userName || 'unknown user'}</span>
                {selected.durationMs !== null && selected.durationMs !== undefined && (
                  <span>{selected.durationMs} ms</span>
                )}
                <span>{formatTime(selected.at)}</span>
              </div>

              <div className="meterless-log-tabs" role="tablist">
                {TABS.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    className={`meterless-log-tab ${activeTab === tab.id ? 'active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {selected.error && <div className="provider-alert error">{selected.error}</div>}

              <pre className="provider-output meterless-log-output">
                {selected[activeTab] || EMPTY_TEXT[activeTab]}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MeterlessLogPanel;
