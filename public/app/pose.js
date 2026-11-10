// Body measurement in the browser with MediaPipe Pose Landmarker, self-hosted under /vendor (src/vendor.js; a test keeps these in sync).
// Only the kind and at most two ratios leave the device; the image is never uploaded, stored or logged.
export const MEDIAPIPE = '/vendor/tasks-vision@0.10.35';
export const MODEL = '/vendor/models/pose_landmarker_full-5134a3aa.task';
// Landmark ids: eyes, shoulders, hips, and ankles + heels ("feet").
const PARTS = { eyes: [2, 5], shoulders: [11, 12], hips: [23, 24], feet: [27, 28, 29, 30] };
const MID = { eyes: [2, 5], shoulders: [11, 12], hips: [23, 24], feet: [29, 30] };
// Task 29: a photo is scaled from the longest visible vertical segment whose share of stature is known, longest first.
// shortcut: anthropometric guesses (eye 0.91, shoulder 0.80 and hip joint 0.50 of stature above the heel), not fitted to
// real customers; recalibrate them in the pilot with the per-method fit answers (Talab page).
const EYE_TO_HEEL = 0.91;
const SEGMENTS = [['eyes', 'feet', 0.91], ['shoulders', 'feet', 0.80], ['eyes', 'hips', 0.41], ['shoulders', 'hips', 0.30]];

let landmarker = null;
export function loadPose() {
  landmarker ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    return PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' }, runningMode: 'IMAGE', numPoses: 1 });
  })().catch((err) => {
    landmarker = null; // let the next try download again
    throw err;
  });
  return landmarker;
}

// source: a canvas or ImageBitmap of width w and height h. Returns { kind, shoulder, hip? } or null (see poseRatios).
export async function measure(source, w, h) {
  return poseRatios((await loadPose()).detect(source).landmarks[0], w, h);
}

// Live framing hint (task 29): which parts of the body a video frame shows. Same model, run on the <video> itself.
export async function framing(video) {
  return poseParts((await loadPose()).detect(video).landmarks[0]);
}

const ok = (p) => p && p.visibility > 0.5 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
// Pure: { eyes, shoulders, hips, feet } → true when every landmark of that part is clearly inside the frame.
export function poseParts(lm) {
  return Object.fromEntries(Object.entries(PARTS).map(([k, ids]) => [k, !!lm && ids.every((i) => ok(lm[i]))]));
}
// Pure: the hint key for what is missing. The face may be hidden (a mirror selfie): it is never asked for.
export function framingHint(parts) {
  if (!parts.shoulders) return 'kiosk.camera.hint_none';
  if (!parts.hips) return 'kiosk.camera.hint_hips';
  return parts.feet ? 'kiosk.camera.hint_ok' : 'kiosk.camera.hint_feet';
}

// Pure: landmark widths in pixels, divided by the eye-to-heel span, so the server can scale by height. A partial photo
// stands its segment in for that span. Kinds: full (shoulders, hips and feet: top + bottom), torso (shoulders and hips:
// top + bottom), upper (shoulders, hips just out of frame and only guessed for the scale: top only, no hip).
// null = nothing usable: no shoulders, lying, upside down, too far away, or legs spread.
export function poseRatios(lm, w, h) {
  if (!lm) return null;
  const seen = poseParts(lm);
  // shortcut: in a waist-up crop the model still places the hips a little below the frame; that guess only sets the scale.
  const guessed = PARTS.hips.every((i) => lm[i] && lm[i].x >= 0 && lm[i].x <= 1 && lm[i].y >= 0 && lm[i].y <= 1.5);
  const kind = !seen.shoulders ? null : seen.hips ? (seen.feet ? 'full' : 'torso') : guessed ? 'upper' : null;
  if (!kind) return null;
  const [top, bottom, share] = SEGMENTS.find(([a, b]) => seen[a] && (b === 'hips' || kind === 'full'));
  const px = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const mid = ([a, b]) => ({ x: (px(a).x + px(b).x) / 2, y: (px(a).y + px(b).y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const from = mid(MID[top]), to = mid(MID[bottom]), dy = to.y - from.y;
  if (dy < (bottom === 'feet' ? 0.3 : 0.12) * h) return null; // lying down, upside down or too far away
  if (bottom === 'hips' && dy < Math.abs(to.x - from.x)) return null; // the body is tipped over
  const shoulders = dist(px(11), px(12));
  if (kind === 'full' && dist(px(29), px(30)) > 1.5 * shoulders) return null; // legs spread: the span shrinks and sizes come out too big
  const span = dist(from, to) * (EYE_TO_HEEL / share);
  const r = (v) => Math.round((v / span) * 1000) / 1000;
  return kind === 'upper' ? { kind, shoulder: r(shoulders) } : { kind, shoulder: r(shoulders), hip: r(dist(px(23), px(24))) };
}
