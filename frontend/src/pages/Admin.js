import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AdminTelemetry from "../components/AdminTelemetry";
import TelemetryDetailsModal from "../components/modals/TelemetryDetailsModal";
import {
  getAdminOverview,
  getAdminAllSessions,
  getAdminAllEvaluations,
  getAdminAllConversations,
  adminInitializeDatabase,
  adminGetConversation,
  adminDeleteSession,
  getAllUsers,
  updateUserRole,
  addUser,
  uploadUserPhoto,
  userPhotoSrc,
  removeUser,
} from '../services/api';

/* ─── helpers ─── */
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString();
};
const fmtTime = (sec) => {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${m}m ${r}s`;
};
const scoreColor = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) return 'var(--text-muted)';
  if (n >= 85) return 'var(--success)';
  if (n >= 60) return 'var(--warning)';
  return 'var(--error)';
};
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* ─── shared inline icon set (mirrors Dashboard's stroke-icon style) ─── */
const Icon = {
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  target: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
  ),
  clipboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>
  ),
  message: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
  ),
  lock: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  ),
  trash: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
  ),
  eye: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  ),
  database: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
  ),
};

/* ─── sub-components ─── */
const Card = ({ children, style }) => (
  <div className="card" style={{ padding: '1.25rem', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)', border: '1px solid var(--border-default)', ...style }}>
    {children}
  </div>
);

const Badge = ({ children, color }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
    padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600,
    background: color ? `${color}22` : 'rgba(99,102,241,0.12)', color: color || 'var(--accent-primary-hover)',
    border: `1px solid ${color ? `${color}33` : 'var(--border-default)'}`,
  }}>
    {children}
  </span>
);

const IconBtn = ({ onClick, title, children, danger }) => (
  <button
    title={title}
    onClick={onClick}
    style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      color: danger ? 'var(--error)' : 'var(--text-muted)',
      padding: '0.3rem', borderRadius: '6px', lineHeight: 1,
      transition: 'all .15s',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'rgba(239,68,68,0.12)' : 'rgba(99,102,241,0.12)'; e.currentTarget.style.color = danger ? 'var(--error)' : 'var(--accent-primary-hover)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = danger ? 'var(--error)' : 'var(--text-muted)'; }}
  >
    {children}
  </button>
);

const Toast = ({ msg, type, onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999,
      padding: '0.85rem 1.25rem', borderRadius: 'var(--radius-md)',
      background: type === 'error' ? 'var(--error)' : 'var(--success)',
      color: '#fff', fontWeight: 500, boxShadow: 'var(--shadow-lg)',
      animation: 'slideIn .25s ease',
    }}>
      {msg}
    </div>
  );
};

const Modal = ({ title, onClose, children }) => (
  <div style={{
    position: 'fixed', inset: 0, zIndex: 5000,
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
  }} onClick={onClose}>
    <div style={{
      background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)',
      border: '1px solid var(--border-strong)', maxWidth: '800px', width: '100%',
      maxHeight: '85vh', display: 'flex', flexDirection: 'column',
      boxShadow: 'var(--shadow-lg)',
    }} onClick={(e) => e.stopPropagation()}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-default)',
      }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{title}</h3>
        <IconBtn onClick={onClose} title="Close">✕</IconBtn>
      </div>
      <div style={{ overflowY: 'auto', padding: '1.25rem' }}>{children}</div>
    </div>
  </div>
);

/* ─── main page ─── */
const Admin = () => {

const [telemetryModal, setTelemetryModal] =
  useState(false);

const [telemetryData, setTelemetryData] =
  useState(null);

  const { user, isDeveloper, role } = useAuth();
  const navigate = useNavigate();
  const isDev = isDeveloper || role === 'developer' || user?.role === 'developer';

  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [evaluations, setEvaluations] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [toast, setToast] = useState(null);

  /* modals */
  const [evalModal, setEvalModal] = useState(null);
  const [chatModal, setChatModal] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);

  /* search / filter / sort state */
  const [search, setSearch] = useState('');
  const [diffFilter, setDiffFilter] = useState('all');
  const [sortBy, setSortBy] = useState('timestamp');
  const [sortDir, setSortDir] = useState('desc');
  const [userSearch, setUserSearch] = useState('');
  const [evalSearch, setEvalSearch] = useState('');
  const [convSearch, setConvSearch] = useState('');

  /* pagination state (one page counter per table) */
  const [overviewPage, setOverviewPage] = useState(1);
  const [usersPage, setUsersPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [convPage, setConvPage] = useState(1);
  const PAGE_SIZE = 10;
  const CONV_PAGE_SIZE = 9;


  useEffect(() => {
    if (!user || (!user.is_admin && !isDev)) { navigate('/dashboard'); return; }
    fetchData();
    // eslint-disable-next-line
  }, [user, isDev]);

  const fetchData = async () => {
    setLoading(true); setError(null);
    try {
      const [ov, us] = await Promise.all([getAdminOverview(), getAllUsers()]);
      setOverview(ov); setUsers(us);
    } catch (err) { setError(err.message || 'Failed to load admin data'); }
    finally { setLoading(false); }
  };

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const loadSessions = async () => {
    setLoading(true);
    try { const data = await getAdminAllSessions({ limit: 300 }); setSessions(data.sessions || []); setActiveTab('sessions'); }
    catch (err) { setError(err.message || 'Failed to load sessions'); showToast(err.message, 'error'); }
    finally { setLoading(false); }
  };
  const loadEvaluations = async () => {
    setLoading(true);
    try { const data = await getAdminAllEvaluations({ limit: 300 }); setEvaluations(data || []); setActiveTab('evaluations'); }
    catch (err) { setError(err.message || 'Failed to load evaluations'); showToast(err.message, 'error'); }
    finally { setLoading(false); }
  };
  const loadConversations = async () => {
    setLoading(true);
    try { const data = await getAdminAllConversations({ limit: 500 }); setConversations(data || []); setActiveTab('conversations'); }
    catch (err) { setError(err.message || 'Failed to load conversations'); showToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleInitDb = async () => {
    if (!window.confirm('Are you sure you want to initialize the database?')) return;
    try { const res = await adminInitializeDatabase(); showToast(res.message || 'Database initialized'); }
    catch (err) { showToast(err.message || 'Failed', 'error'); }
  };

  const handleDeleteSession = async (sid) => {
    if (!window.confirm(`Delete session ${sid}? This removes conversations & evaluations too.`)) return;
    try {
      await adminDeleteSession(sid);
      setSessions(prev => prev.filter(s => s.session_id !== sid));
      showToast('Session deleted');
    } catch (err) { showToast(err.message || 'Delete failed', 'error'); }
  };

  const handleViewChat = async (sid) => {
    try {
      const data = await adminGetConversation(sid);
      setChatModal({ sessionId: sid, messages: data.messages || [] });
    } catch (err) { showToast(err.message || 'Failed to load chat', 'error'); }
  };

  const handleRoleChange = async (email, newRole) => {
    try {
      await updateUserRole(email, newRole);
      showToast(`Updated role for ${email} to ${newRole}`);
      const us = await getAllUsers();
      setUsers(us);
    } catch (err) {
      showToast(err.message || 'Failed to update role', 'error');
    }
  };

  const handleAddUser = async ({ email, full_name, role, photo }) => {
    await addUser({ email, full_name, role }); // errors reach the form, which keeps its values
    let photoError = '';
    if (photo) {
      try { await uploadUserPhoto(email, photo); }
      catch (err) { photoError = err.message || 'upload failed'; }
    }
    setUsers(await getAllUsers());
    if (photoError) showToast(`Added ${email}, but the photo was not saved: ${photoError}`, 'error');
    else showToast(`Added ${email} as ${role}`);
  };

  const handleRemoveUser = async (email) => {
    if (!window.confirm(`Remove ${email}? They will no longer be able to sign in. Their past sessions are kept.`)) return;
    try {
      await removeUser(email);
      setUsers(await getAllUsers());
      showToast(`Removed ${email}`);
    } catch (err) {
      showToast(err.message || 'Failed to remove user', 'error');
    }
  };

  const handlePhotoChange = async (email, file) => {
    if (!file) return;
    try {
      await uploadUserPhoto(email, file);
      setUsers(await getAllUsers());
      showToast(`Updated photo for ${email}`);
    } catch (err) {
      showToast(err.message || 'Failed to upload photo', 'error');
    }
  };

  /* derived data with memo */
  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase();
    const statsMap = new Map();
    (overview?.users || []).forEach(st => statsMap.set((st.username || '').toLowerCase(), st));

    let list = (users || []).map(u => {
      const userEmail = (u.email || u.username || '').toLowerCase();
      const stats = statsMap.get(userEmail) || {};
      return {
        ...u,
        email: u.email || u.username,
        session_count: stats.session_count ?? 0,
        average_score: stats.average_score ?? null,
        total_practice_time: stats.total_practice_time ?? 0,
        created_at: stats.created_at || null,
      };
    });

    if (q) {
      list = list.filter(u =>
        (u.email || '').toLowerCase().includes(q) ||
        (u.full_name || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, overview, userSearch]);

  const filteredSessions = useMemo(() => {
    const q = search.toLowerCase();
    let list = sessions.filter(s => {
      const matchesSearch = !q ||
        s.session_id?.toLowerCase().includes(q) ||
        s.username?.toLowerCase().includes(q) ||
        s.client_persona?.toLowerCase().includes(q) ||
        s.industry?.toLowerCase().includes(q);
      const matchesDiff = diffFilter === 'all' || s.difficulty_level === diffFilter;
      return matchesSearch && matchesDiff;
    });
    list.sort((a, b) => {
      let av = a[sortBy], bv = b[sortBy];
      if (sortBy === 'timestamp') { av = new Date(av || 0).getTime(); bv = new Date(bv || 0).getTime(); }
      else { av = Number(av) || 0; bv = Number(bv) || 0; }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }, [sessions, search, diffFilter, sortBy, sortDir]);

  /* reset to page 1 whenever the underlying filtered lists change */
  useEffect(() => { setUsersPage(1); }, [userSearch, users, overview]);
  useEffect(() => { setSessionsPage(1); }, [search, diffFilter, sortBy, sortDir, sessions]);
  useEffect(() => { setOverviewPage(1); }, [overview]);

  const pagedOverviewUsers = useMemo(() => {
    const list = overview?.users || [];
    return list.slice((overviewPage - 1) * PAGE_SIZE, overviewPage * PAGE_SIZE);
  }, [overview, overviewPage]);

  const pagedUsers = useMemo(() =>
    filteredUsers.slice((usersPage - 1) * PAGE_SIZE, usersPage * PAGE_SIZE),
    [filteredUsers, usersPage]
  );

  const pagedSessions = useMemo(() =>
    filteredSessions.slice((sessionsPage - 1) * PAGE_SIZE, sessionsPage * PAGE_SIZE),
    [filteredSessions, sessionsPage]
  );

  const filteredEvaluations = useMemo(() => {
    const q = evalSearch.toLowerCase();
    let list = evaluations.filter(e =>
      !q ||
      e.session_id?.toLowerCase().includes(q) ||
      e.username?.toLowerCase().includes(q) ||
      e.report_text?.toLowerCase().includes(q)
    );
    list.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return list;
  }, [evaluations, evalSearch]);

  const sessionOptions = useMemo(() => {
    const map = new Map();
    conversations.forEach(c => { if (!map.has(c.session_id)) map.set(c.session_id, c.username); });
    return Array.from(map.entries());
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    const q = convSearch.toLowerCase();
    let list = conversations.filter(c =>
      !q ||
      c.session_id?.toLowerCase().includes(q) ||
      c.username?.toLowerCase().includes(q) ||
      c.content?.toLowerCase().includes(q)
    );
    list.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    return list;
  }, [conversations, convSearch]);

  const groupedConversations = useMemo(() => {
    const groups = {};
    filteredConversations.forEach(c => {
      if (!groups[c.session_id]) groups[c.session_id] = { username: c.username, messages: [] };
      groups[c.session_id].messages.push(c);
    });
    return groups;
  }, [filteredConversations]);

  const conversationEntries = useMemo(() => Object.entries(groupedConversations), [groupedConversations]);

  useEffect(() => { setConvPage(1); }, [convSearch, conversations]);

  const pagedConversationEntries = useMemo(() =>
    conversationEntries.slice((convPage - 1) * CONV_PAGE_SIZE, convPage * CONV_PAGE_SIZE),
    [conversationEntries, convPage]
  );

  if (!user || (!user.is_admin && !isDev)) return null;

  /* ── render ── */
  return (
    <div className="admin-page">
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="card-icon card-icon-square card-icon-purple">{Icon.lock}</span> Super Admin Dashboard
          </h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Manage users, sessions, evaluations and conversations across the platform.</p>
        </div>
        <button onClick={handleInitDb} className='mini-radius' style={{
          padding: '0.55rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)',
          background: 'var(--accent-secondary)', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem',
          display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}>{Icon.database} Init DB</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--error)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', border: '1px solid rgba(239,68,68,0.25)' }}>
          {error}
        </div>
      )}

      {/* tabs */}
      <div className="mini-radius" style={{
        display: 'flex', gap: '0.35rem', marginBottom: '1.5rem', flexWrap: 'wrap',
        background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: '14px',
        padding: '0.4rem',
      }}>
        {[
          { key: 'overview', label: 'Overview', icon: Icon.chart },
          { key: 'users', label: 'Users', icon: Icon.users },
          { key: 'sessions', label: 'Sessions', icon: Icon.target },
          { key: 'evaluations', label: 'Evaluations', icon: Icon.clipboard },
          { key: 'conversations', label: 'Conversations', icon: Icon.message },
          { key: 'telemetry', label: 'Telemetry', icon: Icon.chart },
        ].map(t => {
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => {
                if (t.key === 'sessions') loadSessions();
                else if (t.key === 'evaluations') loadEvaluations();
                else if (t.key === 'conversations') loadConversations();
                else setActiveTab(t.key);
              }}
              style={{
                padding: '0.6rem 1.1rem', borderRadius: '10px', border: 'none', cursor: 'pointer',
                background: active ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' : 'transparent',
                color: active ? '#fff' : 'var(--text-secondary)', fontWeight: 600, fontSize: '0.88rem',
                display: 'flex', alignItems: 'center', gap: '0.45rem', transition: 'all .2s',
                boxShadow: active ? 'var(--shadow-md)' : 'none',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(99,102,241,0.1)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ display: 'flex' }}>{t.icon}</span> {t.label}
            </button>
          );
        })}
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', padding: '2rem 0' }}>
          <div className="spinner" style={{ width: '20px', height: '20px' }} /> Loading…
        </div>
      )}

      {/* ── Overview ── */}
      {!loading && activeTab === 'overview' && overview && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            <StatCard label="Total Users" value={overview.total_users} icon={Icon.users} variant="blue" />
            <StatCard label="Total Sessions" value={overview.total_sessions} icon={Icon.target} variant="teal" />
            <StatCard label="Evaluations" value={overview.total_evaluations} icon={Icon.clipboard} variant="purple" />
            <StatCard label="Messages" value={overview.total_conversations} icon={Icon.message} variant="pink" />
          </div>

          <Card>
            <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', color: 'var(--text-primary)' }}>Users Overview</h3>
            <div style={tableScrollStyle}>
              <table style={tableStyle}>
                <thead><tr>
                  <Th>User</Th>
                  <Th>Created</Th>
                  <Th align="right">Sessions</Th>
                  <Th align="right">Avg Score</Th>
                  <Th align="right" last>Practice Time</Th>
                </tr></thead>
                <tbody>
                  {pagedOverviewUsers.map(u => (
                    <tr key={u.username} style={{ borderBottom: '1px solid var(--border-default)' }}>
                      <Td><Badge>{u.username}</Badge></Td>
                      <Td>{fmtDate(u.created_at)}</Td>
                      <Td align="right">{u.session_count}</Td>
                      <Td align="right" style={{ color: scoreColor(u.average_score), fontWeight: 700 }}>{u.average_score ?? '—'}</Td>
                      <Td align="right" last>{fmtTime(u.total_practice_time)}</Td>
                    </tr>
                  ))}
                  {(overview.users || []).length === 0 && <tr><Td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No users found</Td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination page={overviewPage} setPage={setOverviewPage} totalItems={(overview.users || []).length} pageSize={PAGE_SIZE} />
          </Card>
        </>
      )}

      {/* ── Users ── */}
      {!loading && activeTab === 'users' && (
        <Card>
          <AddUserForm isDev={isDev} onAdd={handleAddUser} />
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <SearchInput placeholder="Search users…" value={userSearch} onChange={setUserSearch} />
          </div>
          <div style={tableScrollStyle}>
            <table style={tableStyle}>
              <thead><tr>
                <Th>Profile Picture</Th>
                <Th>User Email</Th>
                <Th>Full Name</Th>
                <Th>Role</Th>
                <Th>Change Role</Th>
                <Th align="right">Sessions</Th>
                <Th align="right">Avg Score</Th>
                <Th align="right" last>Practice Time</Th>
              </tr></thead>
              <tbody>
                {pagedUsers.map(u => (
                  <tr key={u.email} style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <Td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <UserPhoto src={userPhotoSrc(u.photo_url)} name={u.full_name || u.email} />
                        {(isDev || u.role !== 'developer') && (
                          <label style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            {u.photo_url ? 'Change' : 'Upload'}
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              aria-label={`Upload profile picture for ${u.email}`}
                              style={{ display: 'none' }}
                              onChange={(e) => { handlePhotoChange(u.email, e.target.files?.[0]); e.target.value = ''; }}
                            />
                          </label>
                        )}
                      </div>
                    </Td>
                    <Td><strong style={{ color: 'var(--text-primary)' }}>{u.email}</strong></Td>
                    <Td>{u.full_name || '—'}</Td>
                    <Td>
                      <Badge color={u.role === 'admin' ? 'var(--accent-primary)' : u.role === 'developer' ? 'var(--warning)' : undefined}>
                        {u.role || 'user'}
                      </Badge>
                    </Td>
                    <Td>
                      {!isDev && u.role === 'developer' ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          🔒 Developer protected
                        </span>
                      ) : (
                        <select
                          value={u.role || 'user'}
                          onChange={(e) => handleRoleChange(u.email, e.target.value)}
                          style={{
                            padding: '0.25rem 0.5rem',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-default)',
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                          }}
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                          {isDev && <option value="developer">Developer</option>}
                        </select>
                      )}
                      {(isDev || u.role !== 'developer') && u.email !== (user?.email || '').toLowerCase() && (
                        <span style={{ marginLeft: '0.4rem' }}>
                          <IconBtn title={`Remove ${u.email}`} danger onClick={() => handleRemoveUser(u.email)}>{Icon.trash}</IconBtn>
                        </span>
                      )}
                    </Td>
                    <Td align="right">{u.session_count ?? '—'}</Td>
                    <Td align="right" style={{ color: scoreColor(u.average_score), fontWeight: 700 }}>{u.average_score ?? '—'}</Td>
                    <Td align="right" last>{fmtTime(u.total_practice_time)}</Td>
                  </tr>
                ))}
                {filteredUsers.length === 0 && <tr><Td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No users found</Td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={usersPage} setPage={setUsersPage} totalItems={filteredUsers.length} pageSize={PAGE_SIZE} />
        </Card>
      )}

      {/* ── Sessions ── */}
      {!loading && activeTab === 'sessions' && (
        <Card>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <SearchInput placeholder="Search sessions (id, user, persona, industry)…" value={search} onChange={setSearch} />
            <select value={diffFilter} onChange={e => setDiffFilter(e.target.value)} style={selectStyle}>
              <option value="all">All Difficulties</option>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
              <option value="Expert">Expert</option>
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
              <option value="timestamp">Sort by Date</option>
              <option value="average_score">Sort by Score</option>
              <option value="total_practice_time">Sort by Time</option>
            </select>
            <button onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')} style={selectStyle}>
              {sortDir === 'asc' ? '↑ Ascending' : '↓ Descending'}
            </button>
            <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{filteredSessions.length} sessions</div>
          </div>
          <div style={tableScrollStyle}>
            <table style={tableStyle}>
              <thead><tr>
                <Th>Session ID</Th>
                <Th>User</Th>
                <Th>Timestamp</Th>
                <Th>Difficulty</Th>
                <Th>Persona</Th>
                <Th align="right">Score</Th>
                <Th align="right">Time</Th>
                <Th align="center" last>Actions</Th>
              </tr></thead>
              <tbody>
                {pagedSessions.map(s => (
                  <tr key={s.session_id} style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <Td>
                      <button onClick={() => setSessionDetail(s)} style={{ background:'none',border:'none',color:'var(--accent-primary-hover)',cursor:'pointer',fontFamily:'monospace',fontSize:'0.8rem',textDecoration:'underline' }}>
                        {s.session_id?.slice(0, 8)}…
                      </button>
                    </Td>
                    <Td><Badge>{s.username}</Badge></Td>
                    <Td>{fmtDate(s.timestamp)}</Td>
                    <Td><Badge color={difficultyColor(s.difficulty_level)}>{s.difficulty_level}</Badge></Td>
                    <Td>{s.client_persona || '—'}</Td>
                    <Td align="right" style={{ color: scoreColor(s.average_score), fontWeight: 700 }}>{s.average_score ?? '—'}</Td>
                    <Td align="right">{fmtTime(s.total_practice_time)}</Td>
                    <Td align="center" last>
                      <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'center' }}>
                        <IconBtn title="View Chat" onClick={() => handleViewChat(s.session_id)}>{Icon.message}</IconBtn>
                        <IconBtn title="Delete" danger onClick={() => handleDeleteSession(s.session_id)}>{Icon.trash}</IconBtn>
                      </div>
                    </Td>
                  </tr>
                ))}
                {filteredSessions.length === 0 && <tr><Td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No sessions found</Td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={sessionsPage} setPage={setSessionsPage} totalItems={filteredSessions.length} pageSize={PAGE_SIZE} />
        </Card>
      )}

      {/* ── Evaluations ── */}
      {!loading && activeTab === 'evaluations' && (
        <Card>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <SearchInput placeholder="Search evaluations (id, user, report text)…" value={evalSearch} onChange={setEvalSearch} />
            <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{filteredEvaluations.length} evaluations</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '1rem' }}>
            {filteredEvaluations.map(e => (
              <div key={e.id} style={{
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Badge>{e.username}</Badge>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{fmtDate(e.timestamp)}</span>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{e.session_id}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                  <span style={{ fontSize: '2rem', fontWeight: 800, color: scoreColor(e.overall_score) }}>{e.overall_score ?? '—'}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>/ 100</span>
                </div>
                {e.dimension_scores && Object.keys(e.dimension_scores).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {Object.entries(e.dimension_scores).slice(0, 4).map(([k, v]) => (
                      <span key={k} style={{ fontSize: '0.7rem', background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary-hover)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>
                        {k}: {v}
                      </span>
                    ))}
                    {Object.keys(e.dimension_scores).length > 4 && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>+{Object.keys(e.dimension_scores).length - 4} more</span>
                    )}
                  </div>
                )}
                <button onClick={() => setEvalModal(e)} style={{
                  marginTop: 'auto', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)',
                  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                }}>View Full Report</button>
              </div>
            ))}
            {filteredEvaluations.length === 0 && (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>No evaluations found</div>
            )}
          </div>
        </Card>
      )}

      {/* ── Conversations ── */}
      {!loading && activeTab === 'conversations' && (
        <Card>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <SearchInput placeholder="Search conversations (session id, user, content)…" value={convSearch} onChange={setConvSearch} />
            <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              {conversationEntries.length} session(s)
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem', alignItems: 'stretch' }}>
            {pagedConversationEntries.map(([sid, grp]) => {
              const lastMsg = grp.messages[grp.messages.length - 1];
              const preview = lastMsg ? (lastMsg.content?.slice(0, 90) + (lastMsg.content?.length > 90 ? '…' : '')) : 'No messages';
              return (
                <button
                className='btnCrds'
                  key={sid}
                  onClick={() => setChatModal({ sessionId: sid, messages: grp.messages })}
                  
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Badge>{grp.username}</Badge>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{grp.messages.length} msgs</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '15px 0px' }}>{sid}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4,margin: '15px 0px', minHeight: '2.5rem', flex: 1 }}>
                    {preview}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 'auto', paddingTop: '0.35rem', borderTop: '1px solid var(--border-default)' }}>
                    Last: {lastMsg ? fmtDate(lastMsg.timestamp) : '—'}
                  </div>
                </button>
              );
            })}
          </div>

          {conversationEntries.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>No conversations found</div>
          )}

          <Pagination page={convPage} setPage={setConvPage} totalItems={conversationEntries.length} pageSize={CONV_PAGE_SIZE} />
        </Card>
      )}
       {!loading && activeTab === 'telemetry' && (
        <Card>
          
<AdminTelemetry
  onOpenTelemetry={(data) => {
    console.log("OPENING", data);

    setTelemetryData(data);
    setTelemetryModal(true);
  }}
/>
         

         
        </Card>
      )}

      {/* ── Modals ── */}
      {evalModal && (
        <Modal title={`Evaluation — ${evalModal.username}`} onClose={() => setEvalModal(null)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '3rem', fontWeight: 800, color: scoreColor(evalModal.overall_score) }}>{evalModal.overall_score}</div>
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Session: <span style={{ fontFamily: 'monospace' }}>{evalModal.session_id}</span></div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{fmtDate(evalModal.timestamp)}</div>
            </div>
          </div>

          {evalModal.dimension_scores && (
            <div style={{ marginBottom: '1.25rem' }}>
              <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>Dimension Scores</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem' }}>
                {Object.entries(evalModal.dimension_scores).map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--bg-surface)', padding: '0.6rem 0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{k}</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: scoreColor(v) }}>{v}</div>
                    <div style={{ height: '4px', background: 'var(--border-default)', borderRadius: '2px', marginTop: '0.35rem', overflow: 'hidden' }}>
                      <div style={{ width: `${clamp(Number(v), 0, 100)}%`, height: '100%', background: scoreColor(v), borderRadius: '2px' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>Report</h4>
            <div style={{
              background: 'var(--bg-surface)', padding: '1rem', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)', color: 'var(--text-secondary)', lineHeight: 1.7, whiteSpace: 'pre-wrap',
            }}>
              {evalModal.report_text}
            </div>
          </div>
        </Modal>
      )}

      {chatModal && (
        <Modal title={`Chat — ${chatModal.sessionId.slice(0, 16)}…`} onClose={() => setChatModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {chatModal.messages.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No messages.</p>}
            {chatModal.messages.map((m, i) => <ChatBubble key={i} msg={m} />)}
          </div>
        </Modal>
      )}

      {sessionDetail && (
        <Modal title="Session Details" onClose={() => setSessionDetail(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
            <DetailItem label="Session ID" value={sessionDetail.session_id} mono />
            <DetailItem label="User" value={sessionDetail.username} />
            <DetailItem label="Created" value={fmtDate(sessionDetail.timestamp)} />
            <DetailItem label="Difficulty" value={sessionDetail.difficulty_level} />
            <DetailItem label="Persona" value={sessionDetail.client_persona || '—'} />
            <DetailItem label="Industry" value={sessionDetail.industry || '—'} />
            <DetailItem label="Company Size" value={sessionDetail.company_size || '—'} />
            <DetailItem label="Score" value={sessionDetail.average_score ?? '—'} color={scoreColor(sessionDetail.average_score)} />
            <DetailItem label="Practice Time" value={fmtTime(sessionDetail.total_practice_time)} />
            <DetailItem label="Document Alignment" value={sessionDetail.document_alignment != null ? `${sessionDetail.document_alignment}%` : '—'} />
          </div>
          {sessionDetail.evaluation && (
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-default)' }}>
              <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Evaluation Snapshot</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
                {sessionDetail.evaluation.dimension_scores && Object.entries(sessionDetail.evaluation.dimension_scores).map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--bg-surface)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{k}</div>
                    <div style={{ fontWeight: 700, color: scoreColor(v) }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button onClick={() => { handleViewChat(sessionDetail.session_id); setSessionDetail(null); }} style={{
              padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)',
              background: 'var(--accent-primary)', color: '#fff', cursor: 'pointer', fontWeight: 600,
            }}>View Chat</button>
            <button onClick={() => { handleDeleteSession(sessionDetail.session_id); setSessionDetail(null); }} style={{
              padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239,68,68,0.4)',
              background: 'rgba(239,68,68,0.1)', color: 'var(--error)', cursor: 'pointer', fontWeight: 600,
            }}>Delete Session</button>
          </div>
        </Modal>
      )}

{telemetryModal && telemetryData && (
  <Modal
    title="Telemetry Details"
    onClose={() => {
      setTelemetryModal(false);
      setTelemetryData(null);
    }}
  >
    <div
  className="telemetry-modal-body"
  style={{
    maxHeight: "65vh",
    overflowY: "auto",
  }}
>
  <table
    style={{
      width: "100%",
      borderCollapse: "collapse",
    }}
  >
    <tbody>
      {[
        ["User", telemetryData.username],
        ["Provider", telemetryData.provider],
        ["Model", telemetryData.model],
        ["Voice", telemetryData.voice_id],
        ["Status", telemetryData.status],
        ["Duration", `${telemetryData.duration_seconds}s`],
        ["Total Tokens", telemetryData.total_tokens],
        ["Prompt Tokens", telemetryData.prompt_tokens],
        ["Completion Tokens", telemetryData.completion_tokens],
        ["Text Input", telemetryData.text_input_tokens],
        ["Text Output", telemetryData.text_output_tokens],
        ["Audio Input", telemetryData.audio_input_tokens],
        ["Audio Output", telemetryData.audio_output_tokens],
        [
          "Total Cost",
          `$${telemetryData.total_cost?.toFixed(6)}`,
        ],
      ].map(([label, value]) => (
        <tr
          key={label}
          style={{
            borderBottom:
              "1px solid var(--border-default)",
          }}
        >
          <td
            style={{
              width: "260px",
              padding: "14px 16px",
              fontWeight: 600,
              background: "var(--bg-surface)",
              color: "var(--text-secondary)",
            }}
          >
            {label}
          </td>

          <td
            style={{
              padding: "14px 16px",
              color: "var(--text-primary)",
            }}
          >
            {value}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>

  </Modal>
)}

    </div>



  );
};

/* ─── small helpers ─── */
const StatCard = ({ label, value, icon, variant }) => (
  <Card style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
    <span className={`card-icon card-icon-square card-icon-${variant}`} style={{ width: '44px', height: '44px', borderRadius: '12px', flexShrink: 0 }}>{icon}</span>
    <div>
      <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{label}</div>
    </div>
  </Card>
);

const UserPhoto = ({ src, name, size = 32 }) => (
  src ? (
    <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  ) : (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
      color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 700,
    }}>{(name || '?').trim().charAt(0).toUpperCase()}</span>
  )
);

const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const AddUserForm = ({ isDev, onAdd }) => {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('user');
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const reset = () => { setEmail(''); setFullName(''); setRole('user'); setPhoto(null); setPreview(''); setFormError(''); };

  const pickPhoto = (file) => {
    setFormError('');
    if (!file) { setPhoto(null); setPreview(''); return; }
    if (!PHOTO_TYPES.includes(file.type)) { setFormError('Choose a PNG, JPEG or WebP image.'); return; }
    if (file.size > PHOTO_MAX_BYTES) { setFormError('The picture must be 2 MB or smaller.'); return; }
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
  };

  const submit = async (e) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) { setFormError('Enter a valid email address.'); return; }
    setSaving(true); setFormError('');
    try {
      await onAdd({ email: cleanEmail, full_name: fullName.trim(), role, photo });
      reset(); setOpen(false);
    } catch (err) {
      setFormError(err.message || 'Could not add the user.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>+ Add user</button>
      </div>
    );
  }

  const field = { display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flex: '1 1 200px' };
  const input = { ...selectStyle, cursor: 'text' };
  return (
    <form onSubmit={submit} style={{
      border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: '1rem',
      marginBottom: '1rem', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: '0.85rem',
    }}>
      <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Add user</div>
      <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
        <label style={field}>Email
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" style={input} />
        </label>
        <label style={field}>Full name
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full name" style={input} />
        </label>
        <label style={{ ...field, flex: '0 1 160px' }}>Role
          <select value={role} onChange={e => setRole(e.target.value)} style={selectStyle}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
            {isDev && <option value="developer">Developer</option>}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <UserPhoto src={preview} name={fullName || email} size={48} />
        <label style={{ ...selectStyle, display: 'inline-block' }}>
          {photo ? 'Change profile picture' : 'Upload profile picture'}
          <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={e => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {photo && <button type="button" onClick={() => pickPhoto(null)} style={{ ...selectStyle, background: 'transparent' }}>Remove</button>}
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Optional · shown at the top right when they sign in · PNG, JPEG or WebP, up to 2 MB</span>
      </div>
      {formError && <div role="alert" style={{ color: 'var(--error)', fontSize: '0.8rem' }}>{formError}</div>}
      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => { reset(); setOpen(false); }} style={{ ...selectStyle, background: 'transparent' }} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add user'}</button>
      </div>
    </form>
  );
};

const SearchInput = ({ placeholder, value, onChange }) => (
  <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
    <span style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.9rem' }}>🔍</span>
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '0.55rem 0.75rem 0.55rem 2rem', borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-default)', background: 'var(--bg-input)', color: 'var(--text-primary)',
        fontSize: '0.85rem', outline: 'none',
      }}
    />
  </div>
);

const ChatBubble = ({ msg }) => {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '80%', padding: '0.7rem 1rem', borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isUser ? 'var(--accent-primary)' : 'var(--bg-surface)',
        color: isUser ? '#fff' : 'var(--text-primary)',
        fontSize: '0.85rem', lineHeight: 1.5, border: isUser ? 'none' : '1px solid var(--border-default)',
        whiteSpace: 'pre-wrap',
      }}>
        <div style={{ fontSize: '0.65rem', opacity: 0.7, marginBottom: '0.25rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {msg.role}
        </div>
        {msg.content}
        <div style={{ fontSize: '0.65rem', opacity: 0.5, marginTop: '0.35rem', textAlign: 'right' }}>
          {fmtDate(msg.timestamp)}
        </div>
      </div>
    </div>
  );
};

const DetailItem = ({ label, value, mono, color }) => (
  <div style={{ background: 'var(--bg-surface)', padding: '0.6rem 0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)' }}>
    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    <div style={{ fontSize: '0.9rem', fontWeight: 600, color: color || 'var(--text-primary)', fontFamily: mono ? 'monospace' : undefined }}>{value}</div>
  </div>
);

const difficultyColor = (d) => {
  if (d === 'Easy') return 'var(--success)';
  if (d === 'Medium') return 'var(--warning)';
  if (d === 'Hard') return '#f97316';
  if (d === 'Expert') return 'var(--error)';
  return 'var(--text-muted)';
};

/* table styles */
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' };
const tableScrollStyle = { overflow: 'auto', maxHeight: '520px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' };
const Th = ({ children, align, last }) => (
  <th style={{
    padding: '0.7rem 0.8rem', textAlign: align || 'left', color: 'var(--text-secondary)', fontWeight: 600,
    borderBottom: '1px solid var(--border-strong)', borderRight: last ? 'none' : '1px solid var(--border-default)',
    whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1,
  }}>{children}</th>
);
const Td = ({ children, align, colSpan, last, style: extra }) => (
  <td colSpan={colSpan} style={{
    padding: '0.6rem 0.8rem', textAlign: align || 'left', color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-default)', borderRight: last ? 'none' : '1px solid var(--border-default)',
    ...extra,
  }}>{children}</td>
);

/* pagination */
const Pagination = ({ page, setPage, totalItems, pageSize }) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalItems === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(totalItems, page * pageSize);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', padding: '0.75rem 0.1rem 0' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Showing {from}–{to} of {totalItems}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          disabled={page <= 1}
          onClick={() => setPage(p => Math.max(1, p - 1))}
          style={{ ...selectStyle, opacity: page <= 1 ? 0.5 : 1, cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
        >‹ Prev</button>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Page {page} / {totalPages}</span>
        <button
          disabled={page >= totalPages}
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          style={{ ...selectStyle, opacity: page >= totalPages ? 0.5 : 1, cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
        >Next ›</button>
      </div>
    </div>
  );
};

const selectStyle = {
  padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)',
  background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer', outline: 'none',
};

export default Admin;
