// Task 61: where the live AR mirror draws a garment over the body (pure maths over MediaPipe landmarks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { garmentBox, GARMENT_ART } from '../public/app/pose.js';

// A standing body in a 1000 × 1000 frame: landmarks 0–32, normalised; only the ones the mirror reads matter.
const body = (over = {}) => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  Object.assign(lm, { 11: { x: 0.4, y: 0.3, visibility: 0.9 }, 12: { x: 0.6, y: 0.3, visibility: 0.9 }, 23: { x: 0.43, y: 0.55, visibility: 0.9 },
    24: { x: 0.57, y: 0.55, visibility: 0.9 }, 25: { x: 0.44, y: 0.75, visibility: 0.9 }, 26: { x: 0.56, y: 0.75, visibility: 0.9 },
    27: { x: 0.45, y: 0.95, visibility: 0.9 }, 28: { x: 0.55, y: 0.95, visibility: 0.9 } }, over);
  return lm;
};
const near = (a, b, d = 1) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);
// Where a point of the picture (u, v as shares) lands on an untilted frame.
const at = (b, u, v) => ({ x: b.x + (u - b.ox) * b.w, y: b.y + (v - b.oy) * b.h });

test("a top's own shoulders land on the body's, its hem a little below the hips", () => {
  const b = garmentBox(body(), 'top', 1000, 1000);
  const art = GARMENT_ART.top;
  near(at(b, art.ox - art.width / 2, art.oy).x, 380, 2); // the drawing's left shoulder seam: just outside the joint at 400
  near(at(b, art.ox + art.width / 2, art.oy).x, 620, 2);
  near(at(b, art.ox, art.oy).y, 285, 2);
  const hem = at(b, art.ox, art.hem).y;
  assert.ok(hem > 550 && hem < 600, `hem ${hem}`);
  const coat = garmentBox(body(), 'outerwear', 1000, 1000);
  assert.ok(at(coat, 0.5, GARMENT_ART.outerwear.hem).y > hem, 'a jacket is longer');
  near(b.angle, 0, 0.001);
});

test("trousers' waistband sits above the hip joints and the hem at the ankles; knees stand in for hidden ankles", () => {
  const b = garmentBox(body(), 'bottom', 1000, 1000);
  const art = GARMENT_ART.bottom;
  assert.ok(at(b, art.ox, art.oy).y < 550);
  near(at(b, art.ox, art.hem).y, 958, 10); // just below the ankles at 950
  const kneesOnly = garmentBox(body({ 27: { x: 0.45, y: 0.95, visibility: 0.1 }, 28: { x: 0.55, y: 0.95, visibility: 0.1 } }), 'bottom', 1000, 1000);
  near(kneesOnly.h, b.h, 10);
});

test('the picture tilts with the shoulders, whichever side the camera mirrors', () => {
  const a = garmentBox(body({ 12: { x: 0.6, y: 0.34, visibility: 0.9 } }), 'top', 1000, 1000).angle;
  assert.ok(a > 0.15 && a < 0.25);
  near(garmentBox(body({ 11: { x: 0.6, y: 0.34, visibility: 0.9 }, 12: { x: 0.4, y: 0.3, visibility: 0.9 } }), 'top', 1000, 1000).angle, a, 0.001);
});

test('nothing to draw when that part of the body is out of view, or for shoes', () => {
  assert.equal(garmentBox(null, 'top', 1000, 1000), null);
  assert.equal(garmentBox(body({ 11: { x: 0.4, y: 0.3, visibility: 0.2 } }), 'top', 1000, 1000), null);
  const off = { x: 0, y: 0, visibility: 0 };
  assert.equal(garmentBox(body({ 25: off, 26: off, 27: off, 28: off }), 'bottom', 1000, 1000), null);
  assert.equal(garmentBox(body(), 'shoes', 1000, 1000), null);
  assert.ok(garmentBox(body({ 23: off, 24: off }), 'top', 1000, 1000), 'a waist-up frame still gets the top');
});
