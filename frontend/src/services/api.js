/**
 * SalesCoach API Service Layer
 * Complete API client for all backend services
 * 
 * Base URL: http://localhost:2089 (Unified API)
 * 
 * API Structure (from api_docs.md):
 * - Database & Session Management: /db/*
 * - Document Processing: /documents/*
 * - AI Services & Analysis: /ai/*
 */

// ==================== BASE CONFIGURATION ====================
const API_CONFIG = {
  // Set REACT_APP_API_BASE_URL when building for a server (it is baked in at build time), e.g.
  // REACT_APP_API_BASE_URL=https://<backend-app>.azurewebsites.net npm run build
  BASE_URL: process.env.REACT_APP_API_BASE_URL || 'http://localhost:2089',
  // BASE_URL: 'http://10.117.28.13:3000',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  getAuthHeaders() {
    const token = localStorage.getItem('access_token');
    return token
      ? { ...this.headers, 'Authorization': `Bearer ${token}` }
      : { ...this.headers };
  }
};
// ==================== telemetry API ====================

export async function getTelemetryOverview() {
  return apiFetch(
    `${API_CONFIG.BASE_URL}/db/admin/telemetry/overview`
  );
}

export async function getTelemetryModels() {
  return apiFetch(
    `${API_CONFIG.BASE_URL}/db/admin/telemetry/models`
  );
}

export async function getTelemetryUsers() {
  return apiFetch(
    `${API_CONFIG.BASE_URL}/db/admin/telemetry/users`
  );
}

export async function getRecentTelemetry() {
  return apiFetch(
    `${API_CONFIG.BASE_URL}/db/admin/telemetry/recent`
  );
}



// ==================== ERROR CLASSES ====================
class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    // Extract request_id from response if available (v2.1.0+)
    this.requestId = data?.request_id || null;
  }
}

class TimeoutError extends ApiError {
  constructor(message) {
    super(message, 408, null);
    this.name = 'TimeoutError';
  }
}

class RateLimitError extends ApiError {
  constructor(message, retryAfterSeconds, data) {
    super(message, 429, data);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class FileTooLargeError extends ApiError {
  constructor(message, data) {
    super(message, 413, data);
    this.name = 'FileTooLargeError';
  }
}

// ==================== BASE FETCH WRAPPER ====================
/**
 * Base fetch wrapper with timeout, error handling, abort support, and auto-auth.
 * Automatically attaches Bearer token from localStorage.
 * On 401, attempts token refresh then retries the original request once.
 * @param {string} url - Full request URL
 * @param {RequestInit} options - Fetch options
 * @param {boolean} [options.skipAuth] - Skip auth header injection (for login/refresh calls)
 * @returns {Promise<any>} Parsed JSON response
 * @throws {ApiError|TimeoutError}
 */
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

async function apiFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.timeout);

  try {
    // Don't set default Content-Type for FormData (file uploads)
    const baseHeaders = { ...API_CONFIG.headers };
    if (options.body instanceof FormData) {
      delete baseHeaders['Content-Type'];
    }

    // Inject auth header unless skipAuth is true
    const authHeaders = options.skipAuth ? {} : API_CONFIG.getAuthHeaders();

    // Merge headers: baseHeaders <- authHeaders <- options.headers
    const mergedHeaders = {
      ...baseHeaders,
      ...authHeaders,
      ...options.headers,
    };

    // For FormData bodies, never set Content-Type manually;
    // the browser must set it with the correct multipart boundary.
    if (options.body instanceof FormData) {
      delete mergedHeaders['Content-Type'];
    }

    const response = await fetch(url, {
      ...options,
      headers: mergedHeaders,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      // On 401, try to refresh token and retry once
      if (response.status === 401 && !options.skipAuth) {
        return handle401AndRetry(url, options);
      }

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        throw new RateLimitError(
          data?.detail || `Rate limit exceeded. Try again in ${retryAfter}s.`,
          retryAfter,
          data
        );
      }

      // Handle file too large (413)
      if (response.status === 413) {
        throw new FileTooLargeError(
          data?.detail || 'File too large.',
          data
        );
      }

      // Extract error detail from new API format (v2.1.0+)
      const errorDetail = data?.detail
        || (typeof data === 'string' ? data : null)
        || `Request failed with status ${response.status}`;

      throw new ApiError(errorDetail, response.status, data);
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new TimeoutError(`Request timed out after ${API_CONFIG.timeout / 1000}s`);
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(error.message, 0, null);
  }
}

/**
 * Handle 401 by refreshing the token and retrying the original request.
 * Serializes concurrent 401s to avoid multiple refresh calls.
 */
async function handle401AndRetry(url, options) {
  // If a refresh is already in progress, wait for it
  if (isRefreshing) {
    return new Promise((resolve, reject) => {
      failedQueue.push({ resolve, reject });
    })
      .then(() => apiFetch(url, options))
      .catch(err => Promise.reject(err));
  }

  isRefreshing = true;

  try {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) {
      // Clear stale state and let the UI redirect to login
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('email');
      throw new ApiError('Session expired. Please log in again.', 401, null);
    }

    const response = await fetch(`${API_CONFIG.BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // Refresh failed - clear all auth state
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('email');
      throw new ApiError('Session expired. Please log in again.', 401, null);
    }

    const data = await response.json();
    localStorage.setItem('access_token', data.access_token);
    localStorage.setItem('refresh_token', data.refresh_token);

    processQueue(null, data.access_token);
    isRefreshing = false;

    // Retry the original request
    return apiFetch(url, options);
  } catch (error) {
    processQueue(error, null);
    isRefreshing = false;
    throw error;
  }
}

// ==================== HEALTH CHECK ====================

/**
 * Check global API health
 * @returns {Promise<Object>}
 */
export async function checkHealth() {
  return apiFetch(`${API_CONFIG.BASE_URL}/health`);
}

/**
 * Check document API health
 * @returns {Promise<Object>}
 */
export async function checkDocumentHealth() {
  return apiFetch(`${API_CONFIG.BASE_URL}/documents/health`);
}

// ==================== DATABASE API SERVICE (/db/*) ====================

/**
 * Initialize database
 * @returns {Promise<Object>}
 */
export async function initializeDatabase() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/init`, { method: 'POST' });
}

/**
 * Get all practice sessions with optional filters
 * @param {Object} [filters] - Query filters
 * @param {number} [filters.limit] - Maximum number of sessions
 * @param {string} [filters.difficulty] - Filter by difficulty level
 * @returns {Promise<Array>} List of practice sessions
 */
export async function getSessions(filters = {}) {
  const params = new URLSearchParams();
  if (filters.limit) params.append('limit', filters.limit);
  if (filters.difficulty) params.append('difficulty', filters.difficulty);

  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions${query}`);
}

/**
 * Get session scores for graph (timestamp + average_score)
 * @param {Object} [filters] - Query filters
 * @param {number} [filters.limit] - Maximum number of sessions
 * @returns {Promise<Array>} List of sessions with scores
 */
export async function getSessionScores(filters = {}) {
  const params = new URLSearchParams();
  if (filters.limit) params.append('limit', filters.limit);

  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions/scores${query}`);
}

/**
 * Get sessions grouped by difficulty level
 * @param {Object} [options] - Query options
 * @param {number} [options.limit] - Maximum number of sessions per difficulty
 * @returns {Promise<Object>}
 */
export async function getSessionsByDifficulty(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit);

  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions_difficulty${query}`);
}

/**
 * Get single session by ID
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Session details
 */
export async function getSession(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions/${sessionId}`);
}

/**
 * Create new practice session
 * @param {Object} sessionData - Session configuration
 * @param {string} sessionData.session_id - Session UUID
 * @param {string} sessionData.timestamp - ISO timestamp
 * @param {string} sessionData.difficulty_level - Easy, Medium, Hard, Expert
 * @param {string} [sessionData.client_persona] - Client persona
 * @param {string} [sessionData.industry] - Industry sector
 * @param {string} [sessionData.company_size] - Company size
 * @param {number} [sessionData.total_practice_time] - Time in seconds
 * @param {number} [sessionData.document_alignment] - Alignment percentage
 * @param {number} [sessionData.average_score] - Average score
 * @returns {Promise<Object>}
 */
export async function createSession(sessionData) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions`, {
    method: 'POST',
    body: JSON.stringify(sessionData),
  });
}

/**
 * Delete most recent session
 * @returns {Promise<Object>}
 */
export async function deleteLastSession() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions/last`, {
    method: 'DELETE',
  });
}

/**
 * Delete a practice session
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>}
 */
export async function deleteSession(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

/**
 * Update session score
 * @param {string} sessionId - Session UUID
 * @param {number} averageScore - New average score
 * @returns {Promise<Object>}
 */
export async function updateSessionScore(sessionId, averageScore) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/sessions/${sessionId}/score?average_score=${averageScore}`, {
    method: 'PUT',
  });
}

/**
 * Get user statistics and performance metrics
 * @returns {Promise<Object>} Statistics data including total_sessions, average_score, etc.
 */
export async function getStatistics() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/statistics`);
}

/**
 * Get clarity data (last session and average of last 5)
 * @returns {Promise<Object>} Clarity data with 'latest' and 'average' scores
 */
export async function getClarityData() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/clarity`);
}

/**
 * Get dimensions summary (last session vs average of last 5)
 * @returns {Promise<Object>} Dimensions summary
 */
export async function getDimensionsSummary() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/dimensions/summary`);
}

/**
 * Save conversation history for a session
 * @param {string} sessionId - Session UUID
 * @param {Array} messages - List of conversation messages with role and content
 * @returns {Promise<Object>}
 */
export async function saveConversation(sessionId, messages) {
  const formattedMessages = messages.map((msg, idx) => ({
    index: idx,
    role: msg.role || 'user',
    content: msg.content || '',
    timestamp: new Date().toISOString()
  }));

  return apiFetch(`${API_CONFIG.BASE_URL}/db/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      messages: formattedMessages
    }),
  });
}

/**
 * Best-effort save while the page is closing (keepalive lets the request outlive the tab).
 * Browsers cap keepalive bodies at about 64 KB; a longer transcript is simply not saved here.
 * @param {string} sessionId
 * @param {Array} messages
 */
export function saveConversationOnExit(sessionId, messages) {
  const token = localStorage.getItem('access_token');
  try {
    fetch(`${API_CONFIG.BASE_URL}/db/conversations`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        session_id: sessionId,
        messages: messages.map((msg, idx) => ({
          index: idx,
          role: msg.role || 'user',
          content: msg.content || '',
          timestamp: new Date().toISOString(),
        })),
      }),
    }).catch(() => {});
  } catch {
    // ignore: the page is going away
  }
}

/**
 * Get conversation history for a session
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Conversation with messages
 */
export async function getConversation(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/conversations/${sessionId}`);
}

/**
 * Get evaluation results for a session
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Array>} List of evaluations
 */
export async function getEvaluations(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/evaluations/${sessionId}`);
}

/**
 * Load a session's saved report in the shape the Evaluation page shows.
 * @param {Object} session - A session from getSessions()
 * @returns {Promise<Object|null>} The report, or null when the session has none
 */
export async function loadSavedReport(session) {
  const evaluations = await getEvaluations(session.session_id);
  const latest = Array.isArray(evaluations) ? evaluations[0] : null;
  if (!latest) return null;
  let report = {};
  try { report = JSON.parse(latest.report_text || '{}') || {}; } catch { report = {}; }
  return {
    sessionId: session.session_id,
    score: latest.overall_score ?? session.average_score ?? 0,
    report,
    dimensions: latest.dimension_scores || {},
    better_responses: report.better_responses || [],
    fromHistory: true,
    sessionLabel: { persona: session.client_persona || '', timestamp: session.timestamp || latest.timestamp || '' },
  };
}

/** The most recent session that has a saved report, or null. */
export async function loadLatestSavedReport() {
  const sessions = await getSessions({ limit: 50 }); // newest first
  const evaluated = (sessions || []).find(s => s.evaluation || s.average_score);
  return evaluated ? loadSavedReport(evaluated) : null;
}

/**
 * Save evaluation result
 * @param {Object} evaluationData - Complete evaluation data
 * @param {string} evaluationData.session_id - Session UUID
 * @param {number} evaluationData.overall_score - Overall score
 * @param {string} evaluationData.report_text - Feedback text
 * @param {Object} evaluationData.dimension_scores - Dictionary of dimension scores
 * @param {string} [evaluationData.timestamp] - ISO timestamp
 * @returns {Promise<Object>}
 */
export async function saveEvaluation(evaluationData) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/evaluations`, {
    method: 'POST',
    body: JSON.stringify(evaluationData),
  });
}

// ==================== AI SERVICES API (/ai/*) ====================

/**
 * Get AI response from client simulation
 * @param {Object} data - Request data
 * @param {string} data.user_input - User's message
 * @param {string} data.client_type - Difficulty level (Easy, Medium, Hard, Expert)
 * @param {Array} [data.conversation_history] - Previous conversation
 * @param {string} [data.industry] - Industry sector
 * @param {string} [data.company_size] - Company size
 * @param {'auto'|'en'|'fr'} [data.response_language] - Auto-detect EN/FR or force a language
 * @returns {Promise<Object>} Response with client_response
 */
export async function simulateClient(data) {
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/simulate-client`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Response languages the server's voice providers cannot handle (hidden on the setup page).
 * @returns {Promise<{unavailable: string[]}>}
 */
export async function getRealtimeLanguages() {
  return apiFetch(`${API_CONFIG.BASE_URL}/realtime/languages`);
}

/**
 * Create a Nova 2 Sonic speech-to-speech session bootstrap.
 * @param {Object} data - Realtime session context
 * @param {string} data.client_type - Difficulty level
 * @param {string} [data.client_persona] - Practice persona label
 * @param {string} [data.industry] - Industry sector
 * @param {string} [data.company_size] - Company size
 * @param {'auto'|'en'|'fr'} [data.response_language] - Auto-detect EN/FR or force a language
 * @param {string} [data.voice] - Nova voice name
 * @returns {Promise<Object>} WebSocket URL, voice, system prompt, stats URL and pacing
 */
export async function getRealtimeSession(data) {
  return apiFetch(`${API_CONFIG.BASE_URL}/realtime/session`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Analyze sales pitch content
 * @param {string} text - Pitch text to analyze
 * @returns {Promise<Object>} Analysis results
 */
export async function analyzePitch(payload) {
  const body = typeof payload === 'string' ? { text: payload } : payload;
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/analyze`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Generate full structured report with scores
 * @param {Object} data - Report request data
 * @param {string} data.persona - Client persona
 * @param {string} data.pitch_deck - Pitch deck content/summary
 * @param {string} data.speech - Speech/conversation text
 * @param {string} [data.industry] - Industry sector
 * @param {string} [data.company_size] - Company size
 * @returns {Promise<Object>} Full report with score, report, dimensions
 */
export async function generateFullReport(data) {
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/full_report`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Generate sample better responses for the user's weakest turns
 * @param {Object} data - Request payload
 * @param {string} [data.persona] - Client persona
 * @param {string} [data.counterpart_persona] - Counterpart persona
 * @param {string} [data.pitch_deck] - Doc context / pitch deck
 * @param {string} [data.doc_context] - Doc context
 * @param {string} [data.speech] - Conversation transcript
 * @param {string} [data.transcript] - Conversation transcript
 * @param {string} [data.difficulty_level] - Difficulty level
 * @param {string} [data.industry] - Industry
 * @param {string} [data.company_size] - Company size
 * @param {string} [data.scenario_type] - Scenario type
 * @param {string} [data.business_context] - Business context
 * @param {string} [data.response_language] - Response language
 * @returns {Promise<Object>} Object with better_responses array
 */
export async function getSampleBetterResponses(data) {
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/sample-better-responses`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Translate an evaluation report's written feedback (scores are untouched)
 * @param {Object} report - { top_strengths, area_of_improvements, actionable_insights, better_responses }
 * @param {string} targetLanguage - Language code, e.g. 'hi', 'gu'
 * @returns {Promise<Object>} Object with the translated report
 */
export async function translateReport(report, targetLanguage) {
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/translate-report`, {
    method: 'POST',
    body: JSON.stringify({ report, target_language: targetLanguage }),
  });
}

/**
 * Get personalized learning recommendations from past 5 sessions
 * @returns {Promise<Object>} Learning recommendations
 */
export async function getLearningRecommendations() {
  return apiFetch(`${API_CONFIG.BASE_URL}/ai/learning-recommendations`);
}

// ==================== DOCUMENT PROCESSING API (/documents/*) ====================

/**
 * Upload and process a single document
 * @param {File} file - Document file (PDF, PPTX, DOCX)
 * @returns {Promise<Object>} Processed document data
 */
export async function uploadSingleDocument(file) {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/upload/single`, {
    method: 'POST',
    headers: {}, // Remove Content-Type to let browser set boundary
    body: formData,
  });
}

/**
 * Upload and process multiple documents
 * @param {FileList|Array<File>} files - List of document files
 * @returns {Promise<Object>} Processed documents data
 */
export async function uploadMultipleDocuments(files) {
  const formData = new FormData();
  Array.from(files).forEach(file => formData.append('files', file));

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/upload/multiple`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

/**
 * Extract text from PDF file
 * @param {File} file - PDF file
 * @returns {Promise<Object>} Extracted text
 */
export async function extractPdfText(file) {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/extract/pdf`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

/**
 * Extract text from PowerPoint file
 * @param {File} file - PPTX file
 * @returns {Promise<Object>} Extracted text
 */
export async function extractPptxText(file) {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/extract/pptx`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

/**
 * Extract text from Word document
 * @param {File} file - DOCX file
 * @returns {Promise<Object>} Extracted text
 */
export async function extractDocxText(file) {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/extract/docx`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

/**
 * Analyze document structure
 * @param {string} content - Document content string
 * @returns {Promise<Object>} Structure analysis
 */
export async function analyzeDocumentStructure(content) {
  return apiFetch(`${API_CONFIG.BASE_URL}/documents/analyze/structure`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Extract sales-relevant content from document
 * @param {string} content - Document content string
 * @returns {Promise<Object>} Sales content analysis
 */
export async function extractSalesContent(content) {
  return apiFetch(`${API_CONFIG.BASE_URL}/documents/analyze/sales-content`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Create sales-focused summary of document
 * @param {string} content - Document content string
 * @returns {Promise<Object>} Sales summary
 */
export async function createSalesSummary(content) {
  return apiFetch(`${API_CONFIG.BASE_URL}/documents/analyze/sales-summary`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Combine multiple processed documents
 * @param {Object} processedFiles - Dictionary with filename as key and content as value
 * @returns {Promise<Object>} Combined document data
 */
export async function combineDocuments(processedFiles) {
  return apiFetch(`${API_CONFIG.BASE_URL}/documents/combine`, {
    method: 'POST',
    body: JSON.stringify({ processed_files: processedFiles }),
  });
}

/**
 * Full document processing (extract + analyze + summarize)
 * @param {File} file - Document file
 * @returns {Promise<Object>} Complete processed results
 */
export async function processFullDocument(file) {
  const formData = new FormData();
  formData.append('file', file);

  return apiFetch(`${API_CONFIG.BASE_URL}/documents/process/full`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

// ==================== AUTH API ====================

/**
 * Login with email address.
 * Stores access/refresh tokens and email in localStorage.
 * @param {string} email
 * @returns {Promise<Object>} Token response
 */
export async function login(email) {
  const response = await apiFetch(`${API_CONFIG.BASE_URL}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email }),
    skipAuth: true,
  });

  localStorage.setItem('access_token', response.access_token);
  localStorage.setItem('refresh_token', response.refresh_token);
  localStorage.setItem('email', email);
  return response;
}

/**
 * Refresh the access token using the stored refresh token.
 * @returns {Promise<Object>} New token response
 */
export async function refreshToken() {
  const refresh = localStorage.getItem('refresh_token');
  if (!refresh) {
    throw new ApiError('No refresh token available', 401, null);
  }

  const response = await apiFetch(`${API_CONFIG.BASE_URL}/auth/refresh`, {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refresh }),
    skipAuth: true,
  });

  localStorage.setItem('access_token', response.access_token);
  localStorage.setItem('refresh_token', response.refresh_token);
  return response;
}

/**
 * Log out — clear stored tokens and email.
 */
export function logout() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('email');
}

/**
 * Get list of all allowed users (admin only)
 * @returns {Promise<Array>} List of allowed users
 */
export async function getAllUsers() {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/users`);
}

/**
 * Update allowed user's role (admin only)
 * @param {string} email
 * @param {string} role
 * @returns {Promise<Object>}
 */
export async function addUser({ email, full_name, role }) {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/users`, {
    method: 'POST',
    body: JSON.stringify({ email, full_name, role }),
  });
}

/**
 * Upload or replace a user's profile picture (admin only). PNG, JPEG or WebP, up to 2 MB.
 * @param {string} email
 * @param {File} file
 * @returns {Promise<Object>} The user, with photo_url
 */
export async function uploadUserPhoto(email, file) {
  const formData = new FormData();
  formData.append('email', email);
  formData.append('file', file);
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/users/photo`, {
    method: 'POST',
    headers: {},
    body: formData,
  });
}

/**
 * Remove a user's access (admin only). Their past sessions are kept.
 * @param {string} email
 */
export async function removeUser(email) {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/users?email=${encodeURIComponent(email)}`, { method: 'DELETE' });
}

/** Full image URL for a photo_url returned by the API ('' when there is none). */
export function userPhotoSrc(photoUrl) {
  return photoUrl ? `${API_CONFIG.BASE_URL}${photoUrl}` : '';
}

/**
 * Update allowed user's role (admin only)
 * @param {string} email
 * @param {string} role
 * @returns {Promise<Object>}
 */
export async function updateUserRole(email, role) {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/users/role`, {
    method: 'PUT',
    body: JSON.stringify({ email, role }),
  });
}

/**
 * Get developer diagnostics (developer only)
 * @returns {Promise<Object>}
 */
export async function getDeveloperDiagnostics() {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/developer/diagnostics`);
}

/**
 * Get current authenticated user info.
 * @returns {Promise<Object>} Current user with email and is_admin
 */
export async function getCurrentUser() {
  return apiFetch(`${API_CONFIG.BASE_URL}/auth/me`);
}

// ==================== ADMIN API ====================

/**
 * Get admin overview: total users, sessions, evaluations, conversations
 * @returns {Promise<Object>} Admin overview data
 */
export async function getAdminOverview() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/overview`);
}

/**
 * Get all practice sessions across all users (admin only)
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=100] - Maximum sessions
 * @returns {Promise<Object>} All sessions
 */
export async function getAdminAllSessions(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit);
  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/sessions${query}`);
}

/**
 * Get all evaluation results across all users (admin only)
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=100] - Maximum evaluations
 * @returns {Promise<Array>} All evaluations
 */
export async function getAdminAllEvaluations(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit);
  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/evaluations${query}`);
}

/**
 * Get all conversation history across all users (admin only)
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=100] - Maximum conversations
 * @returns {Promise<Array>} All conversations
 */
export async function getAdminAllConversations(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.append('limit', options.limit);
  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/conversations${query}`);
}

/**
 * Initialize database (admin only)
 * @returns {Promise<Object>} Status response
 */
export async function adminInitializeDatabase() {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/init`, { method: 'POST' });
}

/**
 * Admin-only: Get conversation history for any session
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Conversation with messages
 */
export async function adminGetConversation(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/conversations/${sessionId}`);
}

/**
 * Admin-only: Delete any session and its data
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Status response
 */
export async function adminDeleteSession(sessionId) {
  return apiFetch(`${API_CONFIG.BASE_URL}/db/admin/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

// ==================== UTILITY EXPORTS ====================
export { ApiError, TimeoutError, RateLimitError, FileTooLargeError, API_CONFIG };

export default {


  API_CONFIG,
  ApiError,
  TimeoutError,
  RateLimitError,
  FileTooLargeError,

  getTelemetryOverview,
  getTelemetryModels,

  // Auth
  login,
  refreshToken,
  logout,
  getAllUsers,
  getCurrentUser,

  // Health
  checkHealth,
  checkDocumentHealth,

  // DB API
  initializeDatabase,
  getSessions,
  getSession,
  getSessionScores,
  getSessionsByDifficulty,
  createSession,
  deleteLastSession,
  deleteSession,
  updateSessionScore,
  getStatistics,
  getClarityData,
  getDimensionsSummary,
  saveConversation,
  getConversation,
  getEvaluations,
  saveEvaluation,

  // Admin API
  getAdminOverview,
  getAdminAllSessions,
  getAdminAllEvaluations,
  getAdminAllConversations,
  adminInitializeDatabase,
  adminGetConversation,
  adminDeleteSession,

  // AI API
  simulateClient,
  analyzePitch,
  generateFullReport,
  translateReport,
  getSampleBetterResponses,
  getLearningRecommendations,

  // Document API
  uploadSingleDocument,
  uploadMultipleDocuments,
  extractPdfText,
  extractPptxText,
  extractDocxText,
  analyzeDocumentStructure,
  extractSalesContent,
  createSalesSummary,
  combineDocuments,
  processFullDocument,
};
