import { useEffect, useState } from 'react';

// Whether the coach is audible right now, worked out from the audio schedule rather than measured:
// every chunk is analysed when it is queued, so its voiced stretches are known in AudioContext time
// before they play. That lets the avatar switch exactly when the sound reaches the speakers
// (output latency included), start fading in just ahead of it, and ride over short pauses.

const FRAME_SEC = 0.02; // analysis window
const VOICE_LEVEL = 0.015; // RMS that counts as voice
const BRIDGE_SEC = 0.45; // pauses shorter than this stay "speaking" (gaps between words and phrases)
const LEAD_SEC = 0.1; // start showing the talking clip this far ahead so it is fully faded in at onset

export function createSpeechTimeline() {
  let segments = []; // [{ start, end }] in AudioContext time, ordered

  const addSegment = (start, end) => {
    const last = segments[segments.length - 1];
    if (last && start - last.end <= BRIDGE_SEC) {
      last.end = Math.max(last.end, end);
    } else {
      segments.push({ start, end });
    }
  };

  return {
    // samples: Float32Array of the chunk, scheduled to start at startTime (AudioContext seconds).
    add(startTime, samples, sampleRate) {
      const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
      let runStart = -1;
      for (let i = 0; i < samples.length; i += frame) {
        const end = Math.min(samples.length, i + frame);
        let sum = 0;
        for (let j = i; j < end; j += 1) sum += samples[j] * samples[j];
        const voiced = Math.sqrt(sum / (end - i)) >= VOICE_LEVEL;
        if (voiced && runStart < 0) runStart = i;
        if (!voiced && runStart >= 0) {
          addSegment(startTime + runStart / sampleRate, startTime + i / sampleRate);
          runStart = -1;
        }
      }
      if (runStart >= 0) addSegment(startTime + runStart / sampleRate, startTime + samples.length / sampleRate);
    },
    clear() {
      segments = [];
    },
    isSpeakingAt(t) {
      segments = segments.filter((s) => s.end >= t - 1); // drop what has long finished
      return segments.some((s) => t >= s.start - LEAD_SEC && t <= s.end);
    },
  };
}

// The AudioContext time currently coming out of the speakers.
const heardTime = (ctx) => {
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
};

export default function useCoachSpeaking(getContext, timeline) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    let current = false;
    let raf = 0;
    const tick = () => {
      const ctx = getContext();
      const next = !!ctx && ctx.state === 'running' && timeline.isSpeakingAt(heardTime(ctx));
      if (next !== current) {
        current = next;
        setSpeaking(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getContext, timeline]);

  return speaking;
}
