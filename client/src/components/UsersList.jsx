import axios from 'axios';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE from '../api';
import { readDiscussionSettings, summarizeDiscussionSettings, toDiscussionPayload } from '../discussionSettings';
import DiscussionSettingsFields from './DiscussionSettingsFields';

function readError(error) {
  return error.response?.data?.error || error.message || 'Request failed';
}

const DEFAULT_PIPELINE = { analyze: true, discuss: true, summarize: false };

function UsersList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  // Deployment-wide settings: roster size, parallel lanes and the pipeline.
  const [agentsPerNews, setAgentsPerNews] = useState(1);
  const [parallelLanes, setParallelLanes] = useState(1);
  const [pipeline, setPipeline] = useState(DEFAULT_PIPELINE);
  // Write the closing summary as a Nightshift race (one lane per model).
  const [raceSummary, setRaceSummary] = useState(false);
  const [raceAttempts, setRaceAttempts] = useState(5);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  useEffect(() => {
    fetchUsers();
    fetchAppSettings();
  }, []);

  const fetchAppSettings = async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/settings`);
      setAgentsPerNews(Number(data.agentsPerNews) || 1);
      setParallelLanes(Number(data.parallelLanes) || 1);
      setPipeline({
        analyze: data.pipeline?.analyze ?? DEFAULT_PIPELINE.analyze,
        discuss: data.pipeline?.discuss ?? DEFAULT_PIPELINE.discuss,
        summarize: data.pipeline?.summarize ?? DEFAULT_PIPELINE.summarize
      });
      setRaceSummary(data.raceSummary === true);
      setRaceAttempts(Number(data.raceAttempts) || 5);
    } catch (err) {
      console.error('Failed to load the discussion settings:', err);
    }
  };

  // The two race settings are saved the same way: show the change, ask the
  // server, and put the old value back if it refuses.
  const saveRaceSetting = async (patch, show, undo) => {
    show(patch);
    setSavingSettings(true);
    setSettingsError('');
    try {
      const { data } = await axios.put(`${API_BASE}/settings`, patch);
      setRaceSummary(data.raceSummary === true);
      setRaceAttempts(Number(data.raceAttempts) || 5);
    } catch (err) {
      undo();
      setSettingsError(readError(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRaceSummary = event => {
    const previous = raceSummary;
    return saveRaceSetting(
      { raceSummary: event.target.checked },
      patch => setRaceSummary(patch.raceSummary),
      () => setRaceSummary(previous)
    );
  };

  const handleRaceAttempts = event => {
    const previous = raceAttempts;
    return saveRaceSetting(
      { raceAttempts: Number(event.target.value) },
      patch => setRaceAttempts(patch.raceAttempts),
      () => setRaceAttempts(previous)
    );
  };

  const handleAgentsPerNews = async (event) => {
    const value = Number(event.target.value);
    const previous = agentsPerNews;
    setAgentsPerNews(value);
    setSavingSettings(true);
    setSettingsError('');
    try {
      const { data } = await axios.put(`${API_BASE}/settings`, { agentsPerNews: value });
      setAgentsPerNews(Number(data.agentsPerNews) || value);
      if (Number.isFinite(Number(data.parallelLanes))) {
        setParallelLanes(Number(data.parallelLanes));
      }
    } catch (err) {
      setAgentsPerNews(previous);
      setSettingsError(readError(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleParallelLanes = async (event) => {
    const value = Number(event.target.value);
    const previous = parallelLanes;
    setParallelLanes(value);
    setSavingSettings(true);
    setSettingsError('');
    try {
      const { data } = await axios.put(`${API_BASE}/settings`, { parallelLanes: value });
      setParallelLanes(Number(data.parallelLanes) || value);
      if (Number.isFinite(Number(data.agentsPerNews))) {
        setAgentsPerNews(Number(data.agentsPerNews));
      }
    } catch (err) {
      setParallelLanes(previous);
      setSettingsError(readError(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const handlePipelineToggle = phase => async (event) => {
    const checked = event.target.checked;
    const next = { ...pipeline, [phase]: checked };
    setPipeline(next);
    setSavingSettings(true);
    setSettingsError('');
    try {
      const { data } = await axios.put(`${API_BASE}/settings`, { pipeline: next });
      setPipeline({
        analyze: data.pipeline?.analyze ?? next.analyze,
        discuss: data.pipeline?.discuss ?? next.discuss,
        summarize: data.pipeline?.summarize ?? next.summarize
      });
    } catch (err) {
      setPipeline({ ...pipeline });
      setSettingsError(readError(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const response = await axios.get(`${API_BASE}/users`);
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;

    try {
      await axios.delete(`${API_BASE}/users/${userId}`);
      setUsers(prev => prev.filter(u => u.id !== userId));
      if (editingId === userId) cancelEdit();
    } catch (error) {
      console.error('Failed to delete user:', error);
      alert('Failed to delete user');
    }
  };

  const startEdit = (user) => {
    setError('');
    setEditingId(user.id);
    setDraft({
      name: user.name || '',
      role: user.role || '',
      modelName: user.modelName || '',
      personality: user.personality || '',
      ...readDiscussionSettings(user)
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
    setSaving('');
  };

  const updateDraft = field => event => {
    const target = event.target;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    setDraft(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async (user) => {
    if (!draft) return;
    setSaving(user.id);
    setError('');
    try {
      const { data } = await axios.put(`${API_BASE}/users/${user.id}`, {
        name: draft.name,
        role: draft.role || '',
        modelName: draft.modelName,
        personality: draft.personality,
        ...toDiscussionPayload(draft)
      });
      setUsers(prev => prev.map(item => (item.id === user.id ? { ...item, ...data } : item)));
      cancelEdit();
    } catch (err) {
      setError(readError(err));
    } finally {
      setSaving('');
    }
  };

  if (loading) {
    return <div className="loading">Loading users...</div>;
  }

  return (
    <div>
      <div className="card-header" style={{ paddingBottom: 0 }}>
        <h2 className="card-title">👥 Users / AI Personalities</h2>
        <Link to="/add-user" className="btn btn-primary">+ Add User</Link>
      </div>

      <div className="card agent-settings" data-testid="agent-settings">
        <div className="agent-settings-row">
          <div className="agent-settings-text">
            <label htmlFor="agents-per-news">Agents per news</label>
            <p className="agent-settings-hint">
              How many different AI personalities may discuss one news item at the same time.
              They are drawn at random for every discussion, so different articles get
              different voices.
            </p>
          </div>
          <select
            id="agents-per-news"
            value={agentsPerNews}
            onChange={handleAgentsPerNews}
            disabled={savingSettings}
          >
            {[1, 2, 3, 4, 5].map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="agent-settings-row">
          <div className="agent-settings-text">
            <label htmlFor="parallel-lanes">Parallel lanes</label>
            <p className="agent-settings-hint">
              How many of the assigned personalities may speak at the same time.
              1 keeps the classic turn-by-turn discussion; 2–5 lets several lanes post
              concurrently. Raising this above <strong>Agents per news</strong> also
              raises the roster automatically.
            </p>
          </div>
          <select
            id="parallel-lanes"
            value={parallelLanes}
            onChange={handleParallelLanes}
            disabled={savingSettings}
          >
            {[1, 2, 3, 4, 5].map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="agent-settings-row agent-settings-pipeline">
          <div className="agent-settings-text">
            <label>Discussion pipeline</label>
            <p className="agent-settings-hint">
              The stages a discussion runs through, in order: a parallel analysis opening,
              the ongoing conversation, then a closing summary.
            </p>
          </div>
          <div className="pipeline-toggles">
            <label className="pipeline-toggle">
              <input
                type="checkbox"
                checked={pipeline.analyze}
                onChange={handlePipelineToggle('analyze')}
                disabled={savingSettings}
              />
              <span>🔍 Analysis</span>
            </label>
            <label className="pipeline-toggle">
              <input
                type="checkbox"
                checked={pipeline.discuss}
                onChange={handlePipelineToggle('discuss')}
                disabled={savingSettings}
              />
              <span>💬 Discussion</span>
            </label>
            <label className="pipeline-toggle">
              <input
                type="checkbox"
                checked={pipeline.summarize}
                onChange={handlePipelineToggle('summarize')}
                disabled={savingSettings}
              />
              <span>🧾 Summary</span>
            </label>
          </div>
        </div>

        <div className="agent-settings-row" data-testid="race-settings">
          <div className="agent-settings-text">
            <label htmlFor="race-summary">🏁 Race the summary</label>
            <p className="agent-settings-hint">
              Write the closing summary as a Nightshift race instead of one chat call: the
              runtime runs several attempts on its racing lanes (one lane per model, so
              Nightshift shows a star for each) and the winning attempt is the summary. If
              the race fails or takes longer than two and a half minutes, the summary is
              written the normal way. Needs the <strong>Summary</strong> stage above.
            </p>
          </div>
          <div className="pipeline-toggles">
            <label className="pipeline-toggle">
              <input
                id="race-summary"
                type="checkbox"
                checked={raceSummary}
                onChange={handleRaceSummary}
                disabled={savingSettings}
              />
              <span>Race</span>
            </label>
            <label className="pipeline-toggle">
              <select
                id="race-attempts"
                aria-label="Race attempts"
                value={raceAttempts}
                onChange={handleRaceAttempts}
                disabled={savingSettings || !raceSummary}
              >
                {Array.from({ length: 11 }, (_, index) => index + 2).map(value => (
                  <option key={value} value={value}>
                    {value} attempts
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {settingsError && <div className="provider-alert error">{settingsError}</div>}
      </div>

      {error && (
        <div className="provider-alert error" data-testid="users-error">
          {error}
        </div>
      )}

      {users.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: '#95a5a6', marginBottom: '1rem' }}>No users yet. Create AI personalities for discussions.</p>
          <Link to="/add-user" className="btn btn-primary">Add User</Link>
        </div>
      ) : (
        <div className="users-grid">
          {users.map(user => (
            <div key={user.id} className={`user-card ${user.isAI ? 'ai' : ''}`}>
              {editingId === user.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSave(user);
                  }}
                >
                  <div className="form-group">
                    <label htmlFor={`user-name-${user.id}`}>Name</label>
                    <input
                      id={`user-name-${user.id}`}
                      type="text"
                      value={draft.name}
                      onChange={updateDraft('name')}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`user-role-${user.id}`}>Who am I?</label>
                    <input
                      id={`user-role-${user.id}`}
                      type="text"
                      value={draft.role || ''}
                      onChange={updateDraft('role')}
                      placeholder="e.g., The Workaholic (The Career-driven Professional)"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`user-model-${user.id}`}>AI Model / Routing Mode</label>
                    <input
                      id={`user-model-${user.id}`}
                      type="text"
                      value={draft.modelName}
                      onChange={updateDraft('modelName')}
                      spellCheck="false"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`user-personality-${user.id}`}>Personality Description</label>
                    <textarea
                      id={`user-personality-${user.id}`}
                      value={draft.personality}
                      onChange={updateDraft('personality')}
                      rows={3}
                      required
                    />
                  </div>

                  {user.isAI !== false && (
                    <DiscussionSettingsFields
                      settings={draft}
                      onChange={nextSettings => setDraft(prev => ({ ...prev, ...nextSettings }))}
                      idPrefix={`user-${user.id}`}
                    />
                  )}

                  <div className="user-actions">
                    <button type="submit" className="btn btn-primary" disabled={saving === user.id}>
                      {saving === user.id ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="user-name">{user.name} {user.isAI ? '🤖' : '👤'}</div>
                  {user.role && <div className="user-role">{user.role}</div>}
                  <div className="user-model">Model: {user.modelName}</div>
                  <div className="user-personality">{user.personality}</div>
                  {user.isAI !== false && (
                    <div className="user-settings-summary" data-testid={`user-settings-${user.id}`}>
                      {summarizeDiscussionSettings(user)}
                    </div>
                  )}
                  <div className="user-actions">
                    <button
                      className="btn btn-secondary"
                      onClick={() => startEdit(user)}
                      style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem' }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => handleDeleteUser(user.id)}
                      style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem' }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default UsersList;
