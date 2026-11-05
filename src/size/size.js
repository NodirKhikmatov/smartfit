import express from 'express';
import { fail } from '../admin/routes.js';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// shortcut: anthropometric guesses, not fitted to real customers yet; recalibrate after the pilot's 20-person check (SPEC).
// Each row: the value at XS and the step per size, so index = (value - xs) / step, 0 = XS … 5 = XXL.
const CHART = {
  male: { shoulder: [36, 2], hip: [30, 1.8], bmi: [18, 2.5], height: 176 },
  female: { shoulder: [32, 2], hip: [31, 2], bmi: [17.5, 2.5], height: 164 },
};
const EYE_TO_HEEL = 0.91; // eye-to-heel distance as a share of stature
const SHOULDER_FACTOR = 1.1; // shoulder landmarks sit at the joints, a little inside the shoulder edge
const HIP_FACTOR = 1.45; // hip landmarks are joint centres; body hip width is wider
const PHOTO_WEIGHT = 0.6; // photo vs height+weight when both are known

const idx = (v, [xs, step]) => (v - xs) / step;
const toSize = (i) => SIZES[Math.min(SIZES.length - 1, Math.max(0, Math.round(i)))];
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Pure size maths. pose = { shoulder, hip }: shoulder and hip landmark distances divided by the
 * eye-to-heel distance (scale-free, computed in the browser). Returns sizes for top and bottom.
 */
export function estimateSize({ gender, height, weight = null, pose = null }) {
  const c = CHART[gender];
  // Height+weight index: BMI for girth, plus a little for tall/short people (sleeve and leg length).
  const byHeight = 2 + (height - c.height) / 8;
  const byWeight = weight === null ? null : idx(weight / (height / 100) ** 2, c.bmi) + (height - c.height) / 15;

  let photo = null;
  if (pose) {
    const span = height * EYE_TO_HEEL;
    photo = { shoulder_cm: round1(pose.shoulder * span * SHOULDER_FACTOR), hip_cm: round1(pose.hip * span * HIP_FACTOR) };
    // A side-on pose, a crop or a bad landmark gives widths no adult body has.
    if (photo.shoulder_cm < 25 || photo.shoulder_cm > 60 || photo.hip_cm < 22 || photo.hip_cm > 60) return { error: 'implausible' };
  }

  let top, bottom, confidence, source;
  if (photo) {
    const t = idx(photo.shoulder_cm, c.shoulder), b = idx(photo.hip_cm, c.hip);
    if (byWeight === null) {
      [top, bottom, confidence, source] = [t, b, 'medium', 'photo'];
    } else {
      top = PHOTO_WEIGHT * t + (1 - PHOTO_WEIGHT) * byWeight;
      bottom = PHOTO_WEIGHT * b + (1 - PHOTO_WEIGHT) * byWeight;
      // Photo and weight agreeing within one size is the strongest signal we have.
      confidence = Math.abs(t - byWeight) <= 1 && Math.abs(b - byWeight) <= 1 ? 'high' : 'medium';
      source = 'photo+weight';
    }
  } else if (byWeight !== null) {
    [top, bottom, confidence, source] = [byWeight, byWeight, 'medium', 'weight'];
  } else {
    [top, bottom, confidence, source] = [byHeight, byHeight, 'low', 'height'];
  }
  return { sizes: { top: toSize(top), bottom: toSize(bottom) }, confidence, source, measurements: photo };
}

const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;

// Public: POST /api/size { gender, height, weight?, pose?: { shoulder, hip } } → { sizes, confidence, source, measurements }.
// Only numbers are accepted: the photo never leaves the browser, and nothing here is stored or logged.
export function createSizeRouter() {
  const r = express.Router();
  r.post('/', (req, res) => {
    const b = req.body ?? {};
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['gender', 'height', 'weight', 'pose'].includes(k))) throw fail(400, "Noto'g'ri so'rov");
    if (!['male', 'female'].includes(b.gender)) throw fail(400, "Jins noto'g'ri");
    if (!Number.isInteger(b.height) || b.height < 100 || b.height > 230) throw fail(400, "Bo'y noto'g'ri");
    const weight = b.weight ?? null;
    if (weight !== null && (!Number.isInteger(weight) || weight < 30 || weight > 250)) throw fail(400, "Vazn noto'g'ri");
    const pose = b.pose ?? null;
    if (pose !== null) {
      const keys = typeof pose === 'object' && !Array.isArray(pose) ? Object.keys(pose) : [];
      if (keys.length !== 2 || !isRatio(pose.shoulder) || !isRatio(pose.hip)) throw fail(400, "O'lchov noto'g'ri");
    }
    const out = estimateSize({ gender: b.gender, height: b.height, weight, pose });
    if (out.error) throw fail(422, "Rasmdan o'lchab bo'lmadi. Kameraga to'g'ri qarab, butun tanangiz ko'rinadigan qilib qayta urinib ko'ring");
    res.json(out);
  });
  return r;
}
