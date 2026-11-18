import React, { useEffect, useRef } from 'react';

// Two stacked layers: an idle layer that is always visible, and a talking clip that fades in on top
// while `speaking` is true. Without an idle clip, the idle layer is the talking clip frozen on a
// closed-mouth frame (idleFrameSec). `framing` (optional style: objectPosition/transform) is applied
// to both layers alike, e.g. to centre a subject who sits off-centre in the clip.

const FADE_MS = 100; // useCoachSpeaking starts the fade-in this far ahead of the sound

const mediaStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  objectPosition: 'center',
  display: 'block',
  borderRadius: 'inherit',
  userSelect: 'none',
  pointerEvents: 'none',
};

const playMuted = (video) => {
  const promise = video.play();
  if (promise !== undefined) {
    promise.catch((err) => console.warn('Avatar video play failed:', err?.message || err));
  }
};

export default function AvatarVideo({ talkSrc, idleSrc, idleFrameSec = 0, speaking, framing }) {
  const talkRef = useRef(null);
  const idleRef = useRef(null);

  // Freeze the fallback idle layer on its closed-mouth frame.
  useEffect(() => {
    const idle = idleRef.current;
    if (!idle || idleSrc) return undefined;
    const freeze = () => {
      idle.pause();
      idle.currentTime = Math.min(idleFrameSec, Math.max(0, (idle.duration || idleFrameSec) - 0.05));
    };
    if (idle.readyState >= 1) freeze();
    idle.addEventListener('loadedmetadata', freeze);
    return () => idle.removeEventListener('loadedmetadata', freeze);
  }, [idleSrc, idleFrameSec, talkSrc]);

  useEffect(() => {
    const idle = idleRef.current;
    if (idle && idleSrc) playMuted(idle);
  }, [idleSrc]);

  // The talking clip loops continuously underneath, so showing it is just a fade: no seek or
  // play() start-up delay, and no frozen frame while it fades in.
  useEffect(() => {
    const talk = talkRef.current;
    if (talk) playMuted(talk);
  }, [talkSrc]);

  return (
    <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', overflow: 'hidden' }}>
      <video
        ref={idleRef}
        className="video-avatar-media"
        src={idleSrc || talkSrc}
        muted
        loop
        playsInline
        preload="auto"
        style={{ ...mediaStyle, ...framing }}
      />
      <video
        ref={talkRef}
        className="video-avatar-media"
        src={talkSrc}
        muted
        loop
        playsInline
        preload="auto"
        style={{ ...mediaStyle, ...framing, opacity: speaking ? 1 : 0, transition: `opacity ${FADE_MS}ms linear` }}
      />
    </div>
  );
}
