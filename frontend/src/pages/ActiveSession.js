import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  getRealtimeSession,
  generateFullReport,
  getSampleBetterResponses,
  saveConversation,
  saveConversationOnExit,
  saveEvaluation,
  updateSessionScore,
  analyzePitch,
  ApiError
} from '../services/api';
import useSessionStore from '../store/sessionStore';
import useBrowserTranscription from '../hooks/useBrowserTranscription';
import useCoachSpeaking, { createSpeechTimeline } from '../hooks/useCoachSpeaking';
import { AVATAR_CLIPS, useClipSource } from '../services/avatarClips';
import AvatarVideo from '../components/AvatarVideo';
import {
  MessagesCircle,
} from "lucide-react";

// ── Audio constants for Nova Sonic WebSocket streaming ──────────────────────
const PLAYBACK_START_BUFFER_SEC = 0.25;
const PLAYBACK_SAFETY_GAP_SEC = 0.08;
const VAD_THRESHOLD = 0.018;
const VAD_SILENCE_MS = 1200;
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const COMBINED_SAMPLE_RATE = 24000;
const SPEAKER_SWITCH_GAP_MS = 250;
const ASSISTANT_ACTIVE_HOLD_MS = 700;
// Web Speech API locales for browser-side user transcription (Azure sessions only).
// Voice is ended automatically so a forgotten tab stops streaming to the paid speech and AI services.
const VOICE_IDLE_LIMIT_MS = 3 * 60 * 1000; // nobody spoke and nothing played for this long
const VOICE_MAX_DURATION_MS = 30 * 60 * 1000; // longest single voice connection

const BROWSER_SPEECH_LANG = {
  en: 'en-IN', hi: 'hi-IN', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', it: 'it-IT',
  gu: 'gu-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN', bn: 'bn-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN',
};

function bytesFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function resample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const len = Math.round(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = idx - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

function f32ToPcm16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i] || 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}


function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);

  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function pcm16ToWavBlob(pcmBytes, sampleRate, channels = 1) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const headerSize = 44;

  const buffer = new ArrayBuffer(headerSize + pcmBytes.byteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);

  new Uint8Array(buffer, headerSize).set(pcmBytes);

  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();

  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function pcm16BytesToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));

  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  return samples;
}

function silencePcm16(sampleRate, ms) {
  const frames = Math.floor(sampleRate * ms / 1000);
  return new Uint8Array(frames * 2);
}

function convertPcm16ToCombinedRate(pcmBytes, sourceRate) {
  if (Number(sourceRate) === COMBINED_SAMPLE_RATE) {
    return pcmBytes.slice();
  }

  const floatSamples = pcm16BytesToFloat32(pcmBytes);
  const resampled = resample(floatSamples, Number(sourceRate), COMBINED_SAMPLE_RATE);
  return f32ToPcm16(resampled);
}

function appendToCombinedRecording({ speaker, pcmBytes, sourceRate, combinedChunksRef, lastSpeakerRef }) {
  if (!pcmBytes || !pcmBytes.byteLength) return;

  if (
    combinedChunksRef.current.length > 0 &&
    lastSpeakerRef.current &&
    lastSpeakerRef.current !== speaker
  ) {
    combinedChunksRef.current.push(silencePcm16(COMBINED_SAMPLE_RATE, SPEAKER_SWITCH_GAP_MS));
  }

  const pcmAtCombinedRate = convertPcm16ToCombinedRate(pcmBytes, sourceRate);
  combinedChunksRef.current.push(pcmAtCombinedRate);
  lastSpeakerRef.current = speaker;
}
const ActiveSession = () => {
  const navigate = useNavigate();

  const sessionData = useSessionStore(state => state.currentSession);
  const addMessage = useSessionStore(state => state.addMessage);
  const setEvaluationResult = useSessionStore(state => state.setEvaluationResult);
  const clearConversation = useSessionStore(state => state.clearConversation);

  const [sessionTimer, setSessionTimer] = useState(0);
  const [userMessage, setUserMessage] = useState('');
  const [conversation, setConversation] = useState([]);
  const [error, setError] = useState(null);
  const [hintList, setHintList] = useState([]);
  const [paused, setPaused] = useState(false);
  const [voiceState, setVoiceState] = useState('disconnected');
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [isResponding, setIsResponding] = useState(false);
  const [sessionStatus, setSessionStatus] = useState('Voice session not connected');
  const [pacingConfig, setPacingConfig] = useState({ min_wpm: 90, max_wpm: 180 });
  const [videoPauseFrames, setVideoPauseFrames] = useState({ male: 1.50, female: 3.00 });
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  // Voice gender reported by the session bootstrap, so the avatar matches the voice.
  const [voiceGender, setVoiceGender] = useState(null);
  const [transcriptionMode, setTranscriptionMode] = useState('none');
  // Which realtime backend answered ("azure", "nova", "devnagri"), from the "session opened" info event.
  const [realtimeSource, setRealtimeSource] = useState(null);
  // Set once the backend delivers user transcripts itself; browser transcription then stays off.
  const [serverUserTranscripts, setServerUserTranscripts] = useState(false);
  const [forceAvatarPlay, setForceAvatarPlay] = useState(false);
  const [recordingStats, setRecordingStats] = useState({ userChunks: 0, assistantChunks: 0, combinedChunks: 0 });

  const conversationEndRef = useRef(null);
  const stopInFlightRef = useRef(false); // one Stop & Evaluate at a time, or the conversation is saved twice
  const userVoiceHeardRef = useRef(false); // the mic picked up the user's voice at least once
  const lastVoiceActivityRef = useRef(Date.now());
  const voiceConnectedAtRef = useRef(null);
  const wsRef = useRef(null);
  const playbackCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const [speechTimeline] = useState(createSpeechTimeline);
  const scheduledSourcesRef = useRef(new Set());
  const nextPlayTimeRef = useRef(0);
  const userAudioChunksRef = useRef([]);
  const assistantAudioChunksRef = useRef([]);
  const combinedAudioChunksRef = useRef([]);
  const lastCombinedSpeakerRef = useRef(null);
  const assistantActiveRef = useRef(false);
  const assistantInactiveTimerRef = useRef(null);
  const micCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorNodeRef = useRef(null);
  const analyserRef = useRef(null);
  const micSilentGainRef = useRef(null);
  const vadRef = useRef({ speaking: false, silenceFrames: 0, lastSpeechAt: 0 });
  const turnOrderRef = useRef(0);
  const itemOrderMapRef = useRef(new Map());
  const assistantTranscriptRef = useRef('');
  const activeResponseItemIdRef = useRef(null);
  const greetedRef = useRef(false);
  const browserRecognitionRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const difficulty = sessionData?.difficulty_level || 'Medium';
  const clientRole = sessionData?.client_persona
    ? sessionData.client_persona.split('-')[0].trim()
    : 'Client';

  const avatarGender = voiceGender || ((difficulty === 'Medium' || difficulty === 'Expert') ? 'female' : 'male');
  const avatarClips = AVATAR_CLIPS[avatarGender] || AVATAR_CLIPS.male;
  // Played from memory once fully downloaded (usually already done on the setup page).
  const talkClipSource = useClipSource(avatarClips.talk);
  const idleClipSource = useClipSource(avatarClips.idle);

  // The avatar talks only while the coach is actually audible (from the playback schedule).
  const getPlaybackCtx = useCallback(() => playbackCtxRef.current, []);
  const coachAudible = useCoachSpeaking(getPlaybackCtx, speechTimeline);
  const avatarSpeaking = forceAvatarPlay || (coachAudible && !paused);

  const isConnected = voiceState === 'connected';
  const isConnecting = voiceState === 'connecting';

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setSessionTimer(prev => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    // Scroll only the transcript box. scrollIntoView would also scroll the page's overflow-hidden
    // wrapper, shifting the whole layout up with no way for the user to scroll it back.
    const box = conversationEndRef.current?.closest('.transcript-dropdown-body');
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }, [conversation, streamingAssistantText]);

  useEffect(() => {
    return () => cleanupSonic();
  }, []);

  // Activity for the idle timeout: the user talking, the counterpart talking, or a new transcript line.
  useEffect(() => {
    if (userSpeaking) userVoiceHeardRef.current = true;
    if (userSpeaking || coachAudible) lastVoiceActivityRef.current = Date.now();
  }, [userSpeaking, coachAudible]);
  useEffect(() => { lastVoiceActivityRef.current = Date.now(); }, [conversation.length]);

  useEffect(() => {
    if (!isConnected) { voiceConnectedAtRef.current = null; return undefined; }
    voiceConnectedAtRef.current = Date.now();
    lastVoiceActivityRef.current = Date.now();
    const check = setInterval(() => {
      const now = Date.now();
      let reason = '';
      if (now - lastVoiceActivityRef.current > VOICE_IDLE_LIMIT_MS) {
        reason = `Voice ended after ${VOICE_IDLE_LIMIT_MS / 60000} minutes of silence.`;
      } else if (now - voiceConnectedAtRef.current > VOICE_MAX_DURATION_MS) {
        reason = `Voice ended after the ${VOICE_MAX_DURATION_MS / 60000}-minute limit.`;
      }
      if (reason) {
        stopSonicSession();
        setError(`${reason} Press Start Voice to continue, or Stop & Evaluate to get your report.`);
      }
    }, 5000);
    return () => clearInterval(check);
    // stopSonicSession only touches refs and setters, so a stale copy is fine here
    // eslint-disable-next-line
  }, [isConnected]);

  // Keep the transcript of a session the user leaves without evaluating, so it shows in Practice History.
  useEffect(() => {
    const saveIfUnfinished = (onExit) => {
      const state = useSessionStore.getState();
      const sessionId = state.currentSession?.session_id;
      const messages = state.getConversationForAPI();
      if (!sessionId || messages.length === 0 || stopInFlightRef.current) return;
      if (onExit) saveConversationOnExit(sessionId, messages);
      else saveConversation(sessionId, messages).catch(() => {});
    };
    const onPageHide = () => saveIfUnfinished(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      saveIfUnfinished(false); // leaving the page inside the app
    };
  }, []);

  // Secret testing shortcut: hold F8 to force-play the avatar video.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setForceAvatarPlay(true);
      }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setForceAvatarPlay(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const makeId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const appendConversationMessage = (role, content, itemId) => {
    const text = (content || '').trim();
    if (!text) return;
    let order;
    if (itemId && itemOrderMapRef.current.has(itemId)) {
      order = itemOrderMapRef.current.get(itemId);
    } else {
      order = ++turnOrderRef.current;
    }
    const message = { id: makeId(), role, content: text, order };
    setConversation(prev => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const newText = normalize(message.content);
      const duplicate = prev.some(existing =>
        existing.role === message.role && normalize(existing.content) === newText
      );

      if (duplicate) return prev;

      const updated = [...prev, message];
      updated.sort((a, b) => a.order - b.order);
      return updated;
    });
    addMessage(message);
  };

  const resetAssistantTranscriptBuffer = () => {
    assistantTranscriptRef.current = '';
    setStreamingAssistantText('');
  };

  const mergeAssistantTranscriptDelta = (text) => {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    const current = assistantTranscriptRef.current || '';

    if (!current) {
      assistantTranscriptRef.current = cleaned;
    } else if (cleaned.startsWith(current)) {
      assistantTranscriptRef.current = cleaned;
    } else if (!current.includes(cleaned)) {
      assistantTranscriptRef.current = `${current} ${cleaned}`.trim();
    }

    setStreamingAssistantText(assistantTranscriptRef.current);
  };

  const handleNovaTranscript = (event) => {
    const text = (event.text || '').trim();
    if (!text) return;

    const role = (event.role || '').toLowerCase();
    const itemId = event.content_id || event.item_id || event.id;
    const isFinal = event.final === true;

    if (role === 'user') {
      if (isFinal) {
        setServerUserTranscripts(true);
        handleCompletedUserTurn(text, itemId);
      }
      return;
    }

    if (role === 'assistant' || role === 'ai') {
      if (isFinal) {
        resetAssistantTranscriptBuffer();
        appendConversationMessage('ai', text, itemId);
        setIsResponding(false);
        return;
      }

      setIsResponding(true);
      mergeAssistantTranscriptDelta(text);
    }
  };

  const finalizeAssistantTranscript = (fallbackText = '') => {
    const finalText = (assistantTranscriptRef.current || fallbackText || '').trim();
    assistantTranscriptRef.current = '';
    setStreamingAssistantText('');
    setIsResponding(false);
    if (finalText) {
      appendConversationMessage('ai', finalText);
    }
  };

  const handleCompletedUserTurn = (rawTranscript, itemId) => {
    const transcript = (rawTranscript || '').trim();
    if (!transcript) return;
    appendConversationMessage('user', transcript, itemId);
  };

  const stopBrowserRecognition = () => {
    const recognition = browserRecognitionRef.current;
    if (!recognition) return;
    recognition._shouldRestart = false;
    if (!recognition._isRunning) return;
    try {
      recognition.stop();
    } catch (recognitionError) {
      console.error('Failed to stop browser speech recognition:', recognitionError);
    }
  };

  const startBrowserRecognition = () => {
    // Disabled: using Nova Sonic role-aware transcript events only.
    return;
    const recognition = browserRecognitionRef.current;
    if (!recognition || recognition._isRunning) return;
    recognition._shouldRestart = true;
    try {
      recognition.start();
    } catch (recognitionError) {
      const message = recognitionError?.message || '';
      if (!message.toLowerCase().includes('already started')) {
        console.error('Failed to start browser speech recognition:', recognitionError);
      }
    }
  };

  const setupBrowserRecognition = () => {
    // Disabled intentionally. Nova Sonic backend now provides role-aware transcript events.
    setTranscriptionMode('nova');
    return false;
  };

  useEffect(() => {
    // Browser SpeechRecognition is intentionally disabled because it captures avatar audio
    // and mislabels assistant speech as user speech.
    stopBrowserRecognition();
  }, [isConnected, isMicEnabled, paused, transcriptionMode]);

  // Azure realtime sessions get no user-speech transcripts from the backend, so transcribe the
  // user in the browser instead. Every other provider is untouched.
  useBrowserTranscription({
    enabled: realtimeSource === 'azure' && isConnected && isMicEnabled && !paused && !serverUserTranscripts,
    lang: BROWSER_SPEECH_LANG[sessionData?.response_language] || 'en-IN',
    isCoachAudible: () => assistantActiveRef.current || queueSec() > 0,
    getRecentCoachText: () => [
      assistantTranscriptRef.current,
      ...conversation.filter(m => m.role === 'ai').slice(-2).map(m => m.content),
    ].join(' '),
    onFinal: (text) => handleCompletedUserTurn(text),
  });

  // ── Nova Sonic audio helpers ───────────────────────────────────────────────
  const queueSec = () => {
    return playbackCtxRef.current ? Math.max(0, nextPlayTimeRef.current - playbackCtxRef.current.currentTime) : 0;
  };

  const unlockAudio = async () => {
    const rate = OUTPUT_SAMPLE_RATE;
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      playbackCtxRef.current = new AudioCtx({ sampleRate: rate });
      gainNodeRef.current = playbackCtxRef.current.createGain();
      gainNodeRef.current.gain.value = 1.0;
      gainNodeRef.current.connect(playbackCtxRef.current.destination);
      nextPlayTimeRef.current = 0;
    }
    await playbackCtxRef.current.resume();
  };

  const playPCM = async (b64, sampleRate = OUTPUT_SAMPLE_RATE) => {
    await unlockAudio();
    const bytes = bytesFromB64(b64);
    const n = Math.floor(bytes.byteLength / 2);
    if (!n) return;

    // Capture Nova/client audio for separate and combined WAV downloads.
    assistantAudioChunksRef.current.push(bytes.slice());
    appendToCombinedRecording({
      speaker: 'assistant',
      pcmBytes: bytes,
      sourceRate: Number(sampleRate || OUTPUT_SAMPLE_RATE),
      combinedChunksRef: combinedAudioChunksRef,
      lastSpeakerRef: lastCombinedSpeakerRef
    });

    assistantActiveRef.current = true;
    if (assistantInactiveTimerRef.current) {
      clearTimeout(assistantInactiveTimerRef.current);
    }
    assistantInactiveTimerRef.current = setTimeout(() => {
      assistantActiveRef.current = false;
    }, ASSISTANT_ACTIVE_HOLD_MS);

    updateRecordingStats();

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    const ctx = playbackCtxRef.current;
    const buf = ctx.createBuffer(1, n, Number(sampleRate || OUTPUT_SAMPLE_RATE));
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNodeRef.current);

    const now = ctx.currentTime;
    if (nextPlayTimeRef.current && nextPlayTimeRef.current < now + PLAYBACK_SAFETY_GAP_SEC) {
      // underrun
    }
    const start = Math.max(now + PLAYBACK_START_BUFFER_SEC, nextPlayTimeRef.current || 0);
    scheduledSourcesRef.current.add(src);
    src.onended = () => scheduledSourcesRef.current.delete(src);
    src.start(start);
    speechTimeline.add(start, samples, buf.sampleRate);
    nextPlayTimeRef.current = start + buf.duration;
  };

  // Barge-in: drop coach audio that is queued but not yet heard, so voice and avatar stop together.
  const stopQueuedAudio = () => {
    scheduledSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch {}
    });
    scheduledSourcesRef.current.clear();
    speechTimeline.clear();
    nextPlayTimeRef.current = 0;
  };

  const sendWs = (payload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSessionStatus('Waiting for voice connection...');
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  };

  const startMic = async () => {
    if (micCtxRef.current) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      micCtxRef.current = new AudioCtx();
      await micCtxRef.current.resume();
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      sourceNodeRef.current = micCtxRef.current.createMediaStreamSource(micStreamRef.current);
      analyserRef.current = micCtxRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      processorNodeRef.current = micCtxRef.current.createScriptProcessor(4096, 1, 1);
      sourceNodeRef.current.connect(analyserRef.current);
      sourceNodeRef.current.connect(processorNodeRef.current);
      micSilentGainRef.current = micCtxRef.current.createGain();
      micSilentGainRef.current.gain.value = 0;
      processorNodeRef.current.connect(micSilentGainRef.current);
      micSilentGainRef.current.connect(micCtxRef.current.destination);

      processorNodeRef.current.onaudioprocess = (e) => {
        if (!isMicEnabledRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const level = rms(input);
        const micbar = document.getElementById('micbar');
        if (micbar) micbar.style.width = `${Math.min(100, Math.round(level * 280))}%`;

        // client-side VAD
        const now = performance.now();
        const vad = vadRef.current;
        if (level > VAD_THRESHOLD) {
          if (!vad.speaking) {
            vad.speaking = true;
            setUserSpeaking(true);
            setIsResponding(false);
            setSessionStatus('Listening...');
          }
          vad.lastSpeechAt = now;
          vad.silenceFrames = 0;
        } else if (vad.speaking) {
          if (now - vad.lastSpeechAt > VAD_SILENCE_MS) {
            vad.speaking = false;
            setUserSpeaking(false);
            setSessionStatus('Reviewing your last point...');
            sendWs({ type: 'end' });
          }
        }

        const pcm = f32ToPcm16(resample(input, micCtxRef.current.sampleRate, INPUT_SAMPLE_RATE));

        // Capture user mic audio for separate and combined WAV downloads.
        userAudioChunksRef.current.push(pcm.slice());
        if (!assistantActiveRef.current) {
          appendToCombinedRecording({
            speaker: 'user',
            pcmBytes: pcm,
            sourceRate: INPUT_SAMPLE_RATE,
            combinedChunksRef: combinedAudioChunksRef,
            lastSpeakerRef: lastCombinedSpeakerRef
          });
        }
        updateRecordingStats();

        sendWs({ type: 'audio', audio: b64FromBytes(pcm) });
      };
    } catch (err) {
      console.error('Failed to start microphone:', err);
      setError('Microphone access failed. Please allow microphone permissions.');
    }
  };

  const stopMic = () => {
    if (processorNodeRef.current) {
      try { processorNodeRef.current.disconnect(); } catch {}
      processorNodeRef.current = null;
    }
    if (micSilentGainRef.current) {
      try { micSilentGainRef.current.disconnect(); } catch {}
      micSilentGainRef.current = null;
    }
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect(); } catch {}
      sourceNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (micCtxRef.current) {
      try { micCtxRef.current.close(); } catch {}
      micCtxRef.current = null;
    }
    analyserRef.current = null;
    const micbar = document.getElementById('micbar');
    if (micbar) micbar.style.width = '0%';
  };


  const updateRecordingStats = () => {
    setRecordingStats({
      userChunks: userAudioChunksRef.current.length,
      assistantChunks: assistantAudioChunksRef.current.length,
      combinedChunks: combinedAudioChunksRef.current.length
    });
  };

  const resetAudioRecordings = () => {
    userAudioChunksRef.current = [];
    assistantAudioChunksRef.current = [];
    combinedAudioChunksRef.current = [];
    lastCombinedSpeakerRef.current = null;
    assistantActiveRef.current = false;

    if (assistantInactiveTimerRef.current) {
      clearTimeout(assistantInactiveTimerRef.current);
      assistantInactiveTimerRef.current = null;
    }

    setRecordingStats({ userChunks: 0, assistantChunks: 0, combinedChunks: 0 });
  };

  const cleanupSonic = () => {
    if (connectionTimeoutRef.current) {
      window.clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    stopBrowserRecognition();
    browserRecognitionRef.current = null;
    setRealtimeSource(null);
    setServerUserTranscripts(false);
    stopMic();

    const ws = wsRef.current;
    if (ws) {
      try { ws.close(1000, 'client cleanup'); } catch {}
      wsRef.current = null;
    }

    if (playbackCtxRef.current) {
      try { playbackCtxRef.current.close(); } catch {}
      playbackCtxRef.current = null;
      gainNodeRef.current = null;
      nextPlayTimeRef.current = 0;
    }
    scheduledSourcesRef.current.clear();
    speechTimeline.clear();

    turnOrderRef.current = 0;
    itemOrderMapRef.current = new Map();
    assistantTranscriptRef.current = '';
    activeResponseItemIdRef.current = null;
    greetedRef.current = false;
    setStreamingAssistantText('');
    setIsResponding(false);
    setUserSpeaking(false);
    setTranscriptionMode('none');
  };

  const requestAssistantResponse = ({ opener = false } = {}) => {
    if (opener) {
      let openerText = 'Greet the participant warmly in one short sentence and ask them what topic, scenario, or approach we are discussing today. Keep it brief and conversational.';
      const scenario = sessionData?.scenario_type;
      if (scenario === 'Consulting Engagements') {
        openerText = 'Open the consulting meeting concisely. Ask the consultant to synthesize their diagnostic findings or strategic recommendations.';
      } else if (scenario === 'Stakeholder Management & Alignment') {
        openerText = 'Open the stakeholder meeting professionally. State that your calendar is tight and ask how this initiative impacts your team and priorities.';
      } else if (scenario === 'Executive Presence & C-Suite Briefings') {
        openerText = 'Greet the speaker concisely as an executive decision maker and ask for the bottom-line executive briefing.';
      } else if (scenario === 'Leadership Conversations & Team Coaching') {
        openerText = 'Open the conversation warmly. Ask what key challenge or team priority we should focus on today.';
      } else if (scenario === 'Difficult Performance Discussions & Career Reviews') {
        openerText = 'Open the review session professionally and acknowledge that you are ready to discuss recent progress and goals.';
      } else if (scenario === 'Sales & Commercial Pitches') {
        openerText = 'Greet the salesperson warmly in one short sentence and ask them what product or service they are pitching today. Keep it brief and conversational — no multi-part questions.';
      }
      assistantTranscriptRef.current = '';
      setStreamingAssistantText('');
      setIsResponding(true);
      setSessionStatus('Counterpart is opening the session...');
      sendWs({ type: 'text', text: openerText, opener: true });
      return true;
    }
    return false;
  };

  const handleSonicMessage = (event) => {
    switch (event.type) {
      case 'server_ready':
        setSessionStatus('Voice session connected');
        break;
      case 'info':
        if (event.message?.toLowerCase().includes('session opened')) {
          setRealtimeSource(event.source || null);
          setSessionStatus('Voice session connected');
          if (!greetedRef.current) {
            greetedRef.current = true;
            requestAssistantResponse({ opener: true });
          }
        }
        break;
      case 'warning':
        console.warn('[Sonic warning]', event.message);
        break;
      case 'error':
        setError(event.message || 'Voice session error');
        setIsResponding(false);
        setSessionStatus('Voice session error');
        break;
      case 'audio_start':
        setIsResponding(true);
        setSessionStatus(`${clientRole} is speaking...`);
        break;
      case 'audio':
        setIsResponding(true);
        playPCM(event.audio, event.sample_rate).catch(err => console.error('Playback failed:', err));
        break;
      case 'audio_interrupted':
        stopQueuedAudio();
        break;
      case 'audio_end':
        setIsResponding(false);
        setSessionStatus('Waiting for your next turn...');
        // Do not save on audio_end. The backend emits one clean final `transcript` event per turn.
        resetAssistantTranscriptBuffer();
        break;
      case 'transcript':
        handleNovaTranscript(event);
        break;
      case 'text':
        // Legacy fallback only. New backend uses `transcript` events.
        if (event.source === 'nova' && event.text) {
          mergeAssistantTranscriptDelta(event.text);
        }
        break;
      default:
        break;
    }
  };

  const startSonicSession = async () => {
    if (isConnecting || isConnected) return;
    setError(null);
    setSessionStatus('Bootstrapping voice session...');
    setVoiceState('connecting');

    try {
      cleanupSonic();
      resetAudioRecordings();

      const storeSnapshot = useSessionStore.getState();
      const docData = storeSnapshot.documentData;
      // The live counterpart gets the claim-level buyer brief; reports keep using sales_summary.
      const pitchSummary = docData?.buyer_brief || docData?.sales_summary || docData?.combined_content || '';

      const bootstrap = await getRealtimeSession({
        client_type: difficulty,
        client_persona: sessionData?.client_persona || '',
        industry: sessionData?.industry || '',
        company_size: sessionData?.company_size || '',
        scenario_type: sessionData?.scenario_type || 'Sales & Commercial Pitches',
        business_context: sessionData?.business_context || '',
        response_language: sessionData?.response_language || 'auto',
        pitch_summary: pitchSummary.slice(0, 8000),
      });

      setPacingConfig(bootstrap.pacing || { min_wpm: 90, max_wpm: 180 });
      setVideoPauseFrames(bootstrap.video_pause_frames || { male: 1.50, female: 3.00 });
      setVoiceGender(bootstrap.voice_gender || null);

      if (bootstrap.system_prompt) {
        // ensure system prompt returned by backend
      }

      const wsUrl = bootstrap.ws_url;
      if (!wsUrl) throw new Error('Session bootstrap did not return a WebSocket URL.');

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setVoiceState('connected');
        setSessionStatus('Voice session connected');
        if (connectionTimeoutRef.current) {
          window.clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        stopBrowserRecognition();
        setTranscriptionMode('nova');
        sendWs({
          type: 'start',
          session_id: bootstrap.session_id || '',
          voice_id: bootstrap.voice_id || 'matthew',
          system_prompt: bootstrap.system_prompt || '',
        });
        startMic();
      };

      ws.onmessage = (messageEvent) => {
        try {
          const parsed = JSON.parse(messageEvent.data);
          handleSonicMessage(parsed);
        } catch (parseError) {
          console.error('Failed to parse Sonic event:', parseError, messageEvent.data);
        }
      };

      ws.onerror = () => {
        setError('Voice connection failed. Check backend and network.');
        setVoiceState('disconnected');
        setSessionStatus('Voice session failed');
      };

      ws.onclose = () => {
        setVoiceState('disconnected');
        setSessionStatus('Voice session disconnected');
        cleanupSonic();
      };

      connectionTimeoutRef.current = window.setTimeout(() => {
        const open = wsRef.current && wsRef.current.readyState === WebSocket.OPEN;
        if (!open) {
          setError('Voice connection did not open in time. Check that the backend is running and reachable.');
          setVoiceState('disconnected');
          setSessionStatus('Voice connection timeout');
          cleanupSonic();
        }
      }, 15000);
    } catch (sessionError) {
      cleanupSonic();
      setVoiceState('disconnected');
      setSessionStatus('Voice session failed');
      setError(sessionError instanceof ApiError ? sessionError.message : sessionError.message || 'Failed to start voice session');
      console.error('Failed to start Sonic session:', sessionError);
    }
  };

  const stopSonicSession = () => {
    cleanupSonic();
    setVoiceState('disconnected');
    setSessionStatus('Voice session stopped');
  };

  // ── Mutations and handlers (evaluation, hints, etc.) ───────────────────────
  const saveConversationMutation = useMutation({
    mutationFn: (variables) => saveConversation(variables.sessionId, variables.messages),
    onError: (error) => console.error('Failed to save conversation:', error)
  });

  const generateReportMutation = useMutation({
    mutationFn: generateFullReport,
    onError: (error) => {
      setError(error instanceof ApiError ? error.message : 'Failed to generate report');
      console.error('Report generation error:', error);
    }
  });

  const saveEvaluationMutation = useMutation({
    mutationFn: saveEvaluation,
    onError: (error) => console.error('Failed to save evaluation:', error)
  });

  const updateScoreMutation = useMutation({
    mutationFn: ({ sessionId, score }) => updateSessionScore(sessionId, score),
    onError: (error) => console.error('Failed to update session score:', error)
  });

  const analyzePitchMutation = useMutation({
    mutationFn: analyzePitch,
    onError: (error) => {
      setError(error instanceof ApiError ? error.message : 'Failed to analyze conversation');
      console.error('Analyze pitch error:', error);
    }
  });

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSendMessage = () => {
    if (!userMessage.trim() || paused) return;
    if (!isConnected) {
      setError('Start the voice session before sending a live practice turn.');
      return;
    }
    const messageText = userMessage.trim();
    setUserMessage('');
    setError(null);
    appendConversationMessage('user', messageText);
    sendWs({ type: 'text', text: messageText });
  };

  const handleClearMessage = () => setUserMessage('');

  const handleStopAndEvaluate = async () => {
    if (!sessionData?.session_id) {
      setError('No active session to evaluate');
      return;
    }
    setError(null);
    const storeState = useSessionStore.getState();
    const docData = storeState.documentData;
    const pitchDeck = docData?.sales_summary || docData?.combined_content || '';
    const speechText = conversation
      .map(msg => `${msg.role === 'user' ? 'User' : clientRole}: ${msg.content}`)
      .join('\n');

    if (!pitchDeck && !speechText) {
      setError('Cannot evaluate: No background document or conversation data available. Please upload a document and have a conversation before stopping the session.');
      return;
    }

    // Some browsers give no user transcript (Azure without transcription), so hearing the user's voice also counts.
    const userTurns = conversation.filter(msg => msg.role === 'user').length;
    if (userTurns === 0 && !userVoiceHeardRef.current) {
      setError("Cannot evaluate yet: you haven't spoken in this session. Talk with the counterpart first, then press Stop & Evaluate.");
      return;
    }

    if (stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    try {
      await saveConversationMutation.mutateAsync({
        sessionId: sessionData.session_id,
        messages: storeState.getConversationForAPI()
      });

      const evalPayload = {
        persona: sessionData?.client_persona || `${sessionData?.difficulty_level || 'Medium'} level counterpart`,
        pitch_deck: pitchDeck || 'No background document was provided for this session.',
        speech: speechText || 'No conversation was recorded during this session.',
        difficulty_level: sessionData?.difficulty_level || 'Medium',
        industry: sessionData?.industry || '',
        company_size: sessionData?.company_size || '',
        scenario_type: sessionData?.scenario_type || 'Sales & Commercial Pitches',
        business_context: sessionData?.business_context || '',
        response_language: 'en' // the evaluation page translates on demand
      };

      const [reportResult, betterResponsesResult] = await Promise.all([
        generateReportMutation.mutateAsync(evalPayload),
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

      await saveEvaluationMutation.mutateAsync({
        session_id: sessionData.session_id,
        overall_score: reportResult.score || 0,
        report_text: JSON.stringify(combinedReport),
        dimension_scores: reportResult.dimensions || {},
        timestamp: new Date().toISOString(),
        total_practice_time: sessionTimer
      });
      await updateScoreMutation.mutateAsync({
        sessionId: sessionData.session_id,
        score: reportResult.score || 0
      });
      const evaluationData = {
        sessionId: sessionData.session_id,
        score: reportResult.score,
        report: combinedReport,
        dimensions: reportResult.dimensions,
        better_responses: betterResponses
      };
      setEvaluationResult(evaluationData);
      useSessionStore.getState().setDocumentData(null);
      navigate('/evaluation');
    } catch (err) {
      stopInFlightRef.current = false; // allow a retry after a failure
      setError(err instanceof ApiError ? err.message : 'Failed to stop session');
      console.error('Stop session error:', err);
    }
  };

  const handleDownloadTranscript = () => {
    const lines = conversation.map(msg => {
      const speaker = msg.role === 'user' ? 'You' : clientRole;
      return `${speaker}: ${msg.content}`;
    });

    const transcriptText = lines.join('\n');

    if (!transcriptText.trim()) {
      setError('No transcript available to download yet.');
      return;
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');

    const blob = new Blob([transcriptText], {
      type: 'text/plain;charset=utf-8'
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `kcoach-transcript-${timestamp}.txt`;

    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };


  const audioTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  const handleDownloadUserAudio = () => {
    if (!userAudioChunksRef.current.length) {
      setError('No user audio available to download yet.');
      return;
    }

    const pcm = concatUint8Arrays(userAudioChunksRef.current);
    const wav = pcm16ToWavBlob(pcm, INPUT_SAMPLE_RATE, 1);
    downloadBlob(`kcoach-user-audio-${audioTimestamp()}.wav`, wav);
  };

  const handleDownloadAssistantAudio = () => {
    if (!assistantAudioChunksRef.current.length) {
      setError('No client audio available to download yet.');
      return;
    }

    const pcm = concatUint8Arrays(assistantAudioChunksRef.current);
    const wav = pcm16ToWavBlob(pcm, OUTPUT_SAMPLE_RATE, 1);
    downloadBlob(`kcoach-client-audio-${audioTimestamp()}.wav`, wav);
  };

  const handleDownloadCombinedAudio = () => {
    if (!combinedAudioChunksRef.current.length) {
      setError('No combined conversation audio available to download yet.');
      return;
    }

    const pcm = concatUint8Arrays(combinedAudioChunksRef.current);
    const wav = pcm16ToWavBlob(pcm, COMBINED_SAMPLE_RATE, 1);
    downloadBlob(`kcoach-full-conversation-${audioTimestamp()}.wav`, wav);
  };

  const handleGetHint = () => {
    setError(null);
    const storeState = useSessionStore.getState();
    const docData = storeState.documentData;
    const pitchSummary = docData?.sales_summary || docData?.combined_content || '';
    const conversationText = conversation
      .map(msg => `${msg.role === 'user' ? 'You' : clientRole}: ${msg.content}`)
      .join('\n');
    analyzePitchMutation.mutate({
      text: conversationText,
      scenario_type: sessionData?.scenario_type || 'Sales & Commercial Pitches',
      client_persona: sessionData?.client_persona || '',
      difficulty_level: sessionData?.difficulty_level || 'Medium',
      business_context: sessionData?.business_context || '',
      industry: sessionData?.industry || '',
      response_language: sessionData?.response_language || 'auto',
      pitch_summary: pitchSummary.slice(0, 8000),
    }, {
      onSuccess: (response) => {
        const newHint = {
          text: response.analysis || 'No analysis available.',
          priority: response.priority || false
        };
        setHintList(prev => {
          const updated = [newHint, ...prev];
          return updated.slice(0, 4);
        });
      }
    });
  };

  const handlePauseSession = () => setPaused(prev => !prev);

  const isMicEnabledRef = useRef(isMicEnabled);
  useEffect(() => { isMicEnabledRef.current = isMicEnabled; }, [isMicEnabled]);

  const handleToggleMic = () => {
    if (!isConnected) {
      setError('Connect the voice session before muting or unmuting the microphone.');
      return;
    }
    setIsMicEnabled(prev => !prev);
  };

  const handleRestart = () => {
    stopSonicSession();
    clearConversation();
    setConversation([]);
    setSessionTimer(0);
    setUserMessage('');
    setHintList([]);
    resetAudioRecordings();
    setError(null);
  };

  return (
    <div className="active-session-modern sc-remix-active-page pad-20">
      <div className="session-header-modern">
        <div className="session-header-left">
          <div className="session-brand">
            <div className="session-brand-icon"><MessagesCircle /></div>
            <h2 className="session-title">Active Session</h2>
          </div>

          {/* <span className={`difficulty-badge difficulty-${difficulty.toLowerCase()}`}>
            {difficulty}
          </span> */}

          <span className={`voice-status-pill voice-status-${voiceState}`}>
            {voiceState === 'connected' ? 'Live' : voiceState === 'connecting' ? 'Connecting' : 'Voice Offline'}
          </span>

          {paused && <span className="paused-badge">⏸ PAUSED</span>}
        </div>

        <div className="session-header-center">
          <div className="timer-display">
            <svg className="timer-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            <span className="timer-value">{formatTime(sessionTimer)}</span>
          </div>
        </div>

        <div className="session-header-right">
          <button className="header-icon-btn" onClick={handlePauseSession} title={paused ? 'Resume' : 'Pause'}>
            {paused ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            )}
          </button>

          <button className="header-icon-btn" onClick={handleRestart} title="Restart Session">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6M23 20v-6h-6" />
              <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
            </svg>
          </button>

          <button
            className="btn-stop-evaluate mini-radius"
            onClick={handleStopAndEvaluate}
            disabled={saveConversationMutation.isPending || generateReportMutation.isPending || saveEvaluationMutation.isPending}
          >
            {saveConversationMutation.isPending || generateReportMutation.isPending || saveEvaluationMutation.isPending ? (
              <span className="btn-loading">
                <span className="loading-spinner" /> Evaluating...
              </span>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                </svg>
                Stop & Evaluate
              </>
            )}
          </button>
        </div>
      </div>

      <div className="session-body">
        <div className="avatar-center-area">
          <div className={`avatar-side-glow avatar-side-glow-left${userSpeaking ? ' speaking' : ''}`}></div>
          <div className={`avatar-side-glow avatar-side-glow-right${userSpeaking ? ' speaking' : ''}`}></div>

          <div
            className="video-avatar-stage"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              borderRadius: 'inherit',
              background: '#020617'
            }}
          >
            {talkClipSource && (idleClipSource || !avatarClips.idle) ? (
              <AvatarVideo
                talkSrc={talkClipSource}
                idleSrc={idleClipSource}
                idleFrameSec={videoPauseFrames[avatarGender] ?? 0}
                speaking={avatarSpeaking}
                framing={avatarClips.framing}
              />
            ) : (
              <div role="status" style={{ color: '#94a3b8', fontSize: '14px' }}>Loading avatar…</div>
            )}
          </div>

          {error && (
            <div className="chat-error-banner">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {isResponding && !streamingAssistantText && (
            <div className="avatar-responding-indicator">
              <div className="typing-dots">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
              <span>{clientRole} is responding...</span>
            </div>
          )}
        </div>

        <div className="session-sidebar">
          <div className="sidebar-card transcript-card">
            <button className="transcript-dropdown-toggle" onClick={() => setTranscriptOpen(prev => !prev)}>
              <h3 className="sidebar-card-title" style={{ marginBottom: 0 }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                Transcription ({conversation.length})
              </h3>
              <svg
                className={`transcript-chevron ${transcriptOpen ? 'transcript-chevron-open' : ''}`}
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            <button
              className="voice-action-btn voice-action-btn-secondary"
              onClick={handleDownloadTranscript}
              disabled={conversation.length === 0}
              style={{ marginTop: '8px', width: '100%' }}
            >
              Download Transcript
            </button>

            <button
              className="voice-action-btn voice-action-btn-secondary"
              onClick={handleDownloadCombinedAudio}
              disabled={recordingStats.combinedChunks === 0}
              style={{ marginTop: '8px', width: '100%' }}
            >
              Download Full Conversation Audio
            </button>

            {/* <details style={{ marginTop: '8px' }}>
              <summary style={{ cursor: 'pointer', color: '#94a3b8', fontSize: '12px' }}>
                Debug audio downloads
              </summary>
              <button
                className="voice-action-btn voice-action-btn-secondary"
                onClick={handleDownloadUserAudio}
                disabled={recordingStats.userChunks === 0}
                style={{ marginTop: '8px', width: '100%' }}
              >
                Download User Audio
              </button>
              <button
                className="voice-action-btn voice-action-btn-secondary"
                onClick={handleDownloadAssistantAudio}
                disabled={recordingStats.assistantChunks === 0}
                style={{ marginTop: '8px', width: '100%' }}
              >
                Download Client Audio
              </button>
            </details> */}

            {transcriptOpen && (
              <div className="transcript-dropdown-body">
                {conversation.length === 0 && !streamingAssistantText ? (
                  <p className="hint-empty">No transcription yet. Start the voice session to see the conversation.</p>
                ) : (
                  <div className="transcript-messages">
                    {conversation.map((msg, index) => (
                      <div key={index} className={`transcript-msg transcript-msg-${msg.role === 'user' ? 'user' : 'ai'}`}>
                        <span className="transcript-msg-sender">{msg.role === 'user' ? 'You' : clientRole}:</span>
                        <span className="transcript-msg-text">{msg.content}</span>
                      </div>
                    ))}
                    {streamingAssistantText && (
                      <div className="transcript-msg transcript-msg-ai">
                        <span className="transcript-msg-sender">{clientRole}:</span>
                        <span className="transcript-msg-text">{streamingAssistantText}</span>
                      </div>
                    )}
                    <div ref={conversationEndRef} />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sidebar-card realtime-control-card">
            <h3 className="sidebar-card-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1v11" />
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M19 10v2a7 7 0 01-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              {clientRole} Voice
            </h3>

            <p className="session-status-line">{sessionStatus}</p>

            <div className="voice-control-grid">
              <button
                className="voice-action-btn"
                onClick={startSonicSession}
                disabled={isConnecting || isConnected}
              >
                {isConnecting ? 'Connecting...' : isConnected ? 'Voice Live' : 'Start Voice'}
              </button>

              <button
                className="voice-action-btn voice-action-btn-secondary"
                onClick={handleToggleMic}
                disabled={!isConnected}
              >
                {isMicEnabled ? 'Mute Mic' : 'Unmute Mic'}
              </button>

              <button
                className="voice-action-btn voice-action-btn-danger"
                onClick={stopSonicSession}
                disabled={!isConnected && !isConnecting}
              >
                End Voice
              </button>
            </div>

            <div className="sidebar-info-grid">
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Target pace</span>
                <span className="sidebar-info-value">{pacingConfig.min_wpm} - {pacingConfig.max_wpm} WPM</span>
              </div>

              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Transcription</span>
                <span className="sidebar-info-value">
                  {transcriptionMode === 'nova'
                    ? 'Live transcript'
                    : 'Waiting for transcript'}
                </span>
              </div>

              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Mic level</span>
                <span className="sidebar-info-value">
                  <div className="meter" style={{ width: '100px', height: '8px', background: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                    <div id="micbar" className="bar" style={{ width: '0%', height: '100%', background: '#22c55e', transition: 'width 0.1s' }}></div>
                  </div>
                </span>
              </div>
            </div>
          </div>
{/*}
          <div className="sidebar-card">
            <h3 className="sidebar-card-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <line x1="2" y1="7" x2="7" y2="7" />
                <line x1="2" y1="17" x2="7" y2="17" />
                <line x1="17" y1="7" x2="22" y2="7" />
                <line x1="17" y1="17" x2="22" y2="17" />
              </svg>
              Video Pause Frame
            </h3>
            <div className="sidebar-info-grid">
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Active video</span>
                <span className="sidebar-info-value">{(difficulty === 'Medium' || difficulty === 'Expert') ? 'Female' : 'Male'}</span>
              </div>
            </div>
            <div style={{ marginTop: '8px' }}>
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>
                Male frame (s): <span style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{videoPauseFrames.male.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0"
                max="10"
                step="0.05"
                value={videoPauseFrames.male}
                onChange={(e) => setVideoPauseFrames(prev => ({ ...prev, male: parseFloat(e.target.value) }))}
                style={{ width: '100%', accentColor: '#3b82f6' }}
              />
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '4px', marginTop: '8px' }}>
                Female frame (s): <span style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{videoPauseFrames.female.toFixed(2)}</span>
              </label>
              <input
                type="range"
                min="0"
                max="10"
                step="0.05"
                value={videoPauseFrames.female}
                onChange={(e) => setVideoPauseFrames(prev => ({ ...prev, female: parseFloat(e.target.value) }))}
                style={{ width: '100%', accentColor: '#ec4899' }}
              />
              <p style={{ fontSize: '11px', color: '#64748b', marginTop: '6px', marginBottom: 0 }}>
                Set to 0 to pause at the current frame. Otherwise the video plays naturally until it reaches this frame.
              </p>
            </div>
          </div>
*/}
          <div className="sidebar-card hint-card">
            <h3 className="sidebar-card-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              AI Hints
            </h3>

            <div className="hint-content">
              {hintList.length === 0 ? (
                <p className="hint-empty">No hints yet. Press the button below to get a live coaching tip.</p>
              ) : (
                <ul className="hint-list">
                  {hintList.map((hint, index) => (
                    <li key={index} className={`hint-item ${index === 0 ? 'hint-latest' : ''} ${hint.priority && index === 0 ? 'hint-priority' : ''}`}>
                      {hint.priority && <span className="hint-priority-tag">PRIORITY</span>}
                      {hint.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              className="hint-action-btn"
              onClick={handleGetHint}
              disabled={analyzePitchMutation.isPending}
              title="Get AI Hint"
            >
              {analyzePitchMutation.isPending ? (
                <span className="loading-spinner-small" />
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  Get Hint
                </>
              )}
            </button>
          </div>

          <div className="sidebar-card">
            <h3 className="sidebar-card-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              Session Info
            </h3>

            <div className="sidebar-info-grid">
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Difficulty</span>
                <span className={`sidebar-info-value badge-${difficulty.toLowerCase()}`}>{difficulty}</span>
              </div>
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Persona</span>
                <span className="sidebar-info-value">{sessionData?.client_persona || 'N/A'}</span>
              </div>
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Industry</span>
                <span className="sidebar-info-value">{sessionData?.industry || 'N/A'}</span>
              </div>
              <div className="sidebar-info-item">
                <span className="sidebar-info-label">Company Size</span>
                <span className="sidebar-info-value">{sessionData?.company_size || 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActiveSession;
