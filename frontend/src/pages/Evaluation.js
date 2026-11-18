import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import useSessionStore from '../store/sessionStore';
import { translateReport, loadLatestSavedReport } from '../services/api';
import { exportReportPdf } from '../services/reportPdf';
import '../styles/evaluation-page.css';
// Regional Indian languages (other than Hindi) are hidden for now; translation still supports them.
const SHOW_REGIONAL_LANGUAGES = false;
const REGIONAL_LANGUAGES = ['gu', 'mr', 'ta', 'te', 'bn', 'kn', 'ml', 'pa'];
const ALL_REPORT_LANGUAGES = [
  ['en', 'English'],
  ['hi', 'Hindi (हिन्दी)'],
  ['gu', 'Gujarati (ગુજરાતી)'],
  ['mr', 'Marathi (मराठी)'],
  ['ta', 'Tamil (தமிழ்)'],
  ['te', 'Telugu (తెలుగు)'],
  ['bn', 'Bengali (বাংলা)'],
  ['kn', 'Kannada (ಕನ್ನಡ)'],
  ['ml', 'Malayalam (മലയാളം)'],
  ['pa', 'Punjabi (ਪੰਜਾਬੀ)'],
  ['fr', 'French (Français)'],
  ['de', 'German (Deutsch)'],
  ['es', 'Spanish (Español)'],
  ['it', 'Italian (Italiano)'],
];
const REPORT_LANGUAGES = ALL_REPORT_LANGUAGES.filter(
  ([code]) => SHOW_REGIONAL_LANGUAGES || !REGIONAL_LANGUAGES.includes(code)
);

const Evaluation = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const storedEvaluation = useSessionStore(state => state.evaluationResult);
  const currentSession = useSessionStore(state => state.currentSession);
  const clearSession = useSessionStore(state => state.clearSession);
  const audioRecordingUrl = useSessionStore(state => state.audioRecordingUrl);
  // The report is generated in English; other languages are translated on demand and kept per session.
  const [reportLanguage, setReportLanguage] = useState('en');
  const [translations, setTranslations] = useState({});
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState('');
  
  // Which report to show: one opened from Practice History, else the session just evaluated,
  // else the latest saved report (the browser copy is cleared at login and at each new setup).
  const historyReport = location.state?.savedReport || null;
  const justEvaluated = storedEvaluation
    && currentSession
    && storedEvaluation.sessionId === currentSession.session_id
    ? storedEvaluation : null;
  const [latestReport, setLatestReport] = useState(null);
  const [latestStatus, setLatestStatus] = useState('idle'); // idle | loading | done | error
  const needsLatest = !historyReport && !justEvaluated;

  useEffect(() => {
    if (!needsLatest) return undefined;
    let cancelled = false;
    setLatestStatus('loading');
    loadLatestSavedReport()
      .then((report) => { if (!cancelled) { setLatestReport(report); setLatestStatus('done'); } })
      .catch(() => { if (!cancelled) setLatestStatus('error'); });
    return () => { cancelled = true; };
  }, [needsLatest]);

  const evaluationData = historyReport || justEvaluated || latestReport;
  const isValidEvaluation = !!evaluationData;

  if (!isValidEvaluation && needsLatest && (latestStatus === 'idle' || latestStatus === 'loading')) {
    return (
      <div style={{ padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading your latest report…
      </div>
    );
  }

  // If no valid evaluation data, show info message
  if (!isValidEvaluation) {
    return (
      <div style={{
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%'
      }}>
        <span style={{
          width: '64px', height: '64px', marginBottom: '16px', borderRadius: '16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)',
          color: 'var(--accent-primary)',
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '8px' }}>
          {latestStatus === 'error' ? 'Could not load your latest report' : 'No evaluation yet'}
        </div>
        <div style={{ fontSize: '16px', color: 'var(--text-muted)', marginBottom: '24px' }}>
          {latestStatus === 'error'
            ? 'Please check your connection and try again, or open a past report from Practice History.'
            : 'Finish a session with Stop & Evaluate and your report will appear here.'}
        </div>
        <button
          onClick={() => navigate('/setup')}
          className="btn btn-primary "
        >
          Start New Session
        </button>
        
      </div>
    );
  }

  // Parse dimensions from the API response
  const dimensions = evaluationData?.dimensions 
    ? Object.entries(evaluationData.dimensions).map(([name, score]) => ({
        name,
        score: typeof score === 'number' ? score : parseInt(score) || 0
      }))
    : [];

  const overallScore = evaluationData?.score || 0;

  // Parse report from the API response
  // The report is an object with top_strengths, area_of_improvements, actionable_insights
  const originalReport = evaluationData?.report || {};
  const translationKey = `${evaluationData?.sessionId}:${reportLanguage}`;
  const translatedReport = reportLanguage !== 'en' ? translations[translationKey] : null;
  const report = translatedReport || originalReport;

  const strengths = Array.isArray(report?.top_strengths) 
    ? report.top_strengths
    : [];

  const improvements = Array.isArray(report?.area_of_improvements)
    ? report.area_of_improvements
    : [];

  const insights = Array.isArray(report?.actionable_insights)
    ? report.actionable_insights
    : [];

  const rawBetterResponses = translatedReport?.better_responses
    || evaluationData?.better_responses
    || evaluationData?.better_resposed
    || report?.better_responses
    || report?.better_resposed
    || [];

  const betterResponses = Array.isArray(rawBetterResponses) ? rawBetterResponses : [];

  const dimensionDescriptions = {
    'Communication': 'Clarity, conciseness, structured articulation, and professional tone.',
    'Discovery Skills': 'Uncovering core needs, asking probing/clarifying questions, and active listening.',
    'Business Acumen': 'Comprehension of commercial, organizational, and operational realities.',
    'Relationship Building': 'Empathy, building rapport, psychological safety, and establishing trust.',
    'Executive Presence': 'Poise under pressure, confidence, and bottom-line-first delivery.',
    'Problem Solving': 'Root-cause diagnosis, structured reasoning, and viable solutions/recommendations.',
    'Influence & Persuasion': 'Handling pushback/objections, gaining stakeholder buy-in, and navigating resistance.',
    'Action Orientation & Next Steps': 'Establishing clear accountability, driving decisions, and concrete next steps.',
    // Legacy fallbacks
    'Opening & Engagement': 'How well you capture attention and build rapport at the start of the conversation.',
    'Discovery': 'How effectively you ask questions to understand client needs and pain points.',
    'Call-to-action': 'How clearly and persuasively you guide the counterpart toward the next step.',
    'Objection Handling': 'How well you address and overcome concerns and pushback.',
    'Differentiation': 'How effectively you distinguish your solution from competitors.',
    'Value Proposition': 'How clearly you communicate the unique value and benefits of your offering.',
    'Proof and Credibility': 'How well you establish trust through evidence and credibility.'
  };

  const gaugeDashArray = (overallScore / 100) * 565;

  // PDF of the report exactly as shown, in the selected language
  const handleDownloadPdf = () => {
    const label = evaluationData?.sessionLabel;
    const when = label?.timestamp ? new Date(label.timestamp) : new Date();
    const languageName = (REPORT_LANGUAGES.find(([code]) => code === reportLanguage) || [])[1];
    exportReportPdf({
      subtitle: [label?.persona || currentSession?.client_persona, when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), reportLanguage !== 'en' ? languageName : '']
        .filter(Boolean).join(' · '),
      date: when.toISOString(),
      score: Math.round(overallScore),
      dimensions,
      strengths,
      improvements,
      insights,
      betterResponses: betterResponses.map((item) => ({
        question: item.ai_question || item.ai_prompt || item.question || '',
        yours: item.user_response || item.original_response || item.user || '',
        better: item.better_proposed_response || item.better_response || item.better_proposed || '',
        reason: item.reason || item.explanation || '',
      })),
    });
  };

  const changeReportLanguage = async (lang) => {
    setTranslateError('');
    setReportLanguage(lang);
    const key = `${evaluationData?.sessionId}:${lang}`;
    if (lang === 'en' || translations[key]) return;
    setTranslating(true);
    try {
      const source = {
        ...originalReport,
        better_responses: evaluationData?.better_responses || originalReport.better_responses || originalReport.better_resposed || [],
      };
      const result = await translateReport(source, lang);
      setTranslations((prev) => ({ ...prev, [key]: result.report }));
    } catch (err) {
      console.warn('Report translation failed:', err);
      setTranslateError('Could not translate the report. Please try again.');
      setReportLanguage('en');
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="sc-evaluation-remix-layout">
      <div className="eval-header" style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div>
          <h1 style={{
            margin: '0 0 8px 0',
            fontSize: '32px',
            fontWeight: '600',
            color: 'var(--text-primary)'
          }}>Evaluation Report</h1>
          <p style={{
            margin: '0',
            color: 'var(--text-muted)',
            fontSize: '16px'
          }}>Review your performance and get insights to improve.</p>
          {evaluationData?.sessionLabel && (
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: '14px' }}>
              Saved report
              {evaluationData.sessionLabel.persona ? ` · ${evaluationData.sessionLabel.persona}` : ''}
              {evaluationData.sessionLabel.timestamp
                ? ` · ${new Date(evaluationData.sessionLabel.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                : ''}
              {' · '}
              <button
                type="button"
                onClick={() => navigate('/history')}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-primary)', cursor: 'pointer', font: 'inherit' }}
              >
                Older reports in Practice History
              </button>
            </p>
          )}
        </div>
        <div style={{
          display: 'flex',
          gap: '12px',
          flexWrap: 'wrap',
          alignItems: 'center'
        }}>
          {/* marginTop matches the global .btn margin so this lines up with the buttons beside it */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--text-muted)', marginTop: '1rem' }}>
            Report language
            <select
              value={reportLanguage}
              onChange={(e) => changeReportLanguage(e.target.value)}
              disabled={translating}
              aria-label="Report language"
              style={{ width: 'auto', minWidth: '150px' }}
            >
              {REPORT_LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
            {translating && <span>Translating…</span>}
            {translateError && <span style={{ color: 'var(--danger, #dc2626)' }}>{translateError}</span>}
          </label>
          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={translating}
            className="btn btn-outline mini-radius"
            style={{ padding: '10px 20px', borderRadius: '24px', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <polyline points="9 15 12 18 15 15" />
            </svg>
            Download PDF
          </button>
          {(evaluationData?.audioRecordingUrl || (!evaluationData?.fromHistory && audioRecordingUrl)) && (
            <button
              onClick={() => {
                const url = evaluationData?.audioRecordingUrl || audioRecordingUrl;
                const a = document.createElement('a');
                a.href = url;
                a.download = `session-recording-${evaluationData?.sessionId || 'unknown'}.webm`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
              className="btn btn-outline"
              style={{
                padding: '10px 20px',
                borderRadius: '24px',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download Audio
            </button>
          )}
          <button
            onClick={() => navigate('/setup')}
            className="btn btn-outline mini-radius"
            style={{
              padding: '10px 20px',
              borderRadius: '24px',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
            <span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </span> New Session
          </button>
          <button
          onClick={() => navigate('/dashboard')}
          className="btn btn-primary mini-radius"
        >
          Back to Dashboard
        </button>
        </div>
      </div>

      {/* Score Gauge */}
      <div className="card eval-score-card" style={{
        padding: '32px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <svg viewBox="0 0 500 260" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#D63384" />
              <stop offset="25%" stopColor="#DC3545" />
              <stop offset="50%" stopColor="#FFC107" />
              <stop offset="75%" stopColor="#28A745" />
              <stop offset="100%" stopColor="#6F42C1" />
            </linearGradient>
          </defs>

          <circle cx="250" cy="250" r="180" fill="none" stroke="#b0b0b0" strokeWidth="16" 
                  strokeDasharray="565 1200" strokeLinecap="round" transform="rotate(180 250 250)" />

          <circle cx="250" cy="250" r="180" fill="none" stroke="url(#gaugeGradient)" strokeWidth="16" 
                  strokeDasharray={`${gaugeDashArray} 1200`} strokeLinecap="round" transform="rotate(180 250 250)"
                  style={{ filter: 'drop-shadow(0 0 6px rgba(111, 66, 193, 0.6))' }} />

          {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((val, i) => {
            const angle = Math.PI - (val / 100) * Math.PI;
            const x1 = 250 + Math.cos(angle) * 165;
            const y1 = 250 - Math.sin(angle) * 165;
            const x2 = 250 + Math.cos(angle) * 190;
            const y2 = 250 - Math.sin(angle) * 190;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.5)" strokeWidth="2" />;
          })}

          <circle cx="400" cy="95" r="12" fill="#86E3CE" stroke="white" strokeWidth="4" />
          <circle cx="400" cy="95" r="6" fill="white" />

          <text x="250" y="175" textAnchor="middle" fill="var(--text-primary)">
            <tspan fontSize="42" fontWeight="700">{overallScore}</tspan>
            <tspan fontSize="20" fontWeight="400" fill="var(--text-primary)">/100</tspan>
          </text>
          <text x="250" y="205" textAnchor="middle" fontSize="13" fill="var(--text-primary)">
            {overallScore >= 80 ? 'Excellent' : overallScore >= 60 ? 'Good' : 'Needs Improvement'}
          </text>
        </svg>
      </div>

      {/* Dimensions Breakdown */}
      <div className="eval-dims-section">
        <div style={{
          fontSize: '16px',
          fontWeight: '500',
          color: 'var(--text-secondary)',
          marginBottom: '16px'
        }}>Dimensional Breakdown</div>
        
        <div className="eval-dims-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: 'repeat(4, 1fr)',
          gap: '16px',
          height: '100%'
        }}>
          {dimensions.length > 0 ? dimensions.map((dim, idx) => (
          <div key={idx} className="card" style={{
            padding: '20px',
            position: 'relative'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px'
            }}>
              <span style={{
                fontSize: '14px',
                color: 'var(--text-muted)'
              }}>{dim.name}</span>
              {dimensionDescriptions[dim.name] && (
                <span className="hint-info-icon" data-tooltip={dimensionDescriptions[dim.name]}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </span>
              )}
            </div>
            <div style={{
              fontSize: '18px',
              fontWeight: '600',
              color: 'var(--accent-primary)',
              marginBottom: '10px'
            }}>{dim.score}<span style={{ fontSize: '13px', fontWeight: '400', color: 'var(--text-muted)' }}>/100</span></div>
            <div style={{
              height: '4px',
              backgroundColor: 'var(--border-strong)',
              borderRadius: '2px',
              overflow: 'hidden'
            }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                borderRadius: '2px',
                width: `${dim.score}%`
              }}></div>
            </div>
          </div>
        )) : (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            No dimension data available
          </div>
        )}
      </div>
      </div>

      {/* Recommendations */}
      <div className="eval-recommendations-section">
        {/* Strengths and Improvements */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '16px',
          marginBottom: '24px'
        }}>
          {/* Strengths */}
          <div className="card" style={{
          overflow: 'hidden',
          padding: '0'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span className="card-icon card-icon-square card-icon-teal">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </span>
            <h3 style={{
              margin: '0',
              fontSize: '16px',
              fontWeight: '500',
              color: 'var(--text-primary)'
            }}>Top Strengths</h3>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {strengths.length > 0 ? strengths.map((item, idx) => (
              <div key={idx} style={{
                display: 'flex',
                gap: '12px',
                marginBottom: '16px'
              }}>
                <div style={{
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--success)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  flexShrink: '0',
                  marginTop: '2px'
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div style={{ flex: '1', fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '6px' }}>{item}</div>
              </div>
            )) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No strengths data available</div>
            )}
          </div>
        </div>

        {/* Areas for Improvement */}
        <div className="card" style={{
          overflow: 'hidden',
          padding: '0'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span className="card-icon card-icon-square card-icon-orange">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </span>
            <h3 style={{
              margin: '0',
              fontSize: '16px',
              fontWeight: '500',
              color: 'var(--text-primary)'
            }}>Areas for Improvement</h3>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {improvements.length > 0 ? improvements.map((item, idx) => (
              <div key={idx} style={{
                display: 'flex',
                gap: '12px',
                marginBottom: '16px'
              }}>
                <div style={{
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--warning)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  flexShrink: '0',
                  marginTop: '2px'
                }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <div style={{ flex: '1', fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '6px' }}>{item}</div>
              </div>
            )) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No improvement data available</div>
            )}
          </div>
        </div>
      </div>

      {/* Actionable Insights & Sample Better Responses */}
      <div className="eval-insights-grid">
        {/* Actionable Insights */}
        <div className="card" style={{
          overflow: 'hidden',
          padding: '0',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span className="card-icon card-icon-square card-icon-blue">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>
            </span>
            <h3 style={{
              margin: '0',
              fontSize: '16px',
              fontWeight: '500',
              color: 'var(--text-primary)'
            }}>Actionable Insights</h3>
          </div>
          <div style={{ padding: '16px 20px', flex: '1' }}>
            {insights.length > 0 ? insights.map((item, idx) => (
              <div key={idx} style={{
                display: 'flex',
                gap: '12px',
                marginBottom: '16px'
              }}>
                <div style={{
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  flexShrink: '0',
                  marginTop: '2px'
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>
                </div>
                <div style={{ flex: '1', fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '6px' }}>{item}</div>
              </div>
            )) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No actionable insights available</div>
            )}
          </div>
        </div>

        {/* Sample Better Responses */}
        <div className="card" style={{
          overflow: 'hidden',
          padding: '0',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="card-icon card-icon-square card-icon-purple">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
              </span>
              <h3 style={{
                margin: '0',
                fontSize: '16px',
                fontWeight: '500',
                color: 'var(--text-primary)'
              }}>Sample Better Responses</h3>
            </div>
            {betterResponses.length > 0 && (
              <span style={{
                fontSize: '11px',
                fontWeight: '600',
                padding: '2px 8px',
                borderRadius: '12px',
                backgroundColor: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
                color: 'var(--accent-primary)',
                letterSpacing: '0.4px'
              }}>
                Top {betterResponses.length} Turns
              </span>
            )}
          </div>

          <div style={{
            padding: '16px 20px',
            flex: '1',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}>
            {betterResponses.length > 0 ? (
              betterResponses.map((item, idx) => {
                const aiQ = item.ai_question || item.ai_prompt || item.question || '';
                const userR = item.user_response || item.original_response || item.user || '';
                const betterR = item.better_proposed_response || item.better_response || item.better_proposed || '';
                const reason = item.reason || item.explanation || '';

                return (
                  <div key={idx} style={{
                    border: '1px solid var(--border-default)',
                    borderRadius: '8px',
                    padding: '12px 14px',
                    backgroundColor: 'var(--bg-input)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: '700',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color: 'var(--accent-primary)'
                      }}>
                        Weakest Turn #{idx + 1}
                      </span>
                    </div>

                    {aiQ && (
                      <div style={{ fontSize: '12px', lineHeight: '1.4' }}>
                        <div style={{
                          color: 'var(--text-muted)',
                          fontSize: '11px',
                          fontWeight: '600',
                          marginBottom: '2px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.4px'
                        }}>
                          AI Question
                        </div>
                        <div style={{
                          color: 'var(--text-secondary)',
                          fontStyle: 'italic',
                          paddingLeft: '8px',
                          borderLeft: '2px solid var(--border-strong)'
                        }}>
                          "{aiQ}"
                        </div>
                      </div>
                    )}

                    {userR && (
                      <div style={{ fontSize: '12px', lineHeight: '1.4' }}>
                        <div style={{
                          color: 'var(--error)',
                          fontSize: '11px',
                          fontWeight: '600',
                          marginBottom: '2px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Your Response
                        </div>
                        <div style={{
                          color: 'var(--text-muted)',
                          paddingLeft: '8px',
                          borderLeft: '2px solid color-mix(in srgb, var(--error) 40%, transparent)'
                        }}>
                          "{userR}"
                        </div>
                      </div>
                    )}

                    {betterR && (
                      <div style={{
                        fontSize: '12px',
                        lineHeight: '1.45',
                        backgroundColor: 'color-mix(in srgb, var(--success) 7%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
                        borderRadius: '6px',
                        padding: '10px'
                      }}>
                        <div style={{
                          color: 'var(--success)',
                          fontSize: '11px',
                          fontWeight: '600',
                          marginBottom: '3px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Better Proposed Response
                        </div>
                        <div style={{
                          color: 'var(--text-primary)',
                          fontWeight: '500'
                        }}>
                          "{betterR}"
                        </div>
                      </div>
                    )}

                    {reason && (
                      <div style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        lineHeight: '1.4'
                      }}>
                        <strong style={{ color: 'var(--text-secondary)' }}>Tip: </strong>
                        {reason}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '24px 8px' }}>
                No sample better responses recorded for this session.
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      
    </div>
  );
};

export default Evaluation;
