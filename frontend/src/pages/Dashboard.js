import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { getStatistics, getSessions, getSessionScores, getClarityData, createSession, saveEvaluation, generateFullReport, getSampleBetterResponses } from '../services/api.js';
import { useAuth } from '../context/AuthContext';
import useSessionStore from '../store/sessionStore';
const SCORE_RANGES = [5, 10, 20, 50];

const Dashboard = () => {
  const { user } = useAuth();
  const userEmail = user?.email || 'anonymous';
  const navigate = useNavigate();
  const setSession = useSessionStore(state => state.setSession);
  const setEvaluationResult = useSessionStore(state => state.setEvaluationResult);

  const testEvaluateMutation = useMutation({
    mutationFn: async () => {
      const sessionId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const sessionData = {
        session_id: sessionId,
        timestamp,
        difficulty_level: 'Medium',
        client_persona: 'CTO - Chief Technology Officer',
        industry: 'Technology / SaaS',
        company_size: 'Mid-market (500-999 employees)',
        document_alignment: null,
        average_score: null,
      };

      // Create the session in the backend first
      await createSession(sessionData);

      // Send sample conversation data to the backend for AI evaluation
      const evalPayload = {
        persona: 'CTO - Chief Technology Officer',
        pitch_deck: 'Cloud-based enterprise analytics platform with real-time dashboards, AI-powered insights, and seamless integration with existing data warehouses. Pricing starts at $2,500/month for up to 50 users. Key differentiators: sub-second query performance, SOC 2 Type II certified, 99.99% uptime SLA.',
        speech: `Sales Rep: Good morning, thanks for taking the time to meet today. I know your team is evaluating analytics solutions, so I wanted to walk you through how our platform can help.

CTO: Yes, we've been looking at a few options. Our current setup is a mess — we have data sitting in three different warehouses and our BI team spends more time wrangling than analyzing.

Sales Rep: That's actually the number one reason companies switch to us. Our platform connects to all major data warehouses — Snowflake, BigQuery, Redshift — and gives you a unified view in under an hour of setup. One of our customers, a fintech firm about your size, cut their reporting time from two weeks to same-day after deploying.

CTO: Interesting. How do you handle data security? We're SOC 2 and have some pretty strict compliance requirements around PII.

Sales Rep: Absolutely. We're SOC 2 Type II certified ourselves, and we offer role-based access controls, column-level masking for PII, and full audit logging. All data is encrypted at rest and in transit.

CTO: What about performance? Our largest table has about 2 billion rows.

Sales Rep: Our query engine is designed for that scale. We use a combination of in-memory processing and intelligent pre-aggregation. Typical dashboard loads are under a second even on billion-row datasets. I can set up a proof of concept on your own data so you can see the performance firsthand.

CTO: And pricing? We've been burned before by vendors that start cheap and then jack up the price at renewal.

Sales Rep: Completely understand that concern. Our pricing is transparent — $2,500 per month for up to 50 users, flat. No hidden fees, no per-query charges, and we lock in your rate for two years. If you need more users, it's a predictable tiered model, not a surprise.

CTO: Hmm. What about vendor lock-in? If we decide to move off your platform, how painful is that?

Sales Rep: That's a fair question. All your dashboards and reports can be exported as standard SQL or Python notebooks. Your data never leaves your warehouse — we connect to it, we don't store it. So migrating away is straightforward.

CTO: I'd like to think about this. Can you send over the SOC 2 documentation and a pricing breakdown?

Sales Rep: Of course, I'll have that in your inbox by end of day. When would be a good time to follow up? Maybe we can schedule that proof of concept for next week?

CTO: Let me check with my team and I'll get back to you.

Sales Rep: Sounds great. One last thing — if it helps, I can also connect you with that fintech customer I mentioned. They were in a similar situation and would be happy to share their experience.

CTO: That could be useful. Send me their contact too.

Sales Rep: Will do. Thanks again for your time, I'll follow up with everything we discussed.`,
        industry: 'Technology / SaaS',
        company_size: 'Mid-market (500-999 employees)'
      };

      const [reportResult, betterResponsesResult] = await Promise.all([
        generateFullReport(evalPayload),
        getSampleBetterResponses(evalPayload).catch(err => {
          console.warn('Failed to generate sample better responses:', err);
          return { better_responses: [] };
        })
      ]);

      const betterResponses = betterResponsesResult?.better_responses || betterResponsesResult?.better_resposed || [];
      const combinedReport = {
        ...(reportResult.report || {}),
        better_responses: betterResponses
      };

      // Save the evaluation result from the backend
      await saveEvaluation({
        session_id: sessionId,
        overall_score: reportResult.score || 0,
        report_text: JSON.stringify(combinedReport),
        dimension_scores: reportResult.dimensions || {},
        timestamp,
        total_practice_time: 300
      });

      return { sessionId, sessionData, reportResult, combinedReport, betterResponses };
    },
    onSuccess: ({ sessionId, sessionData, reportResult, combinedReport, betterResponses }) => {
      setSession({ ...sessionData, average_score: reportResult.score || 0 });
      setEvaluationResult({
        sessionId,
        score: reportResult.score,
        report: combinedReport,
        dimensions: reportResult.dimensions,
        better_responses: betterResponses
      });
      navigate('/evaluation');
    }
  });

  // Use React Query to fetch all dashboard data in parallel
  // queryKey includes username so cache is per-user, preventing cross-user data leaks
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', userEmail],
    queryFn: async () => {
      const [statsData, sessionsData, clarity, trendSessions] = await Promise.all([
        getStatistics(),
        getSessions({ limit: 4 }),
        getClarityData(),
        getSessions({ limit: 60 })
      ]);
      return {
        statistics: statsData,
        recentSessions: sessionsData,
        clarityData: clarity,
        trendSessions
      };
    },
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
    refetchOnWindowFocus: false,
  });

  const { statistics, recentSessions, clarityData, trendSessions } = data || {};

  // Score Progression has its own query so changing the range reloads only the chart.
  const [scoreRange, setScoreRange] = useState(10);
  const {
    data: sessionScores,
    isLoading: scoresLoading,
    isFetching: scoresFetching,
    error: scoresError,
  } = useQuery({
    queryKey: ['dashboard', userEmail, 'scores', scoreRange],
    queryFn: () => getSessionScores({ limit: scoreRange }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData, // keep the old bars on screen while the new range loads
  });
  // Oldest on the left so the chart reads as progress over time.
  const chartPoints = [...(sessionScores || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  const [hoveredBar, setHoveredBar] = useState(null);
  // Every label fits up to 10 bars; beyond that, label every n-th bar so dates don't overlap.
  const labelEvery = Math.max(1, Math.ceil(chartPoints.length / 10));

  // Compares this rolling 7-day window against the prior one; returns null when there's nothing to compare against
  const computeTrend = (sessions, valueFn) => {
    if (!sessions || sessions.length === 0) return null;
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeek = [];
    const lastWeek = [];
    sessions.forEach((s) => {
      const t = new Date(s.timestamp).getTime();
      const diff = now - t;
      if (diff >= 0 && diff < weekMs) thisWeek.push(s);
      else if (diff >= weekMs && diff < weekMs * 2) lastWeek.push(s);
    });
    if (lastWeek.length === 0) return null;
    const avg = (arr) => arr.reduce((sum, s) => sum + (valueFn(s) || 0), 0) / arr.length;
    const lastAvg = avg(lastWeek);
    if (!lastAvg) return null;
    const thisAvg = thisWeek.length > 0 ? avg(thisWeek) : 0;
    return Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
  };

  const scoreTrend = computeTrend(trendSessions, (s) => s.average_score);
  const timeTrend = computeTrend(trendSessions, (s) => s.total_practice_time);
  const sessionsTrend = (() => {
    if (!trendSessions || trendSessions.length === 0) return null;
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    let thisWeek = 0, lastWeek = 0;
    trendSessions.forEach((s) => {
      const diff = now - new Date(s.timestamp).getTime();
      if (diff >= 0 && diff < weekMs) thisWeek += 1;
      else if (diff >= weekMs && diff < weekMs * 2) lastWeek += 1;
    });
    if (lastWeek === 0) return null;
    return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  })();

  // Renders a "+12% from last week" style pill; omitted entirely when there's no prior-week data to compare
  const TrendBadge = ({ value }) => {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    const positive = value >= 0;
    return (
      <span className={`trend-badge ${positive ? 'trend-up' : 'trend-down'}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {positive ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
        </svg>
        {positive ? '+' : ''}{value}% from last week
      </span>
    );
  };


  // Format time from seconds to hours and minutes
  const formatTime = (totalSeconds) => {
    if (!totalSeconds) return '0h 0m';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  // Calculate stroke dash offset for circular progress (circumference = 2 * PI * 54 ≈ 339.3)
  const getStrokeDashoffset = (score) => {
    const radius = 54;
    const circumference = 2 * Math.PI * radius;
    const normalizedScore = Math.min(100, Math.max(0, score || 0));
    return circumference - (normalizedScore / 100) * circumference;
  };

  // Format date for display
  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hr ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  if (error) {
    return (
      <div className="state-panel state-panel-error" role="alert">
        <div>
          <div className="state-panel-title">
            ⚠️ {error.message || 'Failed to load dashboard data'}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => refetch()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="premium-dashboard sc-remix-dashboard-page">
      <div className="dashboard-welcome-banner">
        <div className="dashboard-welcome-icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>
        </div>
        <div>
          <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.15rem', color: 'var(--text-primary)' }}>
            Welcome back{user?.full_name ? `, ${user.full_name}` : ''}!
          </h2>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            KCoach is ready. Start a new practice session to sharpen your skills.
          </p>
        </div>
        <button
          className="btn btn-primary dashboard-cta-btn mini-radius"
          onClick={() => navigate('/setup')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start Sessio
        </button>
         <button
          className="btn btn-primary"
          onClick={() => testEvaluateMutation.mutate()}
          disabled={testEvaluateMutation.isPending}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.8rem',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            marginLeft: '1rem'
          }}
        >
          {testEvaluateMutation.isPending ? 'Running...' : 'Test Evaluate'}
        </button> 
      </div>

      <div className="dashboard-grid">

      <div className="dashboard-row dashboard-row-top">
        {/* Total Practice Time Card */}
        <div className="card practice-time-card ">
          <div className="dash-card-top">
            <h3 className="card-title"><span className="card-icon card-icon-teal card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>Total Practice Time</h3>
          </div>
          <div className="large-value">{isLoading ? '...' : formatTime(statistics?.total_practice_time)}</div>
          <div className="dash-card-bottom">
            <TrendBadge value={timeTrend} />
            <span className="dash-card-sub">{isLoading ? '' : `${statistics?.total_sessions || 0} sessions`}</span>
          </div>
        </div>

        {/* Average Score Card */}
        <div className="card score-card score-card-inline">
          
          <div className="score-card-body">
            <div className="speedometer-container">
              <svg viewBox="0 0 120 120" className="speedometer-svg">
                {/* Background circle - full circle circumference = 2*PI*54 ≈ 339.3 */}
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  stroke="#e2e8f0"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray="339.3"
                  strokeDashoffset="0"
                  transform="rotate(135 60 60)"
                />
                {/* Score arc */}
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  className={isLoading ? 'score-arc score-arc-loading' : `score-arc ${
                    (statistics?.average_score || 0) >= 80 ? 'score-arc-good' : (statistics?.average_score || 0) >= 60 ? 'score-arc-mid' : 'score-arc-low'
                  }`}
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray="339.3"
                  strokeDashoffset={isLoading ? '339.3' : getStrokeDashoffset(statistics?.average_score)}
                  transform="rotate(135 60 60)"
                />
                {/* Score text */}
                <text
                  x="60"
                  y="65"
                  textAnchor="middle"
                  className="speedometer-value"
                >
                  {isLoading ? '...' : Math.round(statistics?.average_score || 0)}
                </text>
                <text
                  x="60"
                  y="80"
                  textAnchor="middle"
                  className="speedometer-label"
                >
                  out of 100
                </text>
              </svg>
            </div>
            <div className="score-card-text text-align-right">
              <h3 className="card-title"><span className="card-icon card-icon-orange card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>Average Score</h3>
              <p className="score-label">Your Practice Score</p>
              <p className="score-sub">
                {isLoading ? '' : `${statistics?.total_sessions || 0} sessions completed`}
              </p>
              <TrendBadge value={scoreTrend} />
            </div>
          </div>
        </div>

        {/* Practice Sessions Card */}
        <div className="card stat-card">
          
          <h3 className="card-title"><span className="card-icon card-icon-purple card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>Practice Sessions</h3>
          <div className="large-value">{isLoading ? '...' : statistics?.total_sessions || 0}</div>
          <div className="dash-card-bottom">
            
            <span className="dash-card-sub">Total completed</span>
          </div>
        </div>

        {/* Clarity Score Card */}
        <div className="card stat-card">
          <h3 className="card-title"><span className="card-icon card-icon-pink card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></span>Clarity Score</h3>
          <div className="large-value">{isLoading ? '...' : clarityData?.latest ? `${Math.round(clarityData.latest)}` : 'N/A'}</div>
          <div className="dash-card-bottom">
            <span className="dash-card-sub">{isLoading ? '' : clarityData?.average ? `Avg: ${Math.round(clarityData.average)}` : 'No data yet'}</span>
          </div>
        </div>
      </div>

      <div className="dashboard-row dashboard-row-bottom">
      <div className="dashboard-col dashboard-col-center">
        {/* Score Progression Graph Card */}
        <div className="card graph-card">
          <div className="graph-header">
            <h3 className="card-title"><span className="card-icon card-icon-teal card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></span>Score Progression</h3>
            <select
              className="dropdown-btn"
              aria-label="Sessions shown in the score chart"
              value={scoreRange}
              onChange={(e) => setScoreRange(Number(e.target.value))}
              style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }}
            >
              {SCORE_RANGES.map((n) => (
                <option key={n} value={n}>Last {n} Sessions</option>
              ))}
            </select>
          </div>
          {scoresLoading ? (
            <div className="state-panel state-panel-muted">Loading graph...</div>
          ) : scoresError ? (
            <div className="state-panel state-panel-muted">Could not load scores. {scoresError.message || ''}</div>
          ) : sessionScores && sessionScores.length > 0 ? (
            <div className="graph-container" style={{ opacity: scoresFetching ? 0.6 : 1, transition: 'opacity 0.2s', paddingBottom: '24px' }}>
              {/* minHeight: on narrow screens the container's height is auto, so height:100% alone collapses to 0 */}
              <div className="graph-grid" style={{ minHeight: '180px' }} onMouseLeave={() => setHoveredBar(null)}>
                {/* Scale and dates are placed with the same percentages as the bars, so they line up exactly */}
                {[0, 20, 40, 60, 80, 100].map((tick) => (
                  <React.Fragment key={tick}>
                    <span style={{ position: 'absolute', left: '-30px', width: '24px', textAlign: 'right', bottom: `${tick}%`, transform: 'translateY(50%)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {tick}
                    </span>
                    {tick > 0 && (
                      <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: `${tick}%`, borderTop: '1px dashed var(--border-default)', opacity: 0.5 }} />
                    )}
                  </React.Fragment>
                ))}
                {chartPoints.map((point, idx) => {
                  const score = Math.round(point.score);
                  const left = `${((idx + 1) / (chartPoints.length + 1)) * 100}%`;
                  const when = new Date(point.date);
                  const label = `Score ${score} · ${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
                  return (
                    <React.Fragment key={idx}>
                      <div
                        className="graph-bar"
                        tabIndex={0}
                        aria-label={label}
                        onMouseEnter={() => setHoveredBar(idx)}
                        onFocus={() => setHoveredBar(idx)}
                        onBlur={() => setHoveredBar(null)}
                        style={{
                          left: left,
                          height: `${Math.max(2, score)}%`, // a sliver stays visible for very low scores
                          width: `min(30px, ${60 / (chartPoints.length + 1)}%)`, // narrower bars when many are shown
                          // centre on `left`: the bar's draw animation replaces its translateX(-50%) transform
                          marginLeft: `calc(-1 * min(15px, ${30 / (chartPoints.length + 1)}%))`,
                          cursor: 'pointer',
                          outline: 'none',
                          filter: hoveredBar === idx ? 'brightness(1.25)' : undefined,
                        }}
                      ></div>
                      {hoveredBar === idx && (
                        <div role="tooltip" style={{
                          position: 'absolute', left, bottom: `calc(${Math.max(2, score)}% + 8px)`, transform: 'translateX(-50%)',
                          whiteSpace: 'nowrap', padding: '4px 8px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                          background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-default)',
                          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)', pointerEvents: 'none', zIndex: 2,
                        }}>
                          {label}
                        </div>
                      )}
                      {idx % labelEvery === 0 && (
                        <span style={{ position: 'absolute', left, top: 'calc(100% + 6px)', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="state-panel state-panel-muted">
              No score data available yet. Complete practice sessions to see your progress.
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-col dashboard-col-right">
          {/* Recent Sessions Card */}
        <div className="card recent-sessions">
          <div className="dash-card-top">
            <h3 className="card-title"><span className="card-icon card-icon-blue card-icon-square"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg></span>Recent Sessions</h3>
            <a className="see-more" href="/history">See more</a>
          </div>
          <div className="session-list" aria-live="polite">
            {isLoading ? (
              <div className="state-inline">Loading sessions...</div>
            ) : recentSessions && recentSessions.length > 0 ? (
              recentSessions.map((session, idx) => {
                const evaluated = !!(session.evaluation || session.average_score); // same rule as Practice History
                const score = session.average_score ? Math.round(session.average_score) : 0;
                const scoreClass = score >= 80 ? 'session-score-good' : score >= 60 ? 'session-score-mid' : 'session-score-low';
                return (
                <div
                  className="session-item"
                  key={session.session_id || idx}
                  role="button"
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                  aria-label={`Open ${session.client_persona || 'session'} in Practice History`}
                  onClick={() => navigate(`/history?session=${encodeURIComponent(session.session_id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/history?session=${encodeURIComponent(session.session_id)}`);
                    }
                  }}
                >
                  {evaluated ? (
                    <div className={`session-score ${scoreClass}`}>{score}</div>
                  ) : (
                    <div
                      className="session-score"
                      title="Not evaluated"
                      aria-label="Not evaluated"
                      style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)', border: '1px solid var(--border-default)', boxShadow: 'none' }}
                    >
                      —
                    </div>
                  )}
                  <div className="session-details">
                    <h4>{session.client_persona || 'Unknown Session'}</h4>
                    <p>{session.difficulty_level || 'Medium'} Mode | {session.industry || 'N/A'} | {formatDate(session.timestamp)}{evaluated ? '' : ' | Not evaluated'}</p>
                  </div>
                  <span className="session-arrow">›</span>
                </div>
                );
              })
            ) : (
              <div className="state-inline">No practice sessions yet</div>
            )}
          </div>
        </div>
      </div>
      </div>

      </div>
    </div>
  );
};

export default Dashboard;
