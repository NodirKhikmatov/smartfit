import express from 'express';
import { fail } from '../admin/routes.js';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// shortcut: anthropometric guesses, not fitted to real customers yet; recalibrate after the pilot's 20-person check (SPEC).
// Each row: the value at XS and the step per size, so index = (value - xs) / step, 0 = XS … 5 = XXL.
// Photo widths (shoulder, hip) are joint-to-joint cm; chest/waist/hip are tape girths in cm; jeans is the waist in inches.
export const CHART = {
  male: { shoulder: [36, 2], hip: [30, 1.8], bmi: [18, 2.5], height: 176, jeans: [28, 2], chest: [86, 6], waist: [72, 6], hips: [88, 6] },
  female: { shoulder: [32, 2], hip: [31, 2], bmi: [17.5, 2.5], height: 164, jeans: [25, 2], chest: [80, 6], waist: [62, 6], hips: [86, 6] },
};
const EYE_TO_HEEL = 0.91; // eye-to-heel distance as a share of stature
const SHOULDER_FACTOR = 1.1; // shoulder landmarks sit at the joints, a little inside the shoulder edge
const HIP_FACTOR = 1.45; // hip landmarks are joint centres; body hip width is wider
// Task 29: how much each way of finding a size counts against height+weight when the weight is known (shortcut: guesses,
// recalibrate with the pilot's per-method fit answers). A partial photo is scaled from a shorter segment, so it counts less.
const INPUT_WEIGHT = { full: 0.6, torso: 0.45, upper: 0.4, usual: 0.7, tape: 0.7 };
// The best confidence each way can reach (2 high, 1 medium, 0 low); it drops one level without a weight or when it and
// the weight disagree by more than one size, and a part not measured (upper: the bottom) caps it at medium.
const BEST = { full: 2, torso: 1, upper: 0, usual: 2, tape: 2 };
export const PHOTO_KINDS = ['full', 'torso', 'upper'];
export const METHODS = [...PHOTO_KINDS, 'usual', 'tape', 'body', 'profile'];
const LEVEL = ['low', 'medium', 'high'];

const idx = (v, [xs, step]) => (v - xs) / step;
const toSize = (i) => SIZES[Math.min(SIZES.length - 1, Math.max(0, Math.round(i)))];
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Pure size maths. One of:
 * - pose = { kind: full|torso|upper, shoulder, hip? }: landmark distances divided by the eye-to-heel span (the browser
 *   scales a partial photo up to it), scale-free. upper has no hip: the bottom then comes from height and weight.
 * - usual = { top?: XS…XXL, waist?: 26…40 }: the customer's usual top size and jeans waist.
 * - tape = { chest?, waist?, hip? }: girths in cm.
 * Each is blended with height+weight. → { sizes, confidence, source, method, measured, measurements } or { error }.
 */
export function estimateSize({ gender, height, weight = null, pose = null, usual = null, tape = null }) {
  const c = CHART[gender];
  // Height+weight index: BMI for girth, plus a little for tall/short people (sleeve and leg length).
  const byHeight = 2 + (height - c.height) / 8;
  const byWeight = weight === null ? null : idx(weight / (height / 100) ** 2, c.bmi) + (height - c.height) / 15;

  let method = 'body', own = {}, photo = null;
  if (pose) {
    method = pose.kind ?? 'full';
    const span = height * EYE_TO_HEEL;
    photo = { shoulder_cm: round1(pose.shoulder * span * SHOULDER_FACTOR), hip_cm: pose.hip == null ? null : round1(pose.hip * span * HIP_FACTOR) };
    // A side-on pose, a crop or a bad landmark gives widths no adult body has.
    if (photo.shoulder_cm < 25 || photo.shoulder_cm > 60 || (photo.hip_cm !== null && (photo.hip_cm < 22 || photo.hip_cm > 60))) return { error: 'implausible' };
    own.top = idx(photo.shoulder_cm, c.shoulder);
    if (photo.hip_cm !== null) own.bottom = idx(photo.hip_cm, c.hip);
  } else if (usual) {
    method = 'usual';
    if (usual.top) own.top = SIZES.indexOf(usual.top);
    if (usual.waist) own.bottom = idx(usual.waist, c.jeans);
  } else if (tape) {
    method = 'tape';
    if (tape.chest) own.top = idx(tape.chest, c.chest);
    const lower = [];
    if (tape.hip) lower.push(idx(tape.hip, c.hips));
    if (tape.waist) lower.push(idx(tape.waist, c.waist));
    if (lower.length) own.bottom = lower.reduce((s, x) => s + x, 0) / lower.length;
  }

  const body = byWeight ?? byHeight;
  const w = INPUT_WEIGHT[method];
  const pick = (part) => (own[part] === undefined ? body : byWeight === null ? own[part] : w * own[part] + (1 - w) * byWeight);
  const measured = ['top', 'bottom'].filter((p) => own[p] !== undefined);

  let level;
  if (method === 'body') level = byWeight === null ? 0 : 1;
  else {
    const agree = byWeight !== null && measured.every((p) => Math.abs(own[p] - byWeight) <= 1); // the strongest signal we have
    level = Math.max(0, BEST[method] - (agree ? 0 : 1));
    if (measured.length < 2) level = Math.min(level, 1);
  }
  const source = method === 'body' ? (byWeight === null ? 'height' : 'weight') : photo ? (byWeight === null ? 'photo' : 'photo+weight') : method;
  return { sizes: { top: toSize(pick('top')), bottom: toSize(pick('bottom')) }, confidence: LEVEL[level], source, method, measured, measurements: photo };
}

const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// An object of only these optional keys, at least one set, each passing its check; else 400 for `field`.
function numbers(v, checks, field) {
  const keys = plain(v) ? Object.keys(v) : [];
  if (!keys.length || keys.some((k) => !Object.hasOwn(checks, k) || !checks[k](v[k]))) throw fail(400, 'err.invalid', { field });
  return v;
}

// Public: POST /api/size { gender, height, weight?, and at most one of pose | usual | tape } →
// { sizes, confidence, source, method, measured, measurements }. Only numbers are accepted: the photo never leaves the
// browser, and nothing here is stored or logged.
export function createSizeRouter() {
  const r = express.Router();
  r.post('/', (req, res) => {
    const b = req.body ?? {};
    if (!plain(b) || Object.keys(b).some((k) => !['gender', 'height', 'weight', 'pose', 'usual', 'tape'].includes(k))) throw fail(400, 'err.bad_request');
    if (!['male', 'female'].includes(b.gender)) throw fail(400, 'err.invalid', { field: 'field.gender' });
    if (!Number.isInteger(b.height) || b.height < 100 || b.height > 230) throw fail(400, 'err.invalid', { field: 'field.height' });
    const weight = b.weight ?? null;
    if (weight !== null && (!Number.isInteger(weight) || weight < 30 || weight > 250)) throw fail(400, 'err.invalid', { field: 'field.weight' });
    const pose = b.pose ?? null, usual = b.usual ?? null, tape = b.tape ?? null;
    if ([pose, usual, tape].filter((x) => x !== null).length > 1) throw fail(400, 'err.bad_request');
    if (pose !== null) {
      // No kind = a full-body client from before task 29 (a cached kiosk shell).
      const kind = plain(pose) ? pose.kind ?? 'full' : null;
      numbers(pose, { kind: (v) => PHOTO_KINDS.includes(v), shoulder: isRatio, hip: (v) => kind !== 'upper' && isRatio(v) }, 'field.pose');
      if (!isRatio(pose.shoulder) || (kind !== 'upper' && !isRatio(pose.hip))) throw fail(400, 'err.invalid', { field: 'field.pose' });
    }
    if (usual !== null) numbers(usual, { top: (v) => SIZES.includes(v), waist: (v) => intIn(v, 26, 40) }, 'field.usual');
    if (tape !== null) numbers(tape, { chest: (v) => intIn(v, 60, 160), waist: (v) => intIn(v, 50, 160), hip: (v) => intIn(v, 60, 170) }, 'field.tape');
    const out = estimateSize({ gender: b.gender, height: b.height, weight, pose, usual, tape });
    if (out.error) throw fail(422, 'err.photo_measure');
    res.json(out);
  });
  return r;
}

// Task 23: per-product fit offset, learnt from "how did it fit?" answers and size returns.
// +1 = runs small (take one size up), -1 = runs big, 0 = true to size.
export const FITS = ['small', 'right', 'big'];
export const FIT_MIN = 5; // fewer answers than this never move a size
// Pure: the owner's override wins; otherwise more than half of at least FIT_MIN answers must agree.
export function fitOffset({ small = 0, right = 0, big = 0 } = {}, override = null) {
  if (override != null) return override;
  const n = small + right + big;
  if (n < FIT_MIN) return 0;
  return small * 2 > n ? 1 : big * 2 > n ? -1 : 0;
}
// The size `offset` steps away in this product's size list, clamped to its ends; unknown sizes stay as they are.
export function shiftSize(sizes, size, offset) {
  const i = sizes.indexOf(size);
  return i < 0 ? size : sizes[Math.min(sizes.length - 1, Math.max(0, i + offset))];
}

// Task 29: the customer's fit preference, one size down / none / up for clothes, applied before the product's fit offset.
export const FIT_PREFS = { tight: -1, regular: 0, loose: 1 };
export const isFit = (v) => typeof v === 'string' && Object.hasOwn(FIT_PREFS, v); // not ['loose'], which hasOwn would coerce
const CLOTHING = ['outerwear', 'top', 'bottom'];
// → { base: the customer's size for this product after their preference, want: base after the product's offset }.
export function wantSize(sizes, category, own, offset, pref = null) {
  const base = CLOTHING.includes(category) ? shiftSize(sizes, own, FIT_PREFS[pref] ?? 0) : own;
  return { base, want: shiftSize(sizes, base, offset) };
}

// One signal per order line: a size return (staff saw it) wins over the customer's own answer.
// → Map product_id → { small, right, big }.
export async function fitStats(db, productIds) {
  const out = new Map();
  if (!productIds.length) return out;
  const sizeReturns = db('order_returns').whereIn('reason', ['too_small', 'too_big']).groupBy('order_item_id').select('order_item_id').max({ reason: 'reason' });
  const rows = await db('order_items as i').leftJoin(sizeReturns.as('r'), 'r.order_item_id', 'i.id').whereIn('i.product_id', productIds)
    .where((w) => w.whereNotNull('i.fit').orWhereNotNull('r.reason')).select('i.product_id', 'i.fit', 'r.reason');
  for (const r of rows) {
    const fit = r.reason === 'too_small' ? 'small' : r.reason === 'too_big' ? 'big' : r.fit;
    const s = out.get(r.product_id) ?? { small: 0, right: 0, big: 0 };
    if (FITS.includes(fit)) s[fit]++;
    out.set(r.product_id, s);
  }
  return out;
}

// products: rows with id and fit_offset (the override) → Map product_id → { small, right, big, auto, override, offset }.
export async function fitOf(db, products) {
  const stats = await fitStats(db, products.map((p) => p.id));
  return new Map(products.map((p) => {
    const s = stats.get(p.id) ?? { small: 0, right: 0, big: 0 };
    return [p.id, { ...s, auto: fitOffset(s), override: p.fit_offset ?? null, offset: fitOffset(s, p.fit_offset) }];
  }));
}
