import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ReactComponent as LogoWhite } from '../sc_logo_white.svg';
import { ReactComponent as LogoLight } from '../sc_logo_light.svg';
import kpmgLogo from '../KPMG.png';
const Login = () => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, logout } = useAuth();
  const navigate = useNavigate();

  // Clear any stale tokens when the login page mounts.
  // This ensures a previously cached session doesn't leak into a new user's session.
  useEffect(() => {
    logout();
  }, [logout]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    setLoading(true);
    try {
      await login(trimmedEmail);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message || 'Access denied. Your email is not authorized.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-bg-decoration">
        <div className="auth-bg-circle auth-bg-circle-1" />
        <div className="auth-bg-circle auth-bg-circle-2" />
        <div className="auth-bg-circle auth-bg-circle-3" />
        <div className="auth-bg-grid" />
      </div>

      <div className="auth-container">
        <div className="auth-logo">
          <img src={kpmgLogo} alt="KPMG" />
        </div>
        <div className="auth-header">
          <h1>KCoach</h1>
          <p>AI-Powered Training Platform</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" aria-busy={loading}>
          {error && (
            <div className="auth-error" role="alert" id="login-error">
              <span className="auth-error-icon">⚠️</span> {error}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && email && !email.includes('@')) {
                  e.preventDefault();
                  setEmail(email + '@kpmg.com');
                }
              }}
              placeholder="Enter your username (press Tab for @kpmg.com)"
              autoComplete="email"
              autoFocus
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-auth"
            disabled={loading}
            aria-disabled={loading}
          >
            {loading ? (
              <span className="btn-loading">
                <span className="spinner" /> Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>

          <div className="auth-divider">
            <span>or continue with</span>
          </div>

          <div className="auth-sso-group">
            <button
              type="button"
              className="btn-sso"
              disabled
              title="SSO login coming soon"
            >
              <span className="btn-sso-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path fill="#f25022" d="M2 2h9.5v9.5H2z" />
                  <path fill="#7fba00" d="M12.5 2H22v9.5h-9.5z" />
                  <path fill="#00a4ef" d="M2 12.5h9.5V22H2z" />
                  <path fill="#ffb900" d="M12.5 12.5H22V22h-9.5z" />
                </svg>
              </span>
              Sign in with Microsoft SSO
            </button>

            
          </div>

          <div className="auth-footer">
            <p className="auth-footer-text">
              Access is restricted to authorized users only.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
