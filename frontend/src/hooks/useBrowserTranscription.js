import { useEffect, useRef } from 'react';

// Browser (Web Speech API) transcription of the user's speech. Used only for Azure realtime
// sessions, where the backend has no user-speech transcription. Edge/Chrome only.

const RESTART_BASE_DELAY_MS = 300;
const RESTART_MAX_DELAY_MS = 5000;
const ECHO_WORD_OVERLAP = 0.5;

const toWords = (text) =>
  (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

// The recognizer listens to the raw microphone, so it can hear the coach through the speakers.
// While the coach is audible, a result whose words mostly match what the coach just said is echo.
export function looksLikeCoachEcho(text, coachText) {
  const words = toWords(text);
  if (!words.length) return true;
  const coachWords = new Set(toWords(coachText));
  if (!coachWords.size) return false;
  const overlap = words.filter((w) => coachWords.has(w)).length;
  return overlap / words.length >= ECHO_WORD_OVERLAP;
}

export default function useBrowserTranscription({ enabled, lang, isCoachAudible, getRecentCoachText, onFinal }) {
  const callbacksRef = useRef({});
  callbacksRef.current = { isCoachAudible, getRecentCoachText, onFinal };

  useEffect(() => {
    if (!enabled) return undefined;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      console.warn('[Browser transcription] SpeechRecognition is not supported in this browser; user transcripts unavailable.');
      return undefined;
    }

    let stopped = false;
    let failures = 0;
    let restartTimer = null;
    let coachHeardDuringUtterance = false;

    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const { isCoachAudible: coachAudible, getRecentCoachText: coachText, onFinal: emit } = callbacksRef.current;
      if (coachAudible()) coachHeardDuringUtterance = true;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = (result[0]?.transcript || '').trim();
        const overlappedCoach = coachHeardDuringUtterance;
        coachHeardDuringUtterance = false;
        if (!text) continue;
        if (overlappedCoach && looksLikeCoachEcho(text, coachText())) continue;
        failures = 0;
        emit(text);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopped = true;
        console.warn('[Browser transcription] microphone access for speech recognition was denied.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        failures += 1;
        console.warn('[Browser transcription] recognition error:', event.error);
      }
    };

    // Continuous recognition still ends on its own after silence or errors; keep it running.
    recognition.onend = () => {
      if (stopped) return;
      const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** failures, RESTART_MAX_DELAY_MS);
      restartTimer = setTimeout(() => {
        if (stopped) return;
        try {
          recognition.start();
        } catch (err) {
          console.warn('[Browser transcription] restart failed:', err);
        }
      }, delay);
    };

    try {
      recognition.start();
    } catch (err) {
      console.warn('[Browser transcription] start failed:', err);
    }

    return () => {
      stopped = true;
      clearTimeout(restartTimer);
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
    };
  }, [enabled, lang]);
}
