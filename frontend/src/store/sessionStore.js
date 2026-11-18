import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Session Store - Zustand store for managing session state
 * Uses persist middleware to automatically sync with localStorage
 */
const useSessionStore = create(
  persist(
    (set, get) => ({
      // State
      currentSession: null,
      evaluationResult: null,
      documentData: null,
      conversationHistory: [],
      sessionTimer: 0,
      isSessionActive: false,
      audioRecordingUrl: null,

      // Actions
      setSession: (session, documentData = null) => set({ 
        currentSession: session,
        isSessionActive: !!session,
        // Clear previous evaluation, conversation history, audio, and stale documents
        // so data from a prior session never leaks into a new session
        evaluationResult: null,
        conversationHistory: [],
        documentData: documentData,
        audioRecordingUrl: null,
        sessionTimer: 0
      }),
      
      setDocumentData: (data) => set({ documentData: data }),
      
      clearSession: () => set({ 
        currentSession: null, 
        evaluationResult: null, 
        documentData: null,
        conversationHistory: [],
        sessionTimer: 0,
        isSessionActive: false 
      }),
      
      setEvaluationResult: (result) => set({ evaluationResult: result }),
      
      addMessage: (message) => set((state) => ({
        conversationHistory: [...state.conversationHistory, message]
      })),
      
      clearConversation: () => set({ conversationHistory: [] }),

      setAudioRecordingUrl: (url) => set({ audioRecordingUrl: url }),

      setSessionTimer: (timer) => set({ sessionTimer: timer }),
      
      resetTimer: () => set({ sessionTimer: 0 }),

      // Selectors (derived state)
      getSessionId: () => get().currentSession?.session_id || null,
      
      getConversationForAPI: () => get().conversationHistory.map((msg, idx) => ({
        index: idx,
        role: msg.role || 'user',
        content: msg.content || '',
        timestamp: msg.timestamp || new Date().toISOString()
      }))
    }),
    {
      name: 'salescoach-session-storage',
      // Only persist these fields
      partialize: (state) => ({ 
        currentSession: state.currentSession,
        evaluationResult: state.evaluationResult,
        documentData: state.documentData,
        conversationHistory: state.conversationHistory
      }),
    }
  )
);

export default useSessionStore;
