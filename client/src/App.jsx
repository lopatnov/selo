import axios from 'axios';
import { useEffect, useState } from 'react';
import { Link, Route, BrowserRouter as Router, Routes, useNavigate } from 'react-router-dom';

import './App.css';

import AddRSSSource from './components/AddRSSSource';
import AddUser from './components/AddUser';
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
    try {
      const response = await axios.post('http://localhost:3001/api/auth/login', credentials);
      setUserToken(response.data.token);
      localStorage.setItem('token', response.data.token);
      navigate('/');
    } catch (error) {
      alert('Login failed. Please check your credentials.');
    }
  };

  return (
    <Router>
      <div className="app-container">
        <header className="app-header">
          <h1>🤖 AI News Discussion</h1>
          {userToken ? (
            <nav>
              <Link to="/feed">News Feed</Link> | 
              <Link to="/users">Users</Link> |
              <button onClick={() => localStorage.removeItem('token') && setUserToken(null)}>Logout</button>
            </nav>
          ) : (
            <button onClick={() => window.location.href = '/login'}>Login</button>
          )}
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/feed" element={<NewsFeed />} />
            <Route path="/users" element={<UsersList />} />
            <Route path="/add-rss" element={<AddRSSSource />} />
            <Route path="/add-user" element={<AddUser />} />
            <Route path="/login" element={<LoginForm login={login} />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;