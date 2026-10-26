import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE, { WS_URL, getParticipant } from '../api';

function NewsFeed() {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedNews, setExpandedNews] = useState(null);
  const [comments, setComments] = useState({});
  const [discussionActive, setDiscussionActive] = useState({});
  const [newCommentText, setNewCommentText] = useState('');
  const [participant, setParticipant] = useState(null);
  const wsRef = useRef(null);
  const commentsEndRef = useRef(null);

  useEffect(() => {
    fetchNews();
    loadParticipant();
    connectWebSocket();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const fetchNews = async () => {
    try {
      const response = await axios.get(`${API_BASE}/news`);
      setNews(response.data);
    } catch (error) {
      console.error('Failed to fetch news:', error);
    } finally {
      setLoading(false);
    }
  };

  // No login: the server hands out the one local participant.
  const loadParticipant = async () => {
    try {
      setParticipant(await getParticipant());
    } catch (error) {
      console.error('Failed to load the local participant:', error);
    }
  };

  const connectWebSocket = () => {
    wsRef.current = new WebSocket(WS_URL);
    
    wsRef.current.onopen = () => {
      console.log('WebSocket connected');
    };
    
    wsRef.current.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        
        switch (type) {
          case 'news_updated':
            setNews(data);
            break;
          case 'new_comment':
            setComments(prev => ({
              ...prev,
              [data.newsId]: [...(prev[data.newsId] || []), data]
            }));
            scrollToBottom();
            break;
          case 'discussion_status':
            setDiscussionActive(prev => ({
              ...prev,
              [data.newsId]: data.active
            }));
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    };
    
    wsRef.current.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      setTimeout(connectWebSocket, 5000);
    };
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  const handleToggleNews = (newsId) => {
    setExpandedNews(prev => prev === newsId ? null : newsId);
    if (expandedNews !== newsId) {
      fetchNewsDetails(newsId);
    }
  };

  const fetchNewsDetails = async (newsId) => {
    try {
      const response = await axios.get(`${API_BASE}/news/${newsId}`);
      setComments(prev => ({ ...prev, [newsId]: response.data.comments || [] }));
      setDiscussionActive(prev => ({ ...prev, [newsId]: response.data.discussionActive || false }));
    } catch (error) {
      console.error('Failed to fetch news details:', error);
    }
  };

  const handleStartDiscussion = async (newsId) => {
    try {
      await axios.post(`${API_BASE}/discussion/start`, { newsId });
    } catch (error) {
      console.error('Failed to start discussion:', error);
      alert('Failed to start discussion. Check if Meterless is configured.');
    }
  };

  const handleStopDiscussion = async (newsId) => {
    try {
      await axios.post(`${API_BASE}/discussion/stop`, { newsId });
    } catch (error) {
      console.error('Failed to stop discussion:', error);
    }
  };

  const handleAddComment = async (newsId) => {
    if (!newCommentText.trim() || !participant) return;

    try {
      await axios.post(`${API_BASE}/comments`, {
        newsId,
        userId: participant.id,
        text: newCommentText.trim()
      });
      setNewCommentText('');
    } catch (error) {
      console.error('Failed to add comment:', error);
      alert(error.response?.data?.error || 'Failed to add comment.');
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('uk-UA', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return <div className="loading">Loading news...</div>;
  }

  return (
    <div className="news-feed">
      <div className="card-header" style={{ paddingBottom: 0 }}>
        <h2 className="card-title">📰 News Feed</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/sources" className="btn btn-primary">📡 RSS Sources</Link>
          <button className="btn btn-secondary" onClick={fetchNews}>🔄 Refresh</button>
        </div>
      </div>

      {news.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: '#95a5a6', marginBottom: '1rem' }}>No news yet. Add an RSS source to get started.</p>
          <Link to="/add-rss" className="btn btn-primary">Add RSS Source</Link>{' '}
          <Link to="/sources" className="btn btn-secondary">Manage sources</Link>
        </div>
      ) : (
        news.map(item => (
          <article key={item.id} className="news-item">
            <div className="news-header" onClick={() => handleToggleNews(item.id)} style={{ cursor: expandedNews === item.id ? 'default' : 'pointer' }}>
              <h3 className="news-title">{item.title}</h3>
              <div className="news-meta">
                <span className="news-source">{item.sourceName}</span>
                <span>{formatDate(item.pubDate || item.fetchedAt)}</span>
              </div>
            </div>

            {expandedNews === item.id && (
              <>
                <div className="news-content">
                  {item.content}
                  {item.link && (
                    <p style={{ marginTop: '1rem' }}>
                      <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ color: '#3498db' }}>
                        Read full article →
                      </a>
                    </p>
                  )}
                </div>

                <div className="news-actions">
                  <span className={`discussion-badge ${discussionActive[item.id] ? 'active' : 'inactive'}`}>
                    <span className={`discussion-dot ${discussionActive[item.id] ? 'active' : 'inactive'}`}></span>
                    {discussionActive[item.id] ? '🟢 Discussion Active' : '⚪ Discussion Stopped'}
                  </span>
                  
                  {discussionActive[item.id] ? (
                    <button 
                      className="btn btn-danger" 
                      onClick={() => handleStopDiscussion(item.id)}
                    >
                      ⏹ Stop Discussion
                    </button>
                  ) : (
                    <button 
                      className="btn btn-success" 
                      onClick={() => handleStartDiscussion(item.id)}
                    >
                      ▶ Start Discussion
                    </button>
                  )}
                </div>

                <div className="discussion-panel">
                  <div className="discussion-header">
                    <h4 style={{ margin: 0 }}>💬 Discussion ({comments[item.id]?.length || 0})</h4>
                  </div>
                  
                  <div className="discussion-comments">
                    {comments[item.id]?.length > 0 ? (
                      comments[item.id].map(comment => (
                        <div key={comment.id} className={`comment ${comment.isAI ? 'ai' : 'user'}`}>
                          <div className="comment-header">
                            <span className={`comment-author ${comment.isAI ? 'ai' : 'user'}`}>
                              {comment.userName} {comment.isAI ? '🤖' : '👤'}
                            </span>
                            <span className={`comment-badge ${comment.isAI ? 'ai' : 'user'}`}>
                              {comment.isAI ? 'AI' : 'User'}
                            </span>
                            <span className="comment-time">
                              {formatDate(comment.timestamp)}
                            </span>
                          </div>
                          <div className="comment-text">{comment.text}</div>
                        </div>
                      ))
                    ) : (
                      <div className="no-comments">No comments yet. Start a discussion or add your comment!</div>
                    )}
                    <div ref={commentsEndRef}></div>
                  </div>

                  <div className="add-comment-form">
                    <textarea
                      value={newCommentText}
                      onChange={(e) => setNewCommentText(e.target.value)}
                      placeholder={
                        participant
                          ? `Add your comment as ${participant.name}...`
                          : 'Loading your local profile...'
                      }
                      rows={3}
                      disabled={!participant}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => handleAddComment(item.id)}
                      disabled={!participant || !newCommentText.trim()}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </>
            )}
          </article>
        ))
      )}
    </div>
  );
}

export default NewsFeed;