import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  getSessions,
  getRealtimeLanguages,
  createSession,
  uploadSingleDocument,
  uploadMultipleDocuments,
  combineDocuments,
  createSalesSummary,
  ApiError
} from '../services/api';
import useSessionStore from '../store/sessionStore';
import { preloadAvatarClips } from '../services/avatarClips';
import '../styles/setup-session.css';

// Regional Indian languages (other than Hindi) are hidden for now; the backend still supports them.
const SHOW_REGIONAL_LANGUAGES = false;

// Difficulty suggestion from the user's latest evaluated sessions at the level they practise most recently.
const DIFFICULTY_LEVELS = ['Easy', 'Medium', 'Hard', 'Expert'];
const SUGGEST_STREAK = 3; // sessions needed before suggesting anything
const STEP_UP_SCORE = 75; // every one of them at least this -> suggest the next level
const STEP_DOWN_AVERAGE = 40; // their average below this -> suggest the level below

function suggestDifficulty(sessions) {
  const evaluated = (sessions || []).filter(s => (s.evaluation || s.average_score) && DIFFICULTY_LEVELS.includes(s.difficulty_level));
  if (evaluated.length === 0) return null;
  const level = evaluated[0].difficulty_level; // sessions arrive newest first
  const recent = evaluated.filter(s => s.difficulty_level === level).slice(0, SUGGEST_STREAK);
  if (recent.length < SUGGEST_STREAK) return null;
  const scores = recent.map(s => Math.round(s.average_score || 0));
  const average = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const index = DIFFICULTY_LEVELS.indexOf(level);
  if (scores.every(score => score >= STEP_UP_SCORE) && index < DIFFICULTY_LEVELS.length - 1) {
    const next = DIFFICULTY_LEVELS[index + 1];
    return { level: next, message: `You scored ${STEP_UP_SCORE}+ in your last ${SUGGEST_STREAK} ${level} sessions. Ready to try ${next}?` };
  }
  if (average < STEP_DOWN_AVERAGE && index > 0) {
    const easier = DIFFICULTY_LEVELS[index - 1];
    return { level: easier, message: `Your last ${SUGGEST_STREAK} ${level} sessions averaged ${average}. A round of ${easier} could help you build up.` };
  }
  return null;
}
const SetupSession = () => {
  // Download the avatar clips while the user configures the session, so the session starts smoothly.
  useEffect(() => { preloadAvatarClips(); }, []);
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const setSession = useSessionStore(state => state.setSession);
  const setDocumentData = useSessionStore(state => state.setDocumentData || ((data) => data));

  // Form state (local UI state)
  const [difficulty, setDifficulty] = useState('Easy');
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const { data: recentSessions } = useQuery({
    queryKey: ['difficulty-suggestion'],
    queryFn: () => getSessions({ limit: 30 }),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const suggestion = suggestDifficulty(recentSessions);
  // Languages no voice provider on the server can hear (e.g. French on Devnagri without Azure) are hidden.
  const { data: languageInfo } = useQuery({
    queryKey: ['realtime-languages'],
    queryFn: getRealtimeLanguages,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const unavailableLanguages = new Set(languageInfo?.unavailable || []);
  const [scenarioType, setScenarioType] = useState('Sales & Commercial Pitches');
  const [businessContext, setBusinessContext] = useState('Consulting');
  const [persona, setPersona] = useState('CTO - Chief Technology Officer');
  const [industry, setIndustry] = useState('Technology / SaaS');
  const [companySize, setCompanySize] = useState('Mid-market (500-999 employees)');
  const [responseLanguage, setResponseLanguage] = useState('auto');
  useEffect(() => {
    if (unavailableLanguages.has(responseLanguage)) setResponseLanguage('auto');
    // eslint-disable-next-line
  }, [languageInfo]);
  
  // Document upload state (local UI state)
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [documentDataLocal, setDocumentDataLocal] = useState(null);
  const [uploadError, setUploadError] = useState(null);  
  // Session creation state
  const [sessionError, setSessionError] = useState(null);
  const [comingSoon, setComingSoon] = useState(false);
  const comingSoonTimerRef = useRef(null);

  const showComingSoon = () => {
    setComingSoon(true);
    clearTimeout(comingSoonTimerRef.current);
    comingSoonTimerRef.current = setTimeout(() => setComingSoon(false), 2000);
  };

  useEffect(() => {
    // Clear any lingering document data from previous sessions when entering setup
    setDocumentData(null);
    setDocumentDataLocal(null);
    setUploadedFiles([]);
    return () => clearTimeout(comingSoonTimerRef.current);
  }, [setDocumentData]);

  // React Query mutations for API calls
  const uploadMutation = useMutation({
    mutationFn: async (files) => {
      if (files.length === 1) {
        return uploadSingleDocument(files[0]);
      } else {
        return uploadMultipleDocuments(files);
      }
    },
    onSuccess: (data) => {
      console.log('Upload successful:', data);
    },
    onError: (error) => {
      console.error('Upload error:', error);
    }
  });

  const combineMutation = useMutation({
    mutationFn: combineDocuments,
    onSuccess: (data) => {
      console.log('Combine successful:', data);
    }
  });

  const summaryMutation = useMutation({
    mutationFn: createSalesSummary,
    onSuccess: (data) => {
      console.log('Summary successful:', data);
    }
  });

  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (data) => {
      console.log('Session created:', data);
    }
  });

  const difficultyOptions = [
    {
      id: 'Easy',
      name: 'Friendly Client',
      label: 'EASY',
      labelClass: 'difficulty-badge-easy',
      features: [
        'Interested buyer',
        'Basic questions',
        'Minimal objections',
        'Perfect for beginners'
      ]
    },
    {
      id: 'Medium',
      name: 'Cautious Buyer',
      label: 'MEDIUM',
      labelClass: 'difficulty-badge-medium',
      features: [
        'Cautious buyer',
        'Moderate skepticism',
        'Probing questions',
        'Good for intermediate'
      ]
    },
    {
      id: 'Hard',
      name: 'Skeptical Decision Maker',
      label: 'HARD',
      labelClass: 'difficulty-badge-hard',
      features: [
        'Skeptical buyer',
        'Strong objections',
        'Competitive questions',
        'Best for experienced'
      ]
    },
    {
      id: 'Expert',
      name: 'Adversarial Executive',
      label: 'EXPERT',
      labelClass: 'difficulty-badge-expert',
      features: [
        'Highly challenging',
        'Persistent pushback',
        'Advanced negotiation',
        'Requires mastery'
      ]
    }
  ];

  // Document upload handler using React Query mutations
  const handleFileSelect = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
  
    // Reset states
    setUploadError(null);
    setDocumentDataLocal(null);
    setUploadedFiles(Array.from(files));

    // Use the upload mutation
    uploadMutation.mutate(Array.from(files), {
      onSuccess: async (uploadResult) => {
        try {
          // Check for upload errors even if HTTP status was OK
          if (uploadResult.error) {
            const errorMsg = typeof uploadResult.error === 'object'
              ? JSON.stringify(uploadResult.error)
              : uploadResult.error;
            throw new Error(`Upload failed: ${errorMsg}`);
          }
      
          // Extract processed files from upload result
          let processedFiles;
          if (files.length === 1) {
            processedFiles = { [files[0].name]: uploadResult.content || uploadResult };
          } else {
            processedFiles = uploadResult.processed_files || uploadResult;
            // Stop on any file that could not be read, rather than summarising its error text
            const failed = Object.entries(processedFiles).filter(([, text]) => typeof text === 'string' && text.startsWith('Error: '));
            if (failed.length > 0) {
              throw new Error(failed.map(([name, text]) => `${name}: ${text.slice('Error: '.length)}`).join(' '));
            }
          }
      
          // Step 2: Combine processed documents
          const combineResult = await combineMutation.mutateAsync(processedFiles);
          if (combineResult.error) {
            const errorMsg = typeof combineResult.error === 'object'
              ? JSON.stringify(combineResult.error)
              : combineResult.error;
            throw new Error(`Document combine failed: ${errorMsg}`);
          }
          const combinedContent = combineResult.combined_content || combineResult.content;
      
          // Step 3: Generate sales summary
          const summaryResult = await summaryMutation.mutateAsync(combinedContent);
          if (summaryResult.error) {
            const errorMsg = typeof summaryResult.error === 'object'
              ? JSON.stringify(summaryResult.error)
              : summaryResult.error;
            throw new Error(`Sales summary generation failed: ${errorMsg}`);
          }
          const salesSummary = summaryResult.summary || summaryResult.text;
      
          // Update document data with all processed information
          const docData = {
            combined_content: combinedContent,
            sales_summary: salesSummary,
            buyer_brief: summaryResult.buyer_brief || '',
            processed_files: processedFiles,
            files: Array.from(files)
          };
          setDocumentDataLocal(docData);
          // Save to Zustand store
          useSessionStore.getState().setDocumentData?.(docData);
        } catch (error) {
          handleUploadError(error);
        }
      },
      onError: (error) => {
        handleUploadError(error);
      }
    });
  };

  const handleUploadError = (error) => {
    setUploadedFiles([]);
    setDocumentDataLocal(null);
    setDocumentData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    
    // Log full error to browser console for debugging
    console.error('Document processing error:', error);
    if (error instanceof ApiError) {
      console.error('API Error details:', {
        message: error.message,
        status: error.status,
        data: error.data
      });
    }
    
    let errorMessage = 'Unknown error';
    if (error instanceof ApiError) {
      if (typeof error.message === 'object') {
        errorMessage = JSON.stringify(error.message);
      } else if (error.data) {
        const data = error.data;
        errorMessage = typeof data === 'object'
          ? JSON.stringify(data)
          : (data?.detail || data?.message || error.message);
      } else {
        errorMessage = error.message || `HTTP ${error.status}`;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message || 'Unknown error occurred';
    } else {
      errorMessage = typeof error === 'object'
        ? JSON.stringify(error)
        : String(error);
    }
    
    setUploadError(`Failed to process document: ${errorMessage}`);
  };

  // Handle drag and drop
  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && fileInputRef.current) {
      // Create a new DataTransfer to set files
      const dataTransfer = new DataTransfer();
      Array.from(files).forEach(file => dataTransfer.items.add(file));
      fileInputRef.current.files = dataTransfer.files;
      handleFileSelect({ target: { files: dataTransfer.files } });
    }
  };

  // Session creation handler using React Query mutation and Zustand store
  const handleStartSession = () => {
    if (!persona || !industry || !companySize) {
      setSessionError('Please fill in all client details (persona, industry, and company size).');
      return;
    }

    setSessionError(null);

    // Generate session ID
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const sessionData = {
      session_id: sessionId,
      timestamp: timestamp,
      difficulty_level: difficulty,
      scenario_type: scenarioType,
      business_context: businessContext,
      client_persona: persona,
      industry: industry,
      company_size: companySize,
      response_language: responseLanguage,
      document_alignment: null,
      average_score: null
    };

    // Use the create session mutation
    createSessionMutation.mutate(sessionData, {
      onSuccess: (result) => {
        // Store session data in Zustand store (persisted to localStorage automatically)
        setSession({
          session_id: sessionId,
          timestamp: timestamp,
          difficulty_level: difficulty,
          scenario_type: scenarioType,
          business_context: businessContext,
          client_persona: persona,
          industry: industry,
          company_size: companySize,
          response_language: responseLanguage,
          document_alignment: null,
          average_score: null
        }, documentDataLocal);
        
        // Navigate to active session
        navigate('/session');
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          setSessionError(`Failed to create session: ${error.message}`);
        } else {
          setSessionError('Could not start session. Please try again later.');
        }
      }
    });
  };

  return (
    <div className="setup-session">
      <div className="setup-header">
        <div>
          <h1>Practice Session</h1>
          <p className="setup-subtitle">Configure your practice sessions with AI to refine your skills and achieve mastery.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <div className="header-actions">
            <button className="how-to-btn" onClick={showComingSoon}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            How to use
          </button>
          <button className="profile-btn" onClick={showComingSoon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            Profile Configure
          </button>
          </div>
        </div>
      </div>

      {comingSoon && (
        <div className="coming-soon-popup">
          Coming Soon
        </div>
      )}

      <div className="difficulty-section">
        <h3>Select Difficulty Level</h3>
        {suggestion && !suggestionDismissed && (
          <div role="status" style={{
            display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', margin: '0 0 16px',
            padding: '12px 16px', borderRadius: '12px', border: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', fontSize: '14px', color: 'var(--text-primary)',
          }}>
            <span style={{ flex: '1 1 260px' }}>💡 {suggestion.message}</span>
            {difficulty !== suggestion.level && (
              <button type="button" className="btn btn-primary mini-radius" style={{ marginTop: 0, padding: '6px 14px', fontSize: '13px' }}
                onClick={() => setDifficulty(suggestion.level)}>
                Switch to {suggestion.level}
              </button>
            )}
            <button type="button" onClick={() => setSuggestionDismissed(true)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', padding: '4px' }}>
              Not now
            </button>
          </div>
        )}
        <div className="difficulty-grid">
          {difficultyOptions.map((option) => (
            <div 
              key={option.id}
              className={`difficulty-card ${difficulty === option.id ? 'selected' : ''}`}
              onClick={() => setDifficulty(option.id)}
            >
              <div className="difficulty-header">
                <input 
                  type="radio" 
                  name="difficulty" 
                  checked={difficulty === option.id}
                  onChange={() => setDifficulty(option.id)}
                />
                <span className="difficulty-name">{option.name}</span>
                {suggestion && !suggestionDismissed && suggestion.level === option.id && (
                  <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: 600, color: 'var(--accent-primary)' }}>Suggested</span>
                )}
              </div>
              <span className={`difficulty-badge ${option.labelClass}`}>
                {option.label}
              </span>
              <ul className="difficulty-features">
                {option.features.map((feature, idx) => (
                  <li key={idx}>{feature}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="client-details-section">
        <h3>Simulation & Role Configuration</h3>
        <p className="section-subtitle">Select coaching scenario, business context, persona, and response language.</p>
        
        <div className="client-fields-grid">
          <div className="form-field">
            <label>Coaching Scenario</label>
            <select value={scenarioType} onChange={(e) => setScenarioType(e.target.value)}>
              <option value="Sales & Commercial Pitches">Sales & Commercial Pitches</option>
              <option value="Consulting Engagements">Consulting Engagements</option>
              <option value="Stakeholder Management & Alignment">Stakeholder Management & Alignment</option>
              <option value="Executive Presence & C-Suite Briefings">Executive Presence & C-Suite Briefings</option>
              <option value="Leadership Conversations & Team Coaching">Leadership Conversations & Team Coaching</option>
              <option value="Difficult Performance Discussions & Career Reviews">Difficult Performance Discussions & Career Reviews</option>
            </select>
          </div>
          <div className="form-field">
            <label>Business Context / Service Line</label>
            <select value={businessContext} onChange={(e) => setBusinessContext(e.target.value)}>
              <option value="Consulting">Consulting</option>
              <option value="Advisory">Advisory</option>
              <option value="Audit">Audit</option>
              <option value="Tax">Tax</option>
              <option value="Cyber Security">Cyber Security</option>
              <option value="Data & AI">Data & AI</option>
              <option value="Cross-functional / Enterprise">Cross-functional / Enterprise</option>
            </select>
          </div>
          <div className="form-field">
            <label>Counterpart Persona</label>
            <select value={persona} onChange={(e) => setPersona(e.target.value)}>
              <option value="">Select Persona</option>
              <optgroup label="Leadership, People & Consulting">
                <option value="Senior Leadership (Senior Partner / Managing Director / Practice Lead)">Senior Leadership (Partner / MD / Practice Lead)</option>
                <option value="Consulting & Strategy Lead">Consulting & Strategy Lead</option>
                <option value="PPC Lead (People, Performance & Culture / HR)">PPC Lead (People, Performance & Culture / HR)</option>
                <option value="L&D Director (Learning & Development)">L&D Director (Learning & Development)</option>
              </optgroup>
              <optgroup label="C-Suite & Commercial Roles">
                <option value="CTO - Chief Technology Officer">CTO - Chief Technology Officer</option>
                <option value="CFO - Chief Financial Officer">CFO - Chief Financial Officer</option>
                <option value="CEO - Chief Executive Officer">CEO - Chief Executive Officer</option>
                <option value="VP of Operations">VP of Operations</option>
                <option value="Head of Sales">Head of Sales</option>
                <option value="Procurement Manager">Procurement Manager</option>
              </optgroup>
            </select>
          </div>
          <div className="form-field">
            <label>Industry Sector</label>
            <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
              <option value="">Select Industry</option>
              <option value="Technology / SaaS">Technology / SaaS</option>
              <option value="Financial Services">Financial Services</option>
              <option value="Healthcare">Healthcare</option>
              <option value="Manufacturing">Manufacturing</option>
              <option value="Retail / E-commerce">Retail / E-commerce</option>
              <option value="Energy & Utilities">Energy & Utilities</option>
              <option value="Public Sector">Public Sector</option>
              <option value="Education">Education</option>
            </select>
          </div>
          <div className="form-field">
            <label>Company Size / Scale</label>
            <select value={companySize} onChange={(e) => setCompanySize(e.target.value)}>
              <option value="">Select Scale</option>
              <option value="Enterprise (1000+ employees)">Enterprise (1000+ employees)</option>
              <option value="Mid-market (500-999 employees)">Mid-market (500-999 employees)</option>
              <option value="Small Business (100-499 employees)">Small Business (100-499 employees)</option>
              <option value="Startup (1-99 employees)">Startup (1-99 employees)</option>
            </select>
          </div>
          <div className="form-field">
            <label>Response Language</label>
            <select value={responseLanguage} onChange={(e) => setResponseLanguage(e.target.value)}>
              <option value="auto">Auto (match the speaker's language)</option>
              <option value="en">English</option>
              {!unavailableLanguages.has('fr') && <option value="fr">French (Français)</option>}
              {!unavailableLanguages.has('de') && <option value="de">German (Deutsch)</option>}
              {!unavailableLanguages.has('es') && <option value="es">Spanish (Español)</option>}
              {!unavailableLanguages.has('it') && <option value="it">Italian (Italiano)</option>}
              <option value="hi">Hindi / Hinglish</option>
              {SHOW_REGIONAL_LANGUAGES && (
                <>
                <option value="gu">Gujarati (ગુજરાતી)</option>
                <option value="mr">Marathi (मराठी)</option>
                <option value="ta">Tamil (தமிழ்)</option>
                <option value="te">Telugu (తెలుగు)</option>
                <option value="bn">Bengali (বাংলা)</option>
                <option value="kn">Kannada (ಕನ್ನಡ)</option>
                <option value="ml">Malayalam (മലയാളം)</option>
                <option value="pa">Punjabi (ਪੰਜਾਬੀ)</option>
                </>
              )}
            </select>
          </div>
        </div>
      </div>

      <div className="upload-section card">
        <h3>Supporting Material Upload & Analysis</h3>
        
        {uploadError && (
          <div className="error-message state-panel-error-inline" role="alert">
            {uploadError}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.pptx,.docx,.doc"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          id="file-upload"
          multiple
        />

        <div
          className="drop-area"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current.click()}
          role="button"
          tabIndex={0}
          aria-label="Upload supporting documents"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current.click();
            }
          }}
        >
          <div className="drop-content">
            {uploadMutation.isPending ? (
              <>
                <div style={{
                  width: '100%',
                  height: '8px',
                  backgroundColor: 'var(--border-default)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  marginBottom: '0.75rem'
                }}>
                  <div style={{
                    height: '100%',
                    width: '60%',
                    backgroundColor: 'var(--accent-primary)',
                    transition: 'width 0.3s ease',
                    animation: 'pulse 1.5s infinite'
                  }} />
                </div>
                <p>Processing documents (uploading, combining, generating summary)...</p>
              </>
            ) : documentDataLocal ? (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                <p style={{ color: 'var(--success)' }}>
                  {documentDataLocal?.files?.length === 1 ? documentDataLocal.files[0].name : `${documentDataLocal?.files?.length} files`} processed successfully
                </p>
                <p className="file-info">✅ Document(s) ready for session</p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDocumentDataLocal(null);
                    setUploadedFiles([]);
                    setDocumentData(null);
                    if (fileInputRef.current) {
                      fileInputRef.current.value = '';
                    }
                  }}
                  className="remove-doc-btn"
                >
                  ✕ Remove document
                </button>
                {documentDataLocal?.sales_summary && (
                  <details onClick={(e) => e.stopPropagation()} style={{ marginTop: '1rem', width: '100%', textAlign: 'left' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--accent-primary-hover)', fontSize: '0.875rem' }}>View Report Summary</summary>
                    <div style={{
                      padding: '0.75rem',
                      backgroundColor: 'var(--bg-input)',
                      borderRadius: '6px',
                      marginTop: '0.5rem',
                      fontSize: '0.875rem',
                      color: 'var(--text-secondary)',
                      maxHeight: '200px',
                      overflowY: 'auto'
                    }}>
                      {documentDataLocal.sales_summary}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                <p>Drag and drop files or browse on computer</p>
                <p className="file-info">Max 1 file, max 30MB. Supported: .pptx, .pdf, .docx</p>
              </>
            )}
          </div>
        </div>
      </div>

      {sessionError && (
        <div className="state-panel-error-inline" role="alert">
          {sessionError}
        </div>
      )}

      <div className="session-start-card">
        <div className="session-info">
          <div className="session-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
          <div>
            <h3>Real Time Coaching Session</h3>
            <p>Start talking, and let the AI do the rest. It actively listens and evaluates your voice to guide you toward better communication.</p>
          </div>
        </div>
        <button 
          className="start-session-btn mini-radius" 
          onClick={handleStartSession}
          disabled={createSessionMutation.isPending || uploadMutation.isPending}
          aria-disabled={createSessionMutation.isPending || uploadMutation.isPending}
        >
          {createSessionMutation.isPending ? 'Starting Session...' : 'Start Coaching Session'}
        </button>
      </div>

      
    </div>
  );
};

export default SetupSession;
