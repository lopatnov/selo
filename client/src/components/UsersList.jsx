import axios from 'axios';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE from '../api';
import { readDiscussionSettings, summarizeDiscussionSettings, toDiscussionPayload } from '../discussionSettings';
import DiscussionSettingsFields from './DiscussionSettingsFields';

function readError(error) {
  return error.response?.data?.error || error.message || 'Request failed';
}

function UsersList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  // Deployment-wide setting: how many personalities may discuss one news item.
  const [agentsPerNews, setAgentsPerNews] = useState(1);
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
    } catch (err) {
      console.error('Failed to load the discussion settings:', err);
    }
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
    } catch (err) {
      setAgentsPerNews(previous);
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
