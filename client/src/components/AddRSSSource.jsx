import axios from 'axios';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE = 'http://localhost:3001/api';

function AddRSSSource() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await axios.post(`${API_BASE}/rss-sources`, { name, url });
      navigate('/feed');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add RSS source');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card form-card">
      <h2 className="card-title">➕ Add RSS Source</h2>
      
      {error && <div style={{ background: '#fdf2f2', color: '#e74c3c', padding: '1rem', borderRadius: '4px', marginBottom: '1rem' }}>{error}</div>}
      
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="name">Source Name</label>
          <input
            type="text"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., TechCrunch, BBC News, Habr"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="url">RSS Feed URL</label>
          <input
            type="url"
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/rss.xml"
            required
          />
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Adding...' : 'Add RSS Source'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/feed')}>
            Cancel
          </button>
        </div>
      </form>

      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f8f9fa', borderRadius: '4px', fontSize: '0.9rem' }}>
        <strong>Popular RSS feeds:</strong>
        <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
          <li>TechCrunch: <code>https://techcrunch.com/feed/</code></li>
          <li>Habr: <code>https://habr.com/ru/rss/all/all/</code></li>
          <li>BBC News: <code>http://feeds.bbci.co.uk/news/rss.xml</code></li>
          <li>The Verge: <code>https://www.theverge.com/rss/index.xml</code></li>
          <li>Ars Technica: <code>https://feeds.arstechnica.com/arstechnica/index</code></li>
        </ul>
      </div>
    </div>
  );
}

export default AddRSSSource;