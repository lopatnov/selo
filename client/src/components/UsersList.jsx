import axios from 'axios';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const API_BASE = 'http://localhost:3001/api';

function UsersList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsers();
  }, []);

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
    } catch (error) {
      console.error('Failed to delete user:', error);
      alert('Failed to delete user');
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

      {users.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: '#95a5a6', marginBottom: '1rem' }}>No users yet. Create AI personalities for discussions.</p>
          <Link to="/add-user" className="btn btn-primary">Add User</Link>
        </div>
      ) : (
        <div className="users-grid">
          {users.map(user => (
            <div key={user.id} className={`user-card ${user.isAI ? 'ai' : ''}`}>
              <div className="user-name">{user.name} {user.isAI ? '🤖' : '👤'}</div>
              <div className="user-model">Model: {user.modelName}</div>
              <div className="user-personality">{user.personality}</div>
              <div className="user-actions">
                <button 
                  className="btn btn-danger" 
                  onClick={() => handleDeleteUser(user.id)}
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem' }}
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

export default UsersList;