import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  RadialLinearScale,
  Filler,
  Tooltip,
  Legend
} from 'chart.js';
import { Line, Radar } from 'react-chartjs-2';
import { 
  getStatistics, 
  getSessionScores, 
  getDimensionsSummary, 
  getClarityData,
  getLearningRecommendations,
  getSessionsByDifficulty 
} from '../services/api.js';
import '../styles/progress-page.css';
import '../styles/progress-components.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  RadialLinearScale,
  Filler,
  Tooltip,
  Legend
);

const InlineLoader = ({ label = 'Loading...' }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>
    <div style={{
      width: '22px',
      height: '22px',
      border: '3px solid var(--border-strong)',
      borderTopColor: '#6366f1',
      borderRadius: '50%',
      animation: 'spin 1s linear infinite',
      flexShrink: 0
    }}></div>
    <span>{label}</span>
  </div>
);

const fetchMainProgressData = async () => {
  const [stats, scores, dimSummary, clarity, difficultyData] = await Promise.all([
    getStatistics(),
    getSessionScores({ limit: 10 }),
    getDimensionsSummary(),
    getClarityData(),
    getSessionsByDifficulty({ limit: 4 })
  ]);

  return {
    statistics: stats,
    sessionScores: scores || [],
    dimensionsSummary: dimSummary,
    clarityData: clarity,
    sessionsByDifficulty: difficultyData
  };
};

const fetchRecommendations = async () => {
  const recs = await getLearningRecommendations();
  return recs?.recommendations || null;
};

const ProgressTracking = () => {
  const navigate = useNavigate();

  const {
    data: mainData,
    isLoading: mainDataLoading,
    error: mainError,
    refetch: refetchMainData
  } = useQuery({
    queryKey: ['progress', 'main'],
    queryFn: fetchMainProgressData,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const {
    data: recommendations,
    isLoading: recommendationsLoading,
    error: recommendationsError,
    refetch: refetchRecommendations
  } = useQuery({
    queryKey: ['progress', 'recommendations'],
    queryFn: fetchRecommendations,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const {
    statistics,
    sessionScores,
    dimensionsSummary,
    clarityData,
    sessionsByDifficulty
  } = mainData || {};

  // Format time from seconds
  const formatTime = (totalSeconds) => {
    if (!totalSeconds) return '0h 0m';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  // Prepare score progression chart data
  const scoreProgressionData = useMemo(() => ({
    labels: (sessionScores || []).map((s) => {
      const date = new Date(s.date);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }),
    datasets: [
      {
        label: 'Score',
        data: (sessionScores || []).map(s => s.score),
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.12)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 8,
        pointHoverBackgroundColor: '#6366f1',
        pointHoverBorderColor: '#1e293b',
        pointHoverBorderWidth: 3,
      }
    ]
  }), [sessionScores]);

  // Prepare dimensions comparison data (last session vs average)
  const dimensionsComparisonData = useMemo(() => {
    if (!dimensionsSummary) return null;
    return {
      labels: Object.keys(dimensionsSummary.latest_dimensions || {}),
      datasets: [
        {
          label: 'Latest Session',
          data: Object.values(dimensionsSummary.latest_dimensions || {}),
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.15)',
          borderWidth: 3,
          pointBackgroundColor: '#3B4CD3',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          pointRadius: 5,
        },
        {
          label: `Average (${dimensionsSummary.sessions_included || 5} sessions)`,
          data: Object.values(dimensionsSummary.average_dimensions || {}),
          borderColor: '#a78bfa',
          backgroundColor: 'rgba(167, 139, 250, 0.1)',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
        }
      ]
    };
  }, [dimensionsSummary]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: '#ffffff',
        titleColor: '#1f2937',
        bodyColor: '#94a3b8',
        borderColor: '#334155',
        borderWidth: 1,
        padding: 12,
        displayColors: false,
        callbacks: {
          label: function(context) {
            return `${context.parsed.y}/100`;
          }
        }
      }
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          color: '#6b7280',
        }
      },
      y: {
        min: 0,
        max: 100,
        grid: {
          color: '#f3f4f6',
        },
        ticks: {
          color: '#6b7280',
        }
      }
    }
  }), []);

  const radarOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 20,
          font: {
            size: 16
          }
        }
      },
    },
    scales: {
      r: {
        beginAtZero: true,
        max: 100,
        ticks: {
          display: false,
        },
        grid: {
          color: '#e5e7eb',
        },
        angleLines: {
          color: '#e5e7eb',
        },
        pointLabels: {
          font: {
            size: 16,
          },
          color: '#6b7280',
        }
      }
    }
  }), []);

  const error = mainError?.message || null;
  const recError = recommendationsError?.message || null;

  return (
    <div className="progress-tracking-page sc-progress-fixed-layout">
      {/* Header Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)', }}>Your Progress Over Time</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            {mainDataLoading ? 'Loading progress data...' : `${statistics?.total_sessions || 0} Sessions Completed`}
          </p>
        </div>
        <div className="progress-action-row" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
        <button
          onClick={() => navigate('/setup')}
          style={{
            padding: '14px 28px',
            borderRadius: '10px',
            border: 'none',
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            color: '#ffffff',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '15px',
            boxShadow: '0 4px 14px rgba(79, 70, 229, 0.35)',
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 6px 20px rgba(79, 70, 229, 0.45)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 4px 14px rgba(79, 70, 229, 0.35)';
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          Start New Session
        </button>
      </div>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px',
          marginBottom: '24px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '8px',
          color: '#dc2626',
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          {error}
          <button
            onClick={() => refetchMainData()}
            style={{
              marginLeft: 'auto',
              padding: '4px 12px',
              borderRadius: '6px',
              border: '1px solid #dc2626',
              backgroundColor: '#ffffff',
              color: '#dc2626',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      )}


 <div className="progress-side-kpis">
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div className="card-title">Total Sessions</div>
          <div className='card-hd'>{mainDataLoading ? '...' : statistics?.total_sessions || 0}</div>
          <span className="positive-tag">All time</span>
        </div>
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div className="card-title">Average Score</div>
          <div className='card-hd'>{mainDataLoading ? '...' : statistics?.average_score ? Math.round(statistics.average_score) : 0}/100</div>
          <span className="positive-tag">All sessions</span>
        </div>
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div className="card-title">Clarity Score</div>
          <div className='card-hd'>{mainDataLoading ? '...' : clarityData?.latest ? Math.round(clarityData.latest) : 'N/A'}</div>
          <span style={{ backgroundColor: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-primary-hover)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px' }}>Latest session</span>
        </div>
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div className="card-title">Practice Time</div>
          <div className='card-hd'>{formatTime(statistics?.total_practice_time)}</div>
          <span style={{ backgroundColor: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-primary-hover)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px' }}>Total time</span>
        </div>
      </div>


      {/* Top Charts Row */}
      <div className="progress-top-charts" style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '24px', marginBottom: '24px' }}>
        {/* Overall Score Progression Chart */}
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(99, 102, 241, 0.08)', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>
            <div>
              <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Overall Score Progression</div>
              <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>{mainDataLoading ? '...' : formatTime(statistics?.total_practice_time)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Average Score</div>
              <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>{statistics?.average_score ? Math.round(statistics.average_score) : 'N/A'}/100</div>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ height: '320px' }}>
              {mainDataLoading ? (
                <InlineLoader label="Loading score data..." />
              ) : sessionScores?.length > 0 ? (
                <Line data={scoreProgressionData} options={chartOptions} />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  No score data available yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dimensions Comparison Chart */}
        <div className="card mini-radius" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 500, color: 'var(--text-primary)' }}>Dimensions Comparison</h3>
            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#3B4CD3' }}></span>
                <span>Latest Session</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#A5ADF0' }}></span>
                <span>Average ({dimensionsSummary?.sessions_included || 5} sessions)</span>
              </div>
            </div>
          </div>
          <div style={{ height: '360px' }}>
            {mainDataLoading ? (
              <InlineLoader label="Loading dimensions data..." />
            ) : dimensionsComparisonData ? (
              <Radar data={dimensionsComparisonData} options={radarOptions} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                No dimensions data available yet
              </div>
            )}
          </div>
        </div>
      </div>

      
      {/* Stats Cards Row */}
     

      {/* Bottom Row */}
      <div className="progress-top-charts ">
        {/* Learning Recommendations */}
        <div className="card mini-radius" style={{ padding: '24px' }}>
          <h3 style={{ margin: '0 0 24px 0', fontSize: '16px', fontWeight: 500, color: 'var(--text-primary)' }}>Learning Recommendations</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minHeight: '96px' }}>
            {recommendationsLoading ? (
              <InlineLoader label="Generating customized recomendations..." />
            ) : recError ? (
              <div style={{ color: '#dc2626', fontSize: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span>{recError}</span>
                <button
                  onClick={() => refetchRecommendations()}
                  style={{
                    alignSelf: 'flex-start',
                    padding: '4px 12px',
                    borderRadius: '6px',
                    border: '1px solid #dc2626',
                    backgroundColor: '#ffffff',
                    color: '#dc2626',
                    fontSize: '12px',
                    cursor: 'pointer'
                  }}
                >
                  Retry
                </button>
              </div>
            ) : recommendations && Array.isArray(recommendations) && recommendations.length > 0 ? recommendations.map((rec, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '12px' }}>
                <div style={{ width: '18px', height: '18px', borderRadius: '50%', backgroundColor: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '2px' }}>
                  <svg style={{ width: '12px', height: '12px', color: '#ffffff' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{rec}</div>
                </div>
              </div>
            )) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No recommendations available yet</div>
            )}
          </div>
        </div>

        {/* Sessions by Difficulty */}
        <div className="card mini-radius" style={{ padding: '24px' }}>
          <h3 style={{ margin: '0 0 24px 0', fontSize: '16px', fontWeight: 500, color: 'var(--text-primary)' }}>Sessions by Difficulty</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {mainDataLoading ? (
              <InlineLoader label="Loading sessions by difficulty..." />
            ) : sessionsByDifficulty && Object.keys(sessionsByDifficulty).length > 0 ? (
              Object.entries(sessionsByDifficulty).map(([difficulty, sessions]) => (
                <div key={difficulty}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <span style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      backgroundColor: 
                        difficulty === 'Easy' ? '#22C55E' :
                        difficulty === 'Medium' ? '#F59E0B' :
                        difficulty === 'Hard' ? '#EF4444' : '#7C3AED'
                    }}></span>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>{difficulty} ({Array.isArray(sessions) ? sessions.length : 0} sessions)</span>
                  </div>
                  {Array.isArray(sessions) && sessions.length > 0 ? (
                    <div style={{ marginLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {sessions.map((session, idx) => (
                        <div className='sessionBadge' key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: '6px' }}>
                          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                            {session.date ? new Date(session.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
                          </span>
                          <span style={{ 
                            fontSize: '14px', 
                            fontWeight: 600, 
                            color: session.score >= 80 ? '#22C55E' : session.score >= 60 ? '#F59E0B' : '#EF4444' 
                          }}>
                            {session.score}/100
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginLeft: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>No sessions</div>
                  )}
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>No data available</div>
            )}
          </div>
        </div>
      </div>

     
      

      
      
    </div>
  );
};

export default ProgressTracking;
