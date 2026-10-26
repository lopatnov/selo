import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';

import './App.css';

import { login as loginRequest } from './api';
import AddRSSSource from './components/AddRSSSource';
import AddUser from './components/AddUser';
import LoginForm from './components/LoginForm';
import NewsFeed from './components/NewsFeed';
import UsersList from './components/UsersList';

function App() {
  const navigate = useNavigate();
  const [userToken, setUserToken] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) setUserToken(token);
  }, []);

  const login = async (credentials) => {
    const token = await loginRequest(credentials);
    setUserToken(token);
    localStorage.setItem('token', token);
    navigate('/feed');
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUserToken(null);
    navigate('/login');
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>🤖 AI News Discussion</h1>
        {userToken ? (
          <nav>
            <Link to="/feed">News Feed</Link> | 
            <Link to="/users">Users</Link> |
            <button onClick={logout}>Logout</button>
          </nav>
        ) : (
          <button onClick={() => navigate('/login')}>Login</button>
        )}
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<NewsFeed />} />
          <Route path="/feed" element={<NewsFeed />} />
          <Route path="/users" element={<UsersList />} />
          <Route path="/add-rss" element={<AddRSSSource />} />
          <Route path="/add-user" element={<AddUser />} />
          <Route path="/login" element={<LoginForm login={login} />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
