# Avatar video prompts

Use one portrait as the **starting image** for BOTH clips (image-to-video), 16:9, ~8 s, 720p or 1080p.
Recommended start frames: `cto_male_b.png`, `cfo_female_a.png` (neutral, mouth closed, centred).

## Idle clip (`<name>_idle.mp4`): shown while the salesperson speaks
The person in the image sits still and listens attentively to someone off-camera. Mouth stays closed the
entire time. Natural blinking, one slight nod, a tiny shift in posture, subtle breathing. Static locked-off
camera, no zoom, no camera movement, lighting and background unchanged. No speech, no hand gestures.

## Talking clip (`<name>_talk.mp4`): shown while the coach speaks
The person in the image speaks calmly and directly to the camera in a business meeting, with natural lip
movement, small head movements and occasional blinks, hands still and out of frame. Static locked-off
camera, no zoom, no camera movement, lighting and background unchanged. They say: "Honestly, I'm not
convinced yet. What makes your product different from what we already use, and what would it cost us over
three years?"

## Keep a take only if
- the camera does not drift or zoom
- hands stay still or out of frame
- the mouth stays fully closed in the idle clip
- the first frame of idle and talk look identical
- there is no visible watermark

Drop the keepers into `frontend/public/assets/` and the trimming, looping and app wiring are handled next.
