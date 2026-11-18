import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getSessions, getSession, deleteSession, getConversation, loadSavedReport } from '../services/api.js';
import '../styles/history-page.css';
import '../styles/history-components.css';


// Scroll the nearest scrollable box (not scrollIntoView, which can also shift overflow-hidden wrappers).
const scrollToCard = (card) => {
  if (!card) return;
  let box = card.parentElement;
  while (box && !(['auto', 'scroll'].includes(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) {
    box = box.parentElement;
  }
  if (box) {
    box.scrollTo({ top: box.scrollTop + card.getBoundingClientRect().top - box.getBoundingClientRect().top - 16, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: window.scrollY + card.getBoundingClientRect().top - 16, behavior: 'smooth' });
  }
};

const PracticeHistory = () => {
  const [activeTab, setActiveTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState('all');
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Transcript of the open session, loaded when the user asks for it
  const [transcript, setTranscript] = useState({ sessionId: null, messages: [], loading: false, error: null, open: false });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [reportLoading, setReportLoading] = useState(null); // session id whose report is being opened
  const linkedSessionRef = useRef(searchParams.get('session')); // ?session=<id> from the dashboard's recent sessions
  const itemsPerPage = 6;

  useEffect(() => {
    loadSessions();
  }, [difficultyFilter]);

  async function loadSessions() {
    try {
      setLoading(true);
      setError(null);
      
      const filters = {};
      if (difficultyFilter !== 'all') {
        filters.difficulty = difficultyFilter;
      }
      
      const data = await getSessions(filters);
      setSessions(data || []);

    } catch (err) {
      setError(err.message || 'Failed to load session history');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSession(sessionId, e) {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this session? This action cannot be undone.')) {
      return;
    }
    
    try {
      await deleteSession(sessionId);
      setSessions(prev => prev.filter(s => s.session_id !== sessionId));
      if (selectedSession === sessionId) {
        setSelectedSession(null);
        setSessionDetail(null);
      }
    } catch (err) {
      setError(err.message || 'Failed to delete session');
    }
  }

  async function toggleTranscript(sessionId) {
    if (transcript.sessionId === sessionId && transcript.open) {
      setTranscript(t => ({ ...t, open: false }));
      return;
    }
    if (transcript.sessionId === sessionId && transcript.messages.length > 0) {
      setTranscript(t => ({ ...t, open: true }));
      return;
    }
    setTranscript({ sessionId, messages: [], loading: true, error: null, open: true });
    try {
      const data = await getConversation(sessionId);
      const messages = [...(data?.messages || [])].sort((a, b) => (a.message_index ?? 0) - (b.message_index ?? 0));
      setTranscript({ sessionId, messages, loading: false, error: null, open: true });
    } catch (err) {
      setTranscript({ sessionId, messages: [], loading: false, error: err.message || 'Failed to load the transcript', open: true });
    }
  }

  // Open a past session's saved report on the Evaluation page.
  async function openReport(session) {
    setReportLoading(session.session_id);
    try {
      const report = await loadSavedReport(session);
      if (!report) throw new Error('No saved report was found for this session.');
      // Passed with the navigation, so the session the user may be setting up is left alone.
      navigate('/evaluation', { state: { savedReport: report } });
    } catch (err) {
      setError(err.message || 'Failed to open the report');
    } finally {
      setReportLoading(null);
    }
  }

  async function handleViewSession(sessionId) {
    if (selectedSession === sessionId) {
      setSelectedSession(null);
      setSessionDetail(null);
      return;
    }
    
    try {
      setLoadingDetail(true);
      setSelectedSession(sessionId);
      const detail = await getSession(sessionId);
      setSessionDetail(detail);
    } catch (err) {
      setError(err.message || 'Failed to load session details');
    } finally {
      setLoadingDetail(false);
    }
  }

  const getScoreColor = (score) => {
    if (!score) return '#9ca3af';
    if (score < 70) return '#ef4444';
    if (score < 85) return '#f59e0b';
    return '#10b981';
  };

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatTime = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '—';
    const mins = Math.floor(seconds / 60);
    return `${mins} min`;
  };

  // Build sequential display IDs (0001, 0002...) based on sorted order
  const sessionDisplayIds = {};
  [...sessions]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .forEach((s, i) => {
      sessionDisplayIds[s.session_id] = String(i + 1).padStart(4, '0');
    });

  const filteredSessions = sessions.filter(session => {
    // Filter by search query
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = !searchQuery || 
      (session.client_persona && session.client_persona.toLowerCase().includes(searchLower)) ||
      (session.industry && session.industry.toLowerCase().includes(searchLower));
    
    return matchesSearch;
  });

  // Opened from the dashboard: go to the page holding that session, expand it and scroll to it (once).
  useEffect(() => {
    const target = linkedSessionRef.current;
    if (!target || loading) return;
    linkedSessionRef.current = null;
    const index = sessions.findIndex(s => s.session_id === target);
    if (index < 0) return;
    setCurrentPage(Math.floor(index / itemsPerPage) + 1);
    handleViewSession(target);
    setTimeout(() => scrollToCard(document.getElementById(`history-session-${target}`)), 100);
  }, [loading, sessions]);

  const totalPages = Math.ceil(filteredSessions.length / itemsPerPage);
  const paginatedSessions = filteredSessions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="practice-history-page sc-remix-history-page">
      <div className="page-header">
        <div>
        <h1 className="page-title">Practice History</h1>
        <p className="page-subtitle">Review your past practice sessions and performance</p>
        </div>
<div className="right-controls">
          <div className="search-container">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.35-4.35"></path>
            </svg>
            <input 
              type="text" 
              placeholder="Search by persona or industry" 
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            />
          </div>
          <div className="dropdown-btn">
            <select 
              value={difficultyFilter}
              onChange={(e) => { setDifficultyFilter(e.target.value); setCurrentPage(1); }}
              className="difficulty-select"
            >
              <option value="all">All Difficulties</option>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
              <option value="Expert">Expert</option>
            </select>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
        </div>

      </div>

<button 
            className={`tab-btn mini-radius ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => { setActiveTab('all'); setCurrentPage(1); }}
            style={{ marginBottom: '25px' }}
          >
            All Sessions <span className="tab-count">{sessions.length}</span>
          </button>

      {error && (
        <div className="error-banner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          {error}
          <button onClick={loadSessions} className="retry-btn">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading session history...</p>
        </div>
      ) : paginatedSessions.length === 0 ? (
        <div className="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5">
            <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>
          </svg>
          <h3>No practice sessions found</h3>
          <p>Start your first practice session to see your history here.</p>
        </div>
      ) : (
        <>
          <div className="gridList">
            {paginatedSessions.map(session => (
              <div 
                key={session.session_id} 
                id={`history-session-${session.session_id}`}
                className={`gridCrds ${selectedSession === session.session_id ? 'selected' : ''}`}
                onClick={() => handleViewSession(session.session_id)}
              >
                <div className="session-header">
                  <div className="leftPnl">
                  <div className="session-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                      <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path>
                    </svg>
                  </div>
                  <div>
                    <h3 className="session-title">{session.client_persona || 'Unknown Session'}</h3>
                    <ul className="detils-list">
                  <li>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                    <span>{session.client_persona || 'N/A'}</span>
                  </li>
                  <li>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                      <line x1="16" y1="2" x2="16" y2="6"></line>
                      <line x1="8" y1="2" x2="8" y2="6"></line>
                      <line x1="3" y1="10" x2="21" y2="10"></line>
                    </svg>
                    <span>{formatDate(session.timestamp)} | {formatTime(session.timestamp)}</span>
                  </li>
                  <li>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    <span>{formatDuration(session.total_practice_time)}</span>
                  </li>
                  {session.difficulty_level && (
                    <li>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
                      </svg>
                      <span className={`difficulty-badge ${session.difficulty_level.toLowerCase()}`}>
                        {session.difficulty_level}
                      </span>
                    </li>
                  )}
                    </ul>
                    
                  </div></div>
                  <div className="gridExtraIncom">
                    <span 
                      className="session-score" 
                      
                    >
                     <div title={session.evaluation || session.average_score ? undefined : 'This session was not evaluated'}>
  {session.evaluation || session.average_score ? 'Score' : 'Not'}
  <br />
  {session.average_score
    ? Math.round(session.average_score)
    : session.evaluation ? 0 : 'evaluated'}
</div>
                    </span>

<div class="btnGrp">
<button onClick={(e) => handleDeleteSession(session.session_id, e)}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-6">
  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
</svg>
                  </button>
                  <button  onClick={(e) => { e.stopPropagation(); handleViewSession(session.session_id); }}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-6">
  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
</svg>

                    {selectedSession === session.session_id ? ' ' : ' '}
                  </button>
</div>

                  
                  </div>
                  </div>

               

                

                {selectedSession === session.session_id && loadingDetail && (
                  <div className="detail-loading">
                    <div className="small-spinner"></div>
                    <span>Loading session details...</span>
                  </div>
                )}

                {selectedSession === session.session_id && sessionDetail && (
                  <div className="session-detail-panel" onClick={(e) => e.stopPropagation()}>
                    <h4>Session Details</h4>
                    <div className="detail-grid">
                      <div className="detail-item">
                        <label>Industry</label>
                        <span>{sessionDetail.industry || 'Not specified'}</span>
                      </div>
                      <div className="detail-item">
                        <label>Company Size</label>
                        <span>{sessionDetail.company_size || 'Not specified'}</span>
                      </div>
                      <div className="detail-item">
                        <label>Total Practice Time</label>
                        <span>{formatDuration(sessionDetail.total_practice_time)}</span>
                      </div>
                      <div className="detail-item">
                        <label>Session ID</label>
                        <span className="session-id">{sessionDisplayIds[session.session_id]}</span>
                      </div>
                    </div>
                    
                    {session.evaluation && (
                      <div className="evaluations-section">
                        <h4>Evaluation</h4>
                        <div className="evaluation-item">
                          <div 
                            className="eval-score"
                            style={{ 
                              backgroundColor: getScoreColor(session.evaluation.overall_score),
                              color: 'white'
                            }}
                          >Score: {session.evaluation.overall_score || 'N/A'}</div>
                          <div className="eval-date">{formatDate(session.evaluation.timestamp)}</div>
                          <button
                            type="button"
                            className="btn btn-primary mini-radius"
                            style={{ marginTop: 0, marginLeft: 'auto', padding: '6px 14px', fontSize: '13px' }}
                            disabled={reportLoading === session.session_id}
                            onClick={() => openReport(session)}
                          >
                            {reportLoading === session.session_id ? 'Opening…' : 'View full report'}
                          </button>
                        </div>
                      </div>
                    )}
                    {!session.evaluation && (
                      <div className="evaluations-section">
                        <h4>Evaluation</h4>
                        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                          This session was ended without Stop &amp; Evaluate, so it has no report. Any conversation that was saved is in the transcript below.
                        </div>
                      </div>
                    )}

                    <div className="evaluations-section">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                        <h4 style={{ margin: 0 }}>Transcript</h4>
                        <button
                          type="button"
                          className="btn btn-outline mini-radius"
                          style={{ marginTop: 0, padding: '6px 14px', fontSize: '13px' }}
                          aria-expanded={transcript.sessionId === session.session_id && transcript.open}
                          onClick={() => toggleTranscript(session.session_id)}
                        >
                          {transcript.sessionId === session.session_id && transcript.open ? 'Hide transcript' : 'View transcript'}
                        </button>
                      </div>
                      {transcript.sessionId === session.session_id && transcript.open && (
                        <div style={{ marginTop: '12px', maxHeight: '360px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' }}>
                          {transcript.loading && <div className="detail-loading"><div className="small-spinner"></div><span>Loading transcript...</span></div>}
                          {transcript.error && <div style={{ color: 'var(--error, #ef4444)', fontSize: '14px' }}>{transcript.error}</div>}
                          {!transcript.loading && !transcript.error && transcript.messages.length === 0 && (
                            <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No transcript was saved for this session.</div>
                          )}
                          {transcript.messages.map((msg, i) => {
                            const isUser = msg.role === 'user';
                            return (
                              <div key={i} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                                <div style={{
                                  maxWidth: '80%', padding: '8px 12px', borderRadius: '12px', fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                                  background: isUser ? 'color-mix(in srgb, var(--accent-primary) 22%, transparent)' : 'var(--bg-surface)',
                                  border: '1px solid var(--border-default)', color: 'var(--text-primary)',
                                }}>
                                  <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: '2px' }}>
                                    {isUser ? 'You' : (session.client_persona || 'Counterpart')}
                                  </div>
                                  {msg.content}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination-controls">
              <button 
                className="page-btn mini-radius" 
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(p => p - 1)}
              >
                Previous
              </button>
              <div className="page-indicator">
                Page {currentPage} of {totalPages}
              </div>
              <button 
                className="page-btn mini-radius" 
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(p => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      
    </div>
  );
};

export default PracticeHistory;
