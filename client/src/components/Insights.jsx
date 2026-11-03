import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE from '../api';

function label(column) {
  return String(column).replaceAll('_', ' ');
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('uk-UA');
}

function Stats({ item }) {
  const row = item.rows[0] || [];
  return (
    <div className="insights-stats">
      {item.columns.map((column, index) => (
        <div className="insights-stat" key={column}>
          <strong>{row[index] ?? '–'}</strong>
          <span>{label(column)}</span>
        </div>
      ))}
    </div>
  );
}

function Ranked({ item }) {
  const values = item.rows.map(row => Number(row[item.bar]) || 0);
  const largest = Math.max(1, ...values);

  return (
    <table className="insights-table">
      <thead>
        <tr>
          {item.columns.map(column => (
            <th key={column}>{label(column)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {item.rows.map((row, rowIndex) => (
          // The rows of one query have no id; their position is the identity.
          // eslint-disable-next-line react/no-array-index-key
          <tr key={rowIndex}>
            {row.map((value, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <td key={index} className={index === item.bar ? 'insights-bar-cell' : ''}>
                {index === item.bar ? (
                  <span className="insights-bar" style={{ width: `${(values[rowIndex] / largest) * 100}%` }} />
                ) : null}
                <span className="insights-value">{value ?? '–'}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InsightCard({ item }) {
  const empty = !item.error && item.rows.length === 0;

  return (
    <div className="card insights-card" data-testid={`insight-${item.id}`}>
      <h3 className="insights-title">{item.title}</h3>
      <p className="insights-description">{item.description}</p>
      {item.error && <div className="provider-alert error">{item.error}</div>}
      {empty && <div className="no-comments">Nothing to show yet.</div>}
      {!item.error && !empty && (item.kind === 'stats' ? <Stats item={item} /> : <Ranked item={item} />)}
      <details className="insights-sql">
        <summary>SQL run by Zetaris · {item.ms} ms</summary>
        <pre>{item.sql}</pre>
      </details>
    </div>
  );
}

/**
 * What the app's data says, worked out by Zetaris: every card is one read-only
 * SQL query (joins, aggregates, JSON fields) that the server sends to Zetaris.
 */
function Insights() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Only the newest request may update the page: the development build mounts
  // twice, and an older answer arriving late must not replace a newer one.
  const newest = useRef(0);

  const load = useCallback(async () => {
    newest.current += 1;
    const mine = newest.current;
    setLoading(true);
    try {
      const { data: body } = await axios.get(`${API_BASE}/insights`);
      if (mine !== newest.current) return;
      setData(body);
      setError('');
    } catch (err) {
      if (mine !== newest.current) return;
      setError(err.response?.data?.error || err.message || 'Failed to load the insights.');
    } finally {
      if (mine === newest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Unmounting makes the request in flight an old one.
    return () => {
      newest.current += 1;
    };
  }, [load]);

  const items = data?.items || [];
  const failed = items.filter(item => item.error);
  const allFailed = items.length > 0 && failed.length === items.length;

  return (
    <div data-testid="insights-page">
      <div className="card">
        <div className="card-header" style={{ paddingBottom: 0 }}>
          <h2 className="card-title">📊 Insights</h2>
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Asking Zetaris…' : '🔄 Refresh'}
          </button>
        </div>
        <p className="insights-description">
          Every card below is one SQL query that Zetaris runs on the tables where this app keeps its data
          {data?.database ? (
            <>
              {' '}
              (database <code>{data.database}</code>
              {data.generatedAt ? `, asked at ${formatTime(data.generatedAt)}` : ''})
            </>
          ) : null}
          . Nothing is counted in the app.
        </p>
      </div>

      {error && <div className="provider-alert error">{error}</div>}

      {data?.stale && (
        <div className="provider-alert warning" data-testid="insights-stale">
          {data.notice}
        </div>
      )}

      {data?.available === false && (
        <div className="provider-alert warning" data-testid="insights-unavailable">
          {data.reason} <Link to="/providers">Zetaris status</Link>
        </div>
      )}

      {allFailed && (
        <div className="provider-alert error" data-testid="insights-failed">
          Zetaris did not answer: {failed[0].error} <Link to="/providers">Zetaris status</Link>
        </div>
      )}

      {items.map(item => (
        <InsightCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export default Insights;
