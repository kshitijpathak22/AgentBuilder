import { useEffect, useState } from 'react';

// Avatar clips per voice gender. `idle` is optional: without it the talking clip is frozen on a closed-mouth frame.
export const AVATAR_CLIPS = {
  male: { talk: '/assets/ceo_male_talk.mp4', idle: '/assets/ceo_male_idle.mp4' },
  female: {
    talk: '/assets/cfo_female_talk.mp4',
    idle: '/assets/cfo_female_idle.mp4',
    // She sits at 60% of the frame width: placing that point at 60% of the box, then shifting left by
    // 10% of the zoomed width, centres her at any box shape. The 1.25 zoom keeps the edges covered.
    framing: { objectPosition: '60% 50%', transform: 'translateX(-12.5%) scale(1.25)', transformOrigin: '50% 0%' },
  },
};

// Each clip is downloaded once, fully, and played from memory. Streaming two ~3 MB clips at the same time
// made the avatar stutter for the first 40-50 s on slower networks; downloading them while the user is on
// the setup page means the session starts with both ready.
const downloads = new Map(); // url -> Promise<object URL>

export function loadClip(url) {
  if (!url) return Promise.reject(new Error('no clip'));
  if (!downloads.has(url)) {
    const download = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch((err) => {
        downloads.delete(url); // allow a retry next time
        throw err;
      });
    downloads.set(url, download);
  }
  return downloads.get(url);
}

export function preloadAvatarClips() {
  Object.values(AVATAR_CLIPS).forEach((clips) => {
    [clips.idle, clips.talk].forEach((url) => {
      if (url) loadClip(url).catch(() => {}); // the session page falls back to streaming
    });
  });
}

/**
 * The playable source for a clip: an in-memory copy once downloaded, the original URL if the download
 * fails (the browser then streams it as before), and null while it is still downloading.
 */
export function useClipSource(url) {
  const [source, setSource] = useState(null);
  useEffect(() => {
    let active = true;
    setSource(null);
    if (!url) return undefined;
    loadClip(url)
      .then((objectUrl) => { if (active) setSource(objectUrl); })
      .catch(() => { if (active) setSource(url); });
    return () => { active = false; };
  }, [url]);
  return source;
}
