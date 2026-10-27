import { Link, Navigate, Route, Routes } from 'react-router-dom';

import './App.css';

import AddRSSSource from './components/AddRSSSource';
import AddUser from './components/AddUser';
import NewsFeed from './components/NewsFeed';
import ProviderSettings from './components/ProviderSettings';
import SourcesList from './components/SourcesList';
import UsersList from './components/UsersList';

/**
 * No authentication anywhere: News Feed, RSS Sources, Users, AI Provider.
 * There is no login route and no token in localStorage.
 *
 * The only WebSocket of the app belongs to the pages that need live updates
 * (see `ws.js`), so one open page means exactly one socket connection.
 */
function App() {
  return (
    <div className="app-container">
      <header className="app-header">
        <h1>🤖 AI News Discussion</h1>
        <nav>
          <Link to="/feed">News Feed</Link>
          <Link to="/sources">RSS Sources</Link>
          <Link to="/users">Users</Link>
          <Link to="/providers">AI Provider</Link>
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="/feed" element={<NewsFeed />} />
          <Route path="/sources" element={<SourcesList />} />
          <Route path="/users" element={<UsersList />} />
          <Route path="/providers" element={<ProviderSettings />} />
          <Route path="/add-rss" element={<AddRSSSource />} />
          <Route path="/add-user" element={<AddUser />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
