import axios from 'axios';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import API_BASE from '../api';

function AddUser() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [modelName, setModelName] = useState('meterless/auto');
  const [personality, setPersonality] = useState('');
  const [isAI, setIsAI] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState([]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API_BASE}/providers/meterless/models`)
      .then(({ data }) => {
        if (cancelled || !Array.isArray(data.models)) return;
        setModels(data.models);
      })
      .catch(() => {
        // The runtime list is optional; the field stays free text.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await axios.post(`${API_BASE}/users`, { name, modelName, personality, isAI });
      navigate('/users');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card form-card">
      <h2 className="card-title">➕ Add User / AI Personality</h2>
      
      {error && <div style={{ background: '#fdf2f2', color: '#e74c3c', padding: '1rem', borderRadius: '4px', marginBottom: '1rem' }}>{error}</div>}
      
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="name">Name</label>
          <input
            type="text"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Alex, CriticBot, OptimistAI"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="modelName">AI Model / Routing Mode (Meterless)</label>
          <input
            type="text"
            id="modelName"
            list="meterless-model-options"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="e.g., meterless/auto, meterless/deep, gpt-4"
            spellCheck="false"
            required
          />
          <datalist id="meterless-model-options">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>

        <div className="form-group">
          <label htmlFor="personality">Personality Description</label>
          <textarea
            id="personality"
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder="Describe the AI's personality, style, opinions, biases, etc. Example: 'A skeptical tech journalist who questions hype and loves technical details. Uses dry humor and references academic papers.'"
            rows={5}
            required
          />
        </div>

        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isAI}
              onChange={(e) => setIsAI(e.target.checked)}
            />
            <span>This is an AI personality (participates in auto-discussions)</span>
          </label>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Adding...' : 'Add User'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/users')}>
            Cancel
          </button>
        </div>
      </form>

      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f8f9fa', borderRadius: '4px', fontSize: '0.9rem' }}>
        <strong>Personality Examples:</strong>
        <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem', lineHeight: '1.8' }}>
          <li><strong>Skeptic:</strong> "Critical thinker who demands evidence. Challenges assumptions and hype. References studies and data."</li>
          <li><strong>Optimist:</strong> "Sees opportunities in every technology. Enthusiastic about progress. Focuses on benefits."</li>
          <li><strong>Pragmatist:</strong> "Balanced view. Weighs pros and cons. Focuses on practical implementation and ROI."</li>
          <li><strong>Futurist:</strong> "Long-term vision. Connects current events to future trends. Speculative but grounded."</li>
          <li><strong>Ethicist:</strong> "Focuses on moral implications. Raises concerns about privacy, bias, societal impact."</li>
        </ul>
        <p style={{ marginTop: '1rem', color: '#7f8c8d' }}>
          <strong>Note:</strong> <code>meterless/*</code> ids are routing modes served by Meterless
          Runtime; other ids use the hosted Meterless endpoint. Configure the runtime under{' '}
          <strong>AI Provider</strong>.
        </p>
      </div>
    </div>
  );
}

export default AddUser;