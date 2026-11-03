import axios from 'axios';
import { useState } from 'react';

import API_BASE from '../api';

const EXAMPLES = [
  'Which personality has written the most comments?',
  'How many comments does each news source have?',
  'Which models failed the most, and why?',
  'Which news about NVIDIA were discussed the most?'
];

function ResultTable({ columns, rows }) {
  return (
    <table className="insights-table">
      <thead>
        <tr>
          {columns.map(column => (
            <th key={column}>{String(column).replaceAll('_', ' ')}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          // The rows of one query have no id; their position is the identity.
          // eslint-disable-next-line react/no-array-index-key
          <tr key={rowIndex}>
            {row.map((value, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <td key={index}>{value ?? '–'}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "412 ms", plus a word when the model had to write the SQL again. */
function queryNote({ ms, attempts }) {
  if (attempts <= 1) return `${ms} ms`;
  return `${ms} ms, written again after an error (attempt ${attempts})`;
}

function Sql({ sql, note }) {
  return (
    <details className="insights-sql">
      <summary>SQL run by Zetaris{note ? ` · ${note}` : ''}</summary>
      <pre>{sql}</pre>
    </details>
  );
}

/**
 * A question in plain words. The server has the model write one read-only SQL
 * query, checks it, has Zetaris run it, and has the model answer from the rows.
 */
function AskData() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);

  const ask = async text => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      const { data } = await axios.post(`${API_BASE}/ask-data`, { question: trimmed });
      setResult(data);
    } catch (err) {
      const body = err.response?.data;
      setFailure({ message: body?.error || err.message || 'The question failed.', sql: body?.sql || '' });
    } finally {
      setBusy(false);
    }
  };

  // `ask` handles its own errors, so the promise it returns is not needed here.
  const submit = event => {
    event.preventDefault();
    void ask(question);
  };

  const useExample = example => {
    setQuestion(example);
    void ask(example);
  };

  return (
    <div className="card" data-testid="ask-data">
      <h3 className="insights-title">💬 Ask the data</h3>
      <p className="insights-description">
        Ask in your own words. The model writes one read-only SQL query, the server lets through only a
        SELECT on the app tables, Zetaris runs it, and the model answers from the rows.
      </p>

      <form className="ask-form" onSubmit={submit}>
        <input
          type="text"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder="Who argued the most about OpenAI?"
          aria-label="Your question about the data"
          maxLength={500}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || question.trim().length < 3}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>

      <div className="ask-examples">
        {EXAMPLES.map(example => (
          <button key={example} type="button" className="btn btn-secondary" disabled={busy} onClick={() => useExample(example)}>
            {example}
          </button>
        ))}
      </div>

      {failure && (
        <div className="provider-alert error" data-testid="ask-error">
          {failure.message}
          {failure.sql ? <Sql sql={failure.sql} note="the last query it wrote" /> : null}
        </div>
      )}

      {result && (
        <div data-testid="ask-result">
          {result.stale && (
            <div className="provider-alert warning" data-testid="ask-stale">
              {result.notice}
            </div>
          )}
          <p className="ask-answer" data-testid="ask-answer">
            {result.answer}
          </p>
          {result.rows.length > 0 && <ResultTable columns={result.columns} rows={result.rows} />}
          <Sql sql={result.sql} note={queryNote(result)} />
        </div>
      )}
    </div>
  );
}

export default AskData;
