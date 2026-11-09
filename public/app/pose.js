// Body measurement in the browser with MediaPipe Pose Landmarker, self-hosted under /vendor (src/vendor.js; a test keeps these in sync).
// Only two ratios leave the device; the image is never uploaded, stored or logged.
export const MEDIAPIPE = '/vendor/tasks-vision@0.10.35';
export const MODEL = '/vendor/models/pose_landmarker_full-5134a3aa.task';
// Eyes, shoulders, hips, ankles and heels must all be in frame for a full-body measurement.
const NEEDED = [2, 5, 11, 12, 23, 24, 27, 28, 29, 30];

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

// source: a canvas or ImageBitmap of width w and height h. Returns { shoulder, hip } or null when the body isn't fully visible.
export async function measure(source, w, h) {
  return poseRatios((await loadPose()).detect(source).landmarks[0], w, h);
}

// Pure: landmark distances in pixels, divided by the eye-to-heel distance so the server can scale by height.
export function poseRatios(lm, w, h) {
  const ok = (p) => p && p.visibility > 0.5 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  if (!lm || !NEEDED.every((i) => ok(lm[i]))) return null;
  const px = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const mid = (a, b) => ({ x: (px(a).x + px(b).x) / 2, y: (px(a).y + px(b).y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const eyes = mid(2, 5), heels = mid(29, 30);
  if (heels.y - eyes.y < 0.3 * h) return null; // lying down, upside down or too far away
  const shoulders = dist(px(11), px(12));
  if (dist(px(29), px(30)) > 1.5 * shoulders) return null; // legs spread: the eye-to-heel span shrinks and sizes come out too big
  const span = dist(eyes, heels);
  const r = (v) => Math.round((v / span) * 1000) / 1000;
  return { shoulder: r(shoulders), hip: r(dist(px(23), px(24))) };
}
