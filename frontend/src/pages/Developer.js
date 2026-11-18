import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { getDeveloperDiagnostics, checkHealth, getAllUsers, updateUserRole } from '../services/api';

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

const Developer = () => {
  const { user, role, isAdmin, isDeveloper } = useAuth();
  const [diagnostics, setDiagnostics] = useState(null);
  const [healthStatus, setHealthStatus] = useState(null);
  const [users, setUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [userLoading, setUserLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchUsers = async () => {
    setUserLoading(true);
    try {
      const data = await getAllUsers();
      setUsers(data || []);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setUserLoading(false);
    }
  };

  const fetchDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      const [diagData, healthData, usersData] = await Promise.all([
        getDeveloperDiagnostics().catch((err) => ({ error: err.message })),
        checkHealth().catch((err) => ({ error: err.message })),
        getAllUsers().catch(() => []),
      ]);
      setDiagnostics(diagData);
      setHealthStatus(healthData);
      setUsers(usersData || []);
      setLastRefreshed(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err.message || 'Failed to fetch developer diagnostics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiagnostics();
  }, []);

  const handleRoleChange = async (email, newRole) => {
    try {
      await updateUserRole(email, newRole);
      setToast({ msg: `Successfully updated ${email} to ${newRole}`, type: 'success' });
      await fetchUsers();
    } catch (err) {
      setToast({ msg: err.message || 'Failed to update user role', type: 'error' });
    }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase().trim();
    if (!q) return users;
    return users.filter(u =>
      (u.email || '').toLowerCase().includes(q) ||
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.role || '').toLowerCase().includes(q)
    );
  }, [users, userSearch]);

  return (
    <div style={{ padding: '1.5rem 2rem', maxWidth: '1200px', margin: '0 auto' }}>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🛠️</span> Developer Diagnostics & Telemetry
          </h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Inspect runtime configurations, realtime voice telemetry, and system health.
          </p>
        </div>
        <button
          onClick={fetchDiagnostics}
          style={{
            padding: '0.55rem 1rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-default)',
            background: 'var(--accent-primary)',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--error)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', border: '1px solid rgba(239,68,68,0.25)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
        {/* User Context Card */}
        <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', color: 'var(--text-primary)' }}>👤 Current Session Role</h3>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Email:</strong> {user?.email}</p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Full Name:</strong> {user?.full_name || '—'}</p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}>
            <strong>Assigned Role:</strong>{' '}
            <span style={{
              padding: '0.2rem 0.6rem',
              borderRadius: '999px',
              fontSize: '0.75rem',
              fontWeight: 700,
              background: 'rgba(99,102,241,0.15)',
              color: 'var(--accent-primary-hover)',
              textTransform: 'uppercase',
            }}>
              {role}
            </span>
          </p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Admin Privileges:</strong> {isAdmin ? '✅ Yes' : '❌ No'}</p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Developer Privileges:</strong> {isDeveloper ? '✅ Yes' : '❌ No'}</p>
        </div>

        {/* System Health Card */}
        <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', color: 'var(--text-primary)' }}>⚡ API & Service Health</h3>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}>
            <strong>Status:</strong>{' '}
            <span style={{ color: healthStatus?.status === 'ok' || healthStatus?.status === 'healthy' ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
              {healthStatus?.status || (healthStatus?.error ? 'Error' : 'Connecting...')}
            </span>
          </p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Last Checked:</strong> {lastRefreshed || '—'}</p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}>
            <strong>WebSocket Auth:</strong> {diagnostics?.config?.ws_token_configured ? 'Configured' : 'Default / None'}
          </p>
        </div>

        {/* Runtime Model Configuration */}
        <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', color: 'var(--text-primary)' }}>🤖 AI Models & Voice Engine</h3>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Evaluation Model:</strong> {diagnostics?.config?.llm_model || '—'}</p>
          <p style={{ margin: '0.4rem 0', color: 'var(--text-secondary)' }}><strong>Voice ID:</strong> {diagnostics?.config?.nova_voice_id || '—'}</p>
        </div>
      </div>

      {/* Global Realtime Telemetry Stats */}
      <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', color: 'var(--text-primary)' }}>📊 Realtime Voice Audio Telemetry</h3>
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading telemetry data...</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
            <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sessions Started</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {diagnostics?.global_stats?.sessions_started ?? 0}
              </div>
            </div>
            <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Sessions Completed</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {diagnostics?.global_stats?.sessions_ended ?? 0}
              </div>
            </div>
            <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Audio In (KB)</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {diagnostics?.global_stats?.total_audio_bytes_in ? (diagnostics.global_stats.total_audio_bytes_in / 1024).toFixed(1) : '0'}
              </div>
            </div>
            <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Audio Out (KB)</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {diagnostics?.global_stats?.total_audio_bytes_out ? (diagnostics.global_stats.total_audio_bytes_out / 1024).toFixed(1) : '0'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* User Role Management (Developer Access) */}
      <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>👥</span> User Management & Role Assignment
            </h3>
            <p style={{ margin: '0.2rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Assign developer, admin, or user roles to any system account.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <div style={{ position: 'relative', minWidth: '220px' }}>
              <span style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>🔍</span>
              <input
                type="text"
                placeholder="Search users..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.45rem 0.65rem 0.45rem 1.85rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />
            </div>
            <button
              onClick={fetchUsers}
              disabled={userLoading}
              style={{
                padding: '0.45rem 0.8rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {userLoading ? 'Refreshing...' : 'Refresh Users'}
            </button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-strong)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                <th style={{ padding: '0.6rem 0.8rem' }}>Email</th>
                <th style={{ padding: '0.6rem 0.8rem' }}>Full Name</th>
                <th style={{ padding: '0.6rem 0.8rem' }}>Current Role</th>
                <th style={{ padding: '0.6rem 0.8rem' }}>Assign Role</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.email} style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <td style={{ padding: '0.6rem 0.8rem', color: 'var(--text-primary)', fontWeight: 600 }}>{u.email}</td>
                  <td style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)' }}>{u.full_name || '—'}</td>
                  <td style={{ padding: '0.6rem 0.8rem' }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '0.2rem 0.6rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: u.role === 'developer' ? 'rgba(234,179,8,0.15)' : u.role === 'admin' ? 'rgba(99,102,241,0.15)' : 'rgba(148,163,184,0.15)',
                      color: u.role === 'developer' ? 'var(--warning)' : u.role === 'admin' ? 'var(--accent-primary-hover)' : 'var(--text-muted)',
                      border: `1px solid ${u.role === 'developer' ? 'rgba(234,179,8,0.3)' : u.role === 'admin' ? 'rgba(99,102,241,0.3)' : 'var(--border-default)'}`,
                      textTransform: 'uppercase',
                    }}>
                      {u.role || 'user'}
                    </span>
                  </td>
                  <td style={{ padding: '0.6rem 0.8rem' }}>
                    <select
                      value={u.role || 'user'}
                      onChange={(e) => handleRoleChange(u.email, e.target.value)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-input)',
                        color: 'var(--text-primary)',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                      <option value="developer">Developer</option>
                    </select>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Raw Diagnostic Dump */}
      <div className="card" style={{ padding: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: 'var(--text-primary)' }}>🔍 Raw Diagnostics Payload</h3>
        <pre style={{
          background: 'var(--bg-primary)',
          padding: '1rem',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.8rem',
          overflowX: 'auto',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-default)',
        }}>
          {JSON.stringify({ diagnostics, healthStatus }, null, 2)}
        </pre>
      </div>
    </div>
  );
};

export default Developer;
