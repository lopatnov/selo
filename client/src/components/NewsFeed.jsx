import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import API_BASE, { WS_URL, getParticipant } from '../api';
import MeterlessLogPanel from './MeterlessLogPanel';

const DISCUSSION_STOP_REASONS = {
  stopped: 'Discussion stopped.',
  max_messages: 'Discussion finished: every AI reached its per-news message limit.',
  ai_unavailable: 'Discussion stopped: the AI provider returned no answer three times in a row.',
  no_ai_users: 'Discussion stopped: no AI personalities are configured.',
  error: 'Discussion stopped after an internal error. Check the server log.'
};

function NewsFeed() {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedNews, setExpandedNews] = useState(null);
  const [comments, setComments] = useState({});
  const [discussionActive, setDiscussionActive] = useState({});
  const [discussionReason, setDiscussionReason] = useState({});
  const [discussionError, setDiscussionError] = useState({});
  const [startingDiscussion, setStartingDiscussion] = useState({});
  const [logOpen, setLogOpen] = useState({});
  const [logEntries, setLogEntries] = useState({});
  const [commentDetails, setCommentDetails] = useState({});
  const [detailsLoading, setDetailsLoading] = useState({});
  const [detailsError, setDetailsError] = useState({});
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
            setComments(prev => {
              const thread = prev[data.newsId] || [];
              // The REST fetch and the WebSocket can deliver the same comment;
              // keep one copy so the thread never shows duplicates.
              if (thread.some(comment => comment.id === data.id)) {
                return prev;
              }
              return { ...prev, [data.newsId]: [...thread, data] };
            });
            scrollToBottom();
            break;
          case 'discussion_status':
            setDiscussionActive(prev => ({
              ...prev,
              [data.newsId]: data.active
            }));
            setDiscussionReason(prev => ({
              ...prev,
              [data.newsId]: data.active ? '' : data.reason || ''
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
      setDiscussionReason(prev => ({
        ...prev,
        [newsId]: response.data.discussionActive
          ? ''
          : response.data.discussionStoppedReason || ''
      }));
    } catch (error) {
      console.error('Failed to fetch news details:', error);
    }
  };

  // The server answers immediately (202) and streams the AI replies over the
  // WebSocket, so a slow model never looks like a failure. Only a real refusal
  // is shown here, with the server's own explanation.
  const handleStartDiscussion = async (newsId) => {
    setStartingDiscussion(prev => ({ ...prev, [newsId]: true }));
    setDiscussionError(prev => ({ ...prev, [newsId]: '' }));
    setDiscussionReason(prev => ({ ...prev, [newsId]: '' }));

    try {
      const { data } = await axios.post(`${API_BASE}/discussion/start`, { newsId });
      setDiscussionActive(prev => ({ ...prev, [newsId]: true }));
      if (data?.message) console.info(data.message);
    } catch (error) {
      console.error('Failed to start discussion:', error);
      setDiscussionError(prev => ({
        ...prev,
        [newsId]:
          error.response?.data?.error ||
          error.message ||
          'Failed to start the discussion. Please try again.'
      }));
    } finally {
      setStartingDiscussion(prev => ({ ...prev, [newsId]: false }));
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

  // Ask / thinking behind one AI comment is fetched on demand: the log entry
  // holds the whole prompt, and the comment already shows the answer.
  const handleToggleCommentDetails = async (newsId, comment) => {
    const isOpen = Boolean(commentDetails[comment.id]);
    setCommentDetails(prev => ({ ...prev, [comment.id]: !isOpen }));
    if (isOpen || !comment.logEntryId) return;

    const known = (logEntries[newsId] || []).find(entry => entry.id === comment.logEntryId);
    if (known) return;

    setDetailsLoading(prev => ({ ...prev, [comment.id]: true }));
    setDetailsError(prev => ({ ...prev, [comment.id]: '' }));
    try {
      const { data } = await axios.get(`${API_BASE}/meterless/log`, { params: { newsId } });
      const list = Array.isArray(data.entries) ? data.entries : [];
      setLogEntries(prev => ({ ...prev, [newsId]: list }));
    } catch (error) {
      setDetailsError(prev => ({
        ...prev,
        [comment.id]:
          error.response?.data?.error || error.message || 'Failed to load the prompt and thinking.'
      }));
    } finally {
      setDetailsLoading(prev => ({ ...prev, [comment.id]: false }));
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
                      disabled={Boolean(startingDiscussion[item.id])}
                    >
                      {startingDiscussion[item.id] ? '⏳ Starting…' : '▶ Start Discussion'}
                    </button>
                  )}
                </div>

                {discussionError[item.id] && (
                  <div className="provider-alert error" style={{ margin: '0 1.25rem 1rem' }}>
                    {discussionError[item.id]}
                  </div>
                )}

                {!discussionActive[item.id] && discussionReason[item.id] && (
                  <div
                    className="provider-alert warning"
                    style={{ margin: '0 1.25rem 1rem' }}
                    data-testid={`discussion-reason-${item.id}`}
                  >
                    {DISCUSSION_STOP_REASONS[discussionReason[item.id]] ||
                      DISCUSSION_STOP_REASONS.stopped}
                  </div>
                )}

                <div className="discussion-panel">
                  <div className="discussion-header">
                    <h4 style={{ margin: 0 }}>💬 Discussion ({comments[item.id]?.length || 0})</h4>
                    <button
                      type="button"
                      className={`btn ${logOpen[item.id] ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setLogOpen(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                      title="See the exact ask / think / answer of every Meterless request for this news item"
                    >
                      🧠 Meterless Log
                    </button>
                  </div>

                  {logOpen[item.id] && <MeterlessLogPanel newsId={item.id} />}
                  
                  <div className="discussion-comments">
                    {comments[item.id]?.length > 0 ? (
                      comments[item.id].map(comment => {
                        const entry =
                          (logEntries[item.id] || []).find(item2 => item2.id === comment.logEntryId) ||
                          null;
                        const canOpen = Boolean(comment.logEntryId) || Boolean(comment.error);

                        return (
                          <div
                            key={comment.id}
                            className={`comment ${comment.isAI ? 'ai' : 'user'}${
                              comment.error ? ' error' : ''
                            }`}
                          >
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

                            {canOpen && (
                              <button
                                type="button"
                                className="comment-details-toggle"
                                onClick={() => handleToggleCommentDetails(item.id, comment)}
                                aria-expanded={Boolean(commentDetails[comment.id])}
                              >
                                {comment.error ? '⚠ Error details' : '🔎 Ask & thinking'}
                              </button>
                            )}

                            {commentDetails[comment.id] && (
                              <div className="comment-details">
                                {comment.error && (
                                  <div className="comment-error">
                                    <strong>{comment.error.code || 'error'}</strong>
                                    {comment.error.message ? `: ${comment.error.message}` : ''}
                                    {comment.error.attempts
                                      ? ` · ${comment.error.attempts} attempt(s)`
                                      : ''}
                                  </div>
                                )}
                                {detailsError[comment.id] && (
                                  <div className="comment-error">{detailsError[comment.id]}</div>
                                )}
                                {detailsLoading[comment.id] && (
                                  <div className="comment-details-note">Loading the prompt…</div>
                                )}
                                {!detailsLoading[comment.id] &&
                                  comment.logEntryId &&
                                  !entry &&
                                  !detailsError[comment.id] && (
                                    <div className="comment-details-note">
                                      No Meterless log entry is available for this comment anymore.
                                    </div>
                                  )}
                                {entry && (
                                  <>
                                    <div className="provider-output-label">
                                      Ask — exactly what the model received
                                    </div>
                                    <pre className="provider-output">{entry.ask || '(empty)'}</pre>
                                    <div className="provider-output-label">Thinking</div>
                                    <pre className="provider-output">
                                      {entry.think || '(no reasoning returned)'}
                                    </pre>
                                    <div className="provider-output-label">
                                      Answer — shown as the comment above
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
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