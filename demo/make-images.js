// Generates the demo product illustrations in demo/images (one SVG per catalogue SKU): flat-lay garments on one
// studio backdrop, tinted by the product colour. Demo only; real stores upload photos in admin.
// Run: node demo/make-images.js
import { mkdir, writeFile } from 'node:fs/promises';
import { CATALOGUE, IMAGE_DIR } from '../src/db/seed.js';

const C = 200; // canvas 400 × 400, garments centred on x = 200

// Uzbek colour words used by the seed → fabric colour.
export const COLORS = {
  qora: '#2c2b2e', oq: '#f4f2ed', kulrang: '#8f9094', "to'q ko'k": '#27354f', bej: '#d5c09f', jigarrang: '#7a4e30',
  "ko'k": '#4d6f97', qizil: '#a8352f', yashil: '#41694c', sariq: '#d7a53c', zaytun: '#67693f', krem: '#ece2cd',
  bordo: '#6d2433', havorang: '#a8c5de', pushti: '#dba0a9',
};

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const lum = (c) => hex(c).reduce((s, v, i) => s + (v / 255) * [0.299, 0.587, 0.114][i], 0);

function palette(base) {
  const darkFabric = lum(base) < 0.3;
  return {
    base,
    light: mix(base, '#ffffff', darkFabric ? 0.16 : 0.22),
    dark: mix(base, '#000000', darkFabric ? 0.28 : 0.2),
    line: darkFabric ? mix(base, '#ffffff', 0.3) : mix(base, '#000000', 0.32),
    trim: darkFabric ? '#5a5853' : mix(base, '#000000', 0.12),
  };
}

const r = (n) => Math.round(n * 10) / 10;
const pts = (list) => 'M' + list.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L') + ' Z';
// Right half (top to bottom, ending on x = 200) → whole symmetric outline.
const sym = (right) => pts([...right, ...right.slice().reverse().map(([x, y]) => [2 * C - x, y])]);
const mirror = (s) => `${s}<g transform="matrix(-1 0 0 1 400 0)">${s}</g>`;

// Painters. Main shapes get a stroke in their own fill with round joins, which softens every corner.
const shape = (d, fill = 'url(#g)', soft = 8) => `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="${soft}" stroke-linejoin="round"/>`;
const fill = (d, color, o = 1) => `<path d="${d}" fill="${color}"${o < 1 ? ` opacity="${o}"` : ''}/>`;
const stroke = (d, color, w = 2.5, o = 0.6, dash = '') =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${o}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const dot = (x, y, rad, color, o = 1) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="${color}"${o < 1 ? ` opacity="${o}"` : ''}/>`;
const rect = (x, y, w, h, rx, color, o = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${color}"${o < 1 ? ` opacity="${o}"` : ''}/>`;
const METAL = '#c8c1b4';

// ---- Tops and outerwear: one parametric outline.
function topOutline({ neck = 30, sh = 78, len = 318, hem = 74, sleeve = 'long', flare = 0, neckY = 80 }) {
  const R = [[C, neckY], [C + neck, neckY - 2], [C + sh, neckY + 14]];
  if (sleeve === 'long') R.push([C + sh + 34 + flare / 2, 170], [C + sh + 52 + flare, 292], [C + sh + 18 + flare, 298], [C + hem + 2, 160]);
  if (sleeve === 'short') R.push([C + sh + 44, 150], [C + sh + 24, 174], [C + hem + 2, 152]);
  if (sleeve === 'none') R.push([C + sh, neckY + 10], [C + hem - 6, 126], [C + hem + 2, 150]);
  R.push([C + hem + flare, len], [C, len + 3]);
  return sym(R);
}
const crewNeck = (k, neck = 30, dip = 22, y = 80) =>
  fill(`M${C - neck} ${y - 2} Q${C} ${y + 2 * dip} ${C + neck} ${y - 2} Q${C} ${y + dip * 0.4} ${C - neck} ${y - 2} Z`, k.dark) +
  stroke(`M${C - neck - 4} ${y - 1} Q${C} ${y + 2 * dip + 10} ${C + neck + 4} ${y - 1}`, k.line, 2.2, 0.55);
const vNeck = (k, neck = 30, depth = 70, y = 80) =>
  fill(`M${C - neck} ${y - 2} L${C} ${y + depth} L${C + neck} ${y - 2} Q${C} ${y + 14} ${C - neck} ${y - 2} Z`, k.dark) +
  stroke(`M${C - neck - 5} ${y} L${C} ${y + depth + 8} L${C + neck + 5} ${y}`, k.line, 2.2, 0.55);
const cuffs = (k, flare = 0) => mirror(stroke(`M${C + 96 + flare} 280 L${C + 128 + flare} 274`, k.line, 2.2, 0.5));
const hemBand = (k, y = 300, hem = 74, w = 2.2) => stroke(`M${C - hem - 2} ${y} L${C + hem + 2} ${y}`, k.line, w, 0.5);
const folds = (k, long = true) => mirror(stroke(`M${C + 60} 176 Q${C + 54} 206 ${C + 58} 238`, k.line, 2, 0.25) + (long ? stroke(`M${C + 108} 196 Q${C + 116} 214 ${C + 112} 232`, k.line, 2, 0.25) : ''));
const ribs = (k, x0, x1, y0, y1, step = 9) => {
  let s = '';
  for (let x = x0 + step / 2; x < x1; x += step) s += `M${r(x)} ${y0} L${r(x)} ${y1} `;
  return stroke(s, k.line, 1.6, 0.35);
};
const placket = (k, y0, y1, buttons = 5, x = C) => {
  let s = stroke(`M${x} ${y0} L${x} ${y1}`, k.line, 2.2, 0.5);
  for (let i = 0; i < buttons; i++) s += dot(x + 8, y0 + 14 + (i * (y1 - y0 - 28)) / Math.max(1, buttons - 1), 3.6, k.trim);
  return s;
};
const zipper = (k, y0, y1, x = C) => stroke(`M${x} ${y0} L${x} ${y1}`, METAL, 3.2, 0.95) + rect(x - 3, y0 + 4, 6, 14, 2, METAL);
const shirtCollar = (k, y = 80) =>
  fill(`M${C - 30} ${y - 4} L${C - 2} ${y + 34} L${C - 40} ${y + 26} Z`, k.light) + fill(`M${C + 30} ${y - 4} L${C + 2} ${y + 34} L${C + 40} ${y + 26} Z`, k.light) +
  stroke(`M${C - 30} ${y - 4} L${C - 2} ${y + 34} L${C - 40} ${y + 26} Z M${C + 30} ${y - 4} L${C + 2} ${y + 34} L${C + 40} ${y + 26} Z`, k.line, 2, 0.5);
const lapels = (k, y = 80, depth = 120, w = 44) =>
  fill(`M${C - 30} ${y - 2} L${C - 4} ${y + depth} L${C - w} ${y + 40} L${C - 50} ${y + 30} Z`, k.dark) +
  fill(`M${C + 30} ${y - 2} L${C + 4} ${y + depth} L${C + w} ${y + 40} L${C + 50} ${y + 30} Z`, k.dark) +
  stroke(`M${C - 30} ${y - 2} L${C - 4} ${y + depth} L${C - w} ${y + 40} L${C - 50} ${y + 30} M${C + 30} ${y - 2} L${C + 4} ${y + depth} L${C + w} ${y + 40} L${C + 50} ${y + 30}`, k.line, 2, 0.45);
const hood = (k, y = 80, w = 52) => fill(`M${C - w} ${y + 6} Q${C - w - 6} ${y - 46} ${C} ${y - 50} Q${C + w + 6} ${y - 46} ${C + w} ${y + 6} Z`, k.dark);
const pocketFlap = (k, x, y, w = 44) => stroke(`M${x} ${y} L${x + w} ${y}`, k.line, 2.4, 0.55) + fill(`M${x} ${y} L${x + w} ${y} L${x + w} ${y + 10} L${x} ${y + 10} Z`, k.dark, 0.35);
const quilt = (k, y0, y1, step, hem = 74) => {
  let s = '';
  for (let y = y0; y < y1; y += step) s += `M${C - hem - 2} ${y} Q${C} ${y + 7} ${C + hem + 2} ${y} `;
  return stroke(s, k.line, 2.2, 0.45) + mirror(stroke(`M${C + 98} 156 L${C + 120} 150 M${C + 104} 196 L${C + 126} 190 M${C + 110} 236 L${C + 132} 230`, k.line, 2.2, 0.45));
};

const TOPS = {
  tshirt: (k) => shape(topOutline({ sleeve: 'short' })) + crewNeck(k) + mirror(stroke(`M${C + 108} 166 L${C + 126} 152`, k.line, 2, 0.45)) + hemBand(k, 306) + folds(k, false),
  tank: (k) => shape(topOutline({ sleeve: 'none', neck: 26, sh: 42, hem: 70 })) + crewNeck(k, 26, 34) + hemBand(k, 306, 70),
  polo: (k) => shape(topOutline({ sleeve: 'short' })) + crewNeck(k, 28, 10) + shirtCollar(k) + placket(k, 112, 160, 3) + mirror(stroke(`M${C + 108} 166 L${C + 126} 152`, k.line, 2, 0.45)) + hemBand(k, 306),
  longsleeve: (k) => shape(topOutline({})) + crewNeck(k) + cuffs(k) + hemBand(k, 306) + folds(k),
  turtleneck: (k) => shape(topOutline({})) + shape(`M${C - 30} 50 L${C + 30} 50 L${C + 32} 84 L${C - 32} 84 Z`, 'url(#g)', 6) + ribs(k, C - 30, C + 30, 54, 80, 7) + cuffs(k) + ribs(k, C - 74, C + 74, 300, 318),
  sweater: (k) => shape(topOutline({ flare: 4 })) + crewNeck(k, 30, 18) + ribs(k, C - 76, C + 76, 296, 318) + mirror(ribs(k, C + 98, C + 128, 278, 294, 7)) + mirror(stroke(`M${C + 30} 128 Q${C + 36} 200 ${C + 30} 286`, k.line, 2, 0.22)) + stroke(`M${C} 130 L${C} 288`, k.line, 2, 0.18),
  fleece: (k) => shape(topOutline({ flare: 4 })) + shape(`M${C - 32} 60 L${C + 32} 60 L${C + 34} 86 L${C - 34} 86 Z`, 'url(#g)', 6) + zipper(k, 58, 150) + ribs(k, C - 76, C + 76, 302, 318, 12) + cuffs(k, 4) + mirror(fill(`M${C + 40} 130 L${C + 62} 130 L${C + 62} 170 L${C + 40} 170 Z`, k.dark, 0.3)),
  hoodie: (k) => hood(k) + shape(topOutline({ flare: 6 })) + crewNeck(k, 32, 14) + mirror(stroke(`M${C + 14} 92 L${C + 16} 150`, k.trim, 3, 0.9) + dot(C + 16, 153, 3.4, k.trim)) +
    stroke(`M${C - 54} 300 L${C - 44} 222 L${C + 44} 222 L${C + 54} 300`, k.line, 2.4, 0.5) + ribs(k, C - 80, C + 80, 302, 320, 9) + cuffs(k, 6),
  cardigan: (k) => shape(topOutline({})) + vNeck(k, 30, 100) + placket(k, 186, 304, 4, C - 4) + ribs(k, C - 74, C + 74, 300, 318) + cuffs(k) + mirror(stroke(`M${C + 34} 236 L${C + 64} 236 L${C + 64} 270 L${C + 34} 270 Z`, k.line, 2, 0.4)),
  shirt: (k) => shape(topOutline({ hem: 72 })) + crewNeck(k, 28, 6) + shirtCollar(k) + placket(k, 114, 312, 6) + cuffs(k) + mirror(stroke(`M${C + 30} 130 L${C + 58} 130 L${C + 58} 160 L${C + 44} 166 L${C + 30} 160 Z`, k.line, 2, 0.45)) + folds(k),
  blouse: (k) => shape(topOutline({ flare: 14 })) + vNeck(k, 30, 54) + fill(`M${C} 136 L${C - 30} 122 L${C - 26} 150 Z M${C} 136 L${C + 30} 122 L${C + 26} 150 Z`, k.dark) + stroke(`M${C - 4} 140 L${C - 16} 196 M${C + 4} 140 L${C + 14} 192`, k.dark, 4, 0.9) + mirror(stroke(`M${C + 106} 278 Q${C + 118} 286 ${C + 136} 274`, k.line, 2, 0.5)) + folds(k),

  puffer: (k) => shape(topOutline({ len: 330, flare: 8, hem: 80, sh: 82 })) + shape(`M${C - 34} 52 L${C + 34} 52 L${C + 36} 86 L${C - 36} 86 Z`, 'url(#g)', 10) + quilt(k, 120, 330, 38, 80) + zipper(k, 54, 330) + cuffs(k, 8),
  parka: (k) => hood(k, 80, 58) + stroke(`M${C - 58} 86 Q${C - 64} 30 ${C} 26 Q${C + 64} 30 ${C + 58} 86`, '#e9e3d8', 12, 0.95) + shape(topOutline({ len: 346, flare: 10, hem: 82, sh: 82 })) + crewNeck(k, 32, 10) + zipper(k, 88, 346) +
    mirror(pocketFlap(k, C + 26, 254, 46) + pocketFlap(k, C + 30, 150, 38)) + stroke(`M${C - 82} 222 Q${C} 230 ${C + 82} 222`, k.line, 2, 0.4) + cuffs(k, 10),
  coat: (k) => shape(topOutline({ len: 350, hem: 84, flare: 6 })) + lapels(k, 80, 128, 46) + mirror(dot(C + 26, 230, 5, k.trim) + dot(C + 26, 278, 5, k.trim) + pocketFlap(k, C + 36, 268, 40)) + cuffs(k, 6) + stroke(`M${C} 210 L${C} 352`, k.line, 2, 0.4),
  trench: (k) => shape(topOutline({ len: 348, hem: 84, flare: 8 })) + lapels(k, 80, 120, 48) + fill(`M${C - 84} 206 L${C + 84} 206 L${C + 84} 224 L${C - 84} 224 Z`, k.dark, 0.85) + rect(C + 20, 202, 22, 26, 3, 'none') +
    stroke(`M${C + 20} 203 L${C + 42} 203 L${C + 42} 227 L${C + 20} 227 Z`, METAL, 3, 0.95) + mirror(dot(C + 22, 170, 4.5, k.trim) + dot(C + 22, 260, 4.5, k.trim) + stroke(`M${C + 52} 94 L${C + 82} 100`, k.line, 6, 0.35)) + cuffs(k, 8),
  windbreaker: (k) => hood(k, 80, 50) + shape(topOutline({ flare: 10, hem: 78 })) + crewNeck(k, 30, 10) + zipper(k, 88, 318) + mirror(stroke(`M${C + 30} 150 L${C + 62} 136`, METAL, 2.6, 0.9)) + mirror(stroke(`M${C + 100} 284 Q${C + 116} 278 ${C + 134} 284`, k.line, 2.6, 0.55)) + stroke(`M${C - 80} 300 Q${C} 308 ${C + 80} 300`, k.line, 2, 0.45),
  leather: (k) => shape(topOutline({ len: 294, hem: 76, flare: 4 })) + lapels(k, 80, 96, 58) + stroke(`M${C + 22} 92 L${C - 18} 176 L${C - 14} 294`, METAL, 3.2, 0.95) + rect(C + 18, 92, 7, 14, 2, METAL) +
    fill(`M${C - 78} 276 L${C + 78} 276 L${C + 78} 294 L${C - 78} 294 Z`, k.dark, 0.8) + stroke(`M${C + 50} 276 L${C + 50} 294 M${C + 66} 276 L${C + 66} 294`, METAL, 3, 0.9) +
    mirror(stroke(`M${C + 36} 214 L${C + 64} 204`, METAL, 2.6, 0.9)) + stroke(`M${C - 60} 120 Q${C - 70} 170 ${C - 62} 230 M${C + 110} 180 Q${C + 120} 220 ${C + 118} 260`, '#ffffff', 5, 0.12) + cuffs(k, 4),
  denim: (k) => shape(topOutline({ len: 296, hem: 76 })) + shirtCollar(k) + placket(k, 118, 290, 5) + mirror(stroke(`M${C + 24} 128 L${C + 62} 128 L${C + 62} 166 L${C + 24} 166 Z M${C + 24} 140 L${C + 62} 140`, '#c58b45', 2, 0.8, '4 4')) +
    stroke(`M${C - 78} 270 L${C + 78} 270`, '#c58b45', 2, 0.8, '4 4') + cuffs(k),
  bomber: (k) => shape(topOutline({ len: 300, flare: 8, hem: 78 })) + fill(`M${C - 34} 70 L${C + 34} 70 L${C + 36} 92 L${C - 36} 92 Z`, k.dark) + ribs(k, C - 34, C + 34, 72, 90, 6) + zipper(k, 72, 300) +
    fill(`M${C - 80} 284 L${C + 80} 284 L${C + 80} 302 L${C - 80} 302 Z`, k.dark) + ribs(k, C - 80, C + 80, 286, 300, 7) + mirror(stroke(`M${C + 30} 200 L${C + 46} 250`, k.line, 2.6, 0.5)) + cuffs(k, 8),
  blazer: (k) => shape(topOutline({ len: 320, hem: 76 })) + fill(`M${C - 28} 80 L${C} 200 L${C + 28} 80 Z`, '#ece8e1') + lapels(k, 80, 130, 44) + dot(C, 220, 5, k.trim) + dot(C, 256, 5, k.trim) +
    mirror(pocketFlap(k, C + 30, 262, 40)) + stroke(`M${C - 60} 150 L${C - 34} 148`, k.line, 2.4, 0.5) + stroke(`M${C} 230 L${C - 24} 320 M${C} 230 L${C + 24} 320`, k.line, 2, 0.4) + cuffs(k),
  gilet: (k) => shape(topOutline({ sleeve: 'none', neck: 30, sh: 50, hem: 76, len: 312 })) + shape(`M${C - 32} 56 L${C + 32} 56 L${C + 34} 84 L${C - 34} 84 Z`, 'url(#g)', 8) + quilt(k, 118, 312, 36, 76).split('<path').slice(0, 2).join('<path') + zipper(k, 58, 312),
};

// ---- Bottoms.
function legs({ waist = 62, top = 70, crotch = 176, hemY = 342, outHem = 70, inHem = 22, hip = 70 }) {
  return sym([[C, top], [C + waist, top], [C + hip, 130], [C + outHem, hemY], [C + inHem, hemY], [C + 2, crotch]]);
}
const waistband = (k, w = 62, y = 70, h = 18) => fill(`M${C - w} ${y} L${C + w} ${y} L${C + w + 1} ${y + h} L${C - w - 1} ${y + h} Z`, k.dark, 0.7) + mirror(rect(C + 32, y - 2, 6, h + 6, 2, k.dark) + rect(C + 56, y - 2, 6, h + 6, 2, k.dark));
const fly = (k, y0 = 90, y1 = 156) => stroke(`M${C - 2} ${y0} L${C - 2} ${y1 - 12} Q${C - 2} ${y1} ${C - 16} ${y1 - 4} L${C - 16} ${y0}`, k.line, 2, 0.5);
const crease = (k, x = 44, y0 = 150, y1 = 336) => mirror(stroke(`M${C + x} ${y0} L${C + x + 2} ${y1}`, k.line, 1.8, 0.35));
const BOTTOMS = {
  jeans: (k) => shape(legs({})) + waistband(k) + fly(k) + mirror(stroke(`M${C + 62} 92 Q${C + 34} 96 ${C + 28} 120`, '#c58b45', 2, 0.85, '4 4') + stroke(`M${C + 58} 330 L${C + 22} 330`, '#c58b45', 2, 0.8, '4 4')) +
    stroke(`M${C - 18} 156 Q${C} 160 ${C + 18} 156`, k.line, 1.8, 0.4) + dot(C - 26, 98, 2.6, METAL) + dot(C + 26, 98, 2.6, METAL) + dot(C, 80, 3.4, METAL) + crease(k, 46, 200, 320),
  chinos: (k) => shape(legs({ outHem: 62, inHem: 24 })) + waistband(k) + fly(k) + mirror(stroke(`M${C + 62} 92 L${C + 40} 140`, k.line, 2, 0.5)) + dot(C, 80, 3.4, k.trim) + crease(k, 40),
  trousers: (k) => shape(legs({ outHem: 68, inHem: 18 })) + waistband(k, 62, 70, 16) + fly(k) + mirror(stroke(`M${C + 62} 90 L${C + 44} 136`, k.line, 2, 0.5)) + crease(k, 42, 96, 340),
  wide: (k) => shape(legs({ outHem: 104, inHem: 8, waist: 58, hip: 70, top: 64 })) + waistband(k, 58, 64, 24) + fly(k, 90, 150) + mirror(stroke(`M${C + 46} 100 L${C + 54} 338`, k.line, 1.8, 0.3)) + dot(C, 76, 3.4, k.trim),
  joggers: (k) => shape(legs({ outHem: 50, inHem: 22, hemY: 336 })) + fill(`M${C - 64} 66 L${C + 64} 66 L${C + 64} 92 L${C - 64} 92 Z`, k.dark, 0.75) + ribs(k, C - 64, C + 64, 68, 90, 8) +
    stroke(`M${C - 6} 92 Q${C - 12} 120 ${C - 18} 132 M${C + 6} 92 Q${C + 12} 120 ${C + 18} 132`, k.trim, 3, 0.9) + mirror(fill(`M${C + 22} 316 L${C + 52} 316 L${C + 52} 338 L${C + 22} 338 Z`, k.dark, 0.7) + stroke(`M${C + 66} 100 L${C + 52} 150`, k.line, 2, 0.45)),
  leggings: (k) => shape(legs({ outHem: 36, inHem: 14, hip: 64, waist: 58, top: 64 })) + fill(`M${C - 58} 64 L${C + 58} 64 L${C + 58} 92 L${C - 58} 92 Z`, k.dark, 0.6) + mirror(stroke(`M${C + 58} 96 Q${C + 52} 220 ${C + 34} 340`, k.line, 1.8, 0.35)),
  shorts: (k) => shape(legs({ hemY: 210, outHem: 84, inHem: 10, crotch: 168 })) + waistband(k) + fly(k, 90, 148) + mirror(stroke(`M${C + 62} 92 Q${C + 36} 96 ${C + 30} 118`, k.line, 2, 0.5) + stroke(`M${C + 82} 196 L${C + 12} 196`, k.line, 2, 0.45)),
  skirt: (k) => shape(sym([[C, 72], [C + 60, 72], [C + 108, 330], [C, 336]])) + waistband(k, 60, 72, 20).split('<g')[0] + stroke(`M${C + 30} 92 Q${C + 44} 220 ${C + 52} 334`, k.line, 2, 0.3) + stroke(`M${C - 30} 92 Q${C - 44} 220 ${C - 52} 334`, k.line, 2, 0.3) + dot(C + 48, 82, 3, k.trim),
  pleated: (k) => {
    let s = '';
    for (let i = -5; i <= 5; i++) s += `M${C + i * 11} 94 L${C + i * 19} 334 `;
    return shape(sym([[C, 72], [C + 60, 72], [C + 112, 332], [C, 338]])) + fill(`M${C - 60} 72 L${C + 60} 72 L${C + 61} 92 L${C - 61} 92 Z`, k.dark, 0.7) + stroke(s, k.line, 1.8, 0.4);
  },
};

// ---- Shoes: a side view pointing right, drawn twice (a darker one behind) as a pair.
const SHOES = {
  sneaker: (k) => shape(`M86 262 L96 196 Q120 186 140 196 L170 178 Q196 184 214 204 Q262 222 300 238 Q326 248 324 264 Z`) + rect(78, 258, 254, 30, 14, '#f3f1ec') + stroke('M80 274 L330 274', '#cfc9bf', 2, 0.9) +
    stroke('M172 196 L186 214 M186 190 L200 208 M200 198 L212 214', k.line, 3, 0.7) + stroke('M150 240 Q200 212 254 238', k.line, 5, 0.45) + stroke('M268 232 Q300 238 312 258', k.line, 2, 0.4),
  runner: (k) => shape(`M88 258 L98 196 Q122 182 144 194 L172 176 Q200 182 218 202 Q264 220 302 236 Q328 246 326 260 Z`) + fill('M76 256 L334 256 Q338 284 318 290 L94 290 Q74 286 76 256 Z', '#f3f1ec') +
    stroke('M84 274 Q120 266 150 276 Q190 286 226 274 Q266 262 324 276', '#cfc9bf', 2.4, 0.9) + stroke('M110 232 Q170 200 238 236 Q270 252 300 246', '#e9e4da', 6, 0.8) + stroke('M174 194 L188 212 M188 188 L202 206', k.line, 3, 0.7),
  canvas: (k) => shape(`M90 262 L98 210 Q130 200 150 206 L176 200 Q226 214 288 238 Q318 250 318 262 Z`) + rect(84, 258, 244, 24, 8, '#f3f1ec') + fill('M262 240 Q320 246 328 262 L270 262 Z', '#f3f1ec') +
    stroke('M86 272 L326 272', k.line, 2, 0.4) + [168, 184, 200, 216].map((x, i) => dot(x, 214 + i * 3, 3, METAL)).join(''),
  boot: (k) => shape(`M100 270 L104 150 Q134 138 170 148 L176 214 Q240 226 296 242 Q322 252 322 270 Z`) + rect(92, 264, 238, 30, 10, '#3a3631') + stroke('M96 284 L326 284', '#56504a', 3, 0.9) +
    [160, 180, 200].map((y) => dot(178 - (200 - y) * 0.1, y - 4, 3.2, METAL)).join('') + stroke('M150 160 L176 168 M146 180 L178 188 M144 200 L180 208', k.line, 2.6, 0.7) + stroke('M110 150 L170 148', k.light, 6, 0.6),
  chelsea: (k) => shape(`M104 268 L108 140 Q140 132 176 140 L178 212 Q246 224 300 242 Q324 252 322 268 Z`) + fill('M126 146 L158 146 L150 214 L134 214 Z', '#1f1d1c', 0.75) + stroke('M112 140 Q118 120 134 128', k.line, 4, 0.7) +
    rect(96, 264, 232, 18, 6, '#2a2724') + rect(98, 262, 46, 30, 4, '#2a2724'),
  winterboot: (k) => shape(`M98 270 L100 122 Q134 112 174 122 L178 206 Q242 222 296 240 Q324 250 322 270 Z`) + fill('M92 120 Q100 96 136 98 Q174 96 182 120 Q178 140 136 140 Q98 140 92 120 Z', '#ebe4d6') +
    rect(88, 264, 244, 34, 12, '#34302b') + stroke('M92 290 L328 290', '#55504a', 3, 0.9) + stroke('M150 160 L180 164 M148 186 L180 190', k.line, 3, 0.6),
  tallboot: (k) => shape(`M116 272 L114 60 Q146 52 176 60 L176 206 Q240 220 296 242 Q320 252 318 272 Z`) + rect(110, 266, 210, 12, 5, '#1f1d1c') + rect(112, 266, 30, 40, 4, '#1f1d1c') + stroke('M168 70 L170 200', METAL, 2.4, 0.9),
  loafer: (k) => shape(`M98 266 L104 230 Q150 218 196 220 Q256 226 300 244 Q324 254 322 266 Z`) + fill('M98 230 Q140 240 196 222 Q150 214 104 226 Z', k.dark, 0.7) + stroke('M196 228 Q232 222 262 236', k.line, 7, 0.55) +
    rect(94, 262, 234, 12, 5, '#2a2724') + rect(96, 262, 36, 24, 4, '#2a2724'),
  oxford: (k) => shape(`M98 266 L102 222 Q144 208 194 214 Q256 226 302 244 Q326 254 324 266 Z`) + stroke('M170 216 L206 238 M178 214 L196 230', k.line, 2.6, 0.7) + stroke('M256 230 Q270 250 268 264', k.line, 2, 0.5) +
    rect(94, 262, 236, 10, 4, '#1f1d1c') + rect(96, 262, 34, 24, 4, '#1f1d1c'),
  flats: (k) => shape(`M104 264 L108 236 Q160 232 214 236 Q270 240 306 252 Q324 258 322 266 Z`) + fill('M108 236 Q160 248 214 236 Q160 228 108 234 Z', k.dark, 0.8) + stroke('M222 240 L236 232 L234 248 Z', k.line, 3, 0.7) + rect(100, 262, 226, 8, 4, '#2a2724'),
  pump: (k) => shape('M118 212 Q170 240 226 238 Q284 250 316 270 Q330 280 324 292 L300 296 Q236 288 190 268 Q160 256 140 254 L138 300 L124 300 L116 248 Z') +
    fill('M122 216 Q170 238 226 236 Q180 226 150 214 Q134 208 122 216 Z', k.dark, 0.9) + stroke('M140 256 Q190 266 236 286 Q270 296 300 296', k.line, 2, 0.45),
  sandal: (k) => fill('M86 262 Q86 248 120 248 L310 254 Q332 256 330 270 Q328 284 300 284 L110 284 Q86 282 86 262 Z', '#d9c7a6') + fill('M86 270 L330 274 L328 288 L92 286 Z', '#8a6f4e') +
    stroke('M190 254 Q206 214 226 254 M240 256 Q256 222 272 256', 'url(#g)', 13, 1) + stroke('M110 250 Q120 206 150 218 Q168 228 158 252', 'url(#g)', 11, 1) + dot(150, 222, 4, METAL),
  slides: (k) => fill('M86 262 Q86 248 120 248 L310 254 Q332 256 330 270 Q328 284 300 284 L110 284 Q86 282 86 262 Z', k.dark) + stroke('M88 276 L328 278', k.line, 2, 0.5) + shape('M196 254 Q226 196 286 256 Z'),
};

// ---- Accessories.
const ACCESSORIES = {
  scarf: (k) => {
    let fringe = '';
    for (let i = 0; i < 6; i++) fringe += `M${148 + i * 8} 326 L${147 + i * 8} 346 M${212 + i * 8} 312 L${214 + i * 8} 332 `;
    return shape('M136 110 Q200 70 264 110 Q276 150 250 168 L262 312 L208 314 L212 172 L192 170 L194 326 L140 326 L150 160 Q126 146 136 110 Z') + fill('M160 120 Q200 100 240 120 Q244 140 230 150 Q200 136 170 150 Q156 140 160 120 Z', k.dark, 0.6) +
      stroke(fringe, 'url(#g)', 3.4, 1) + stroke('M168 200 L166 300 M234 196 L236 290', k.line, 1.8, 0.3);
  },
  beanie: (k) => shape('M110 268 Q104 130 200 112 Q296 130 290 268 Z') + rect(102, 240, 196, 56, 14, k.dark) + ribs(k, 104, 296, 246, 290, 9) + stroke('M200 116 L200 238 M160 128 Q150 180 150 238 M240 128 Q250 180 250 238', k.line, 1.8, 0.28),
  cap: (k) => shape('M112 236 Q112 128 200 124 Q286 128 290 236 Z') + fill('M232 230 Q300 222 344 238 Q346 256 300 258 Q260 256 230 248 Z', k.dark) + stroke('M200 126 L200 234 M156 140 Q150 190 160 234 M244 140 Q250 190 240 234', k.line, 2, 0.4) + dot(200, 124, 6, k.dark) +
    stroke('M112 236 L232 236', k.line, 2, 0.45),
  gloves: (k) => {
    const glove = `${rect(140, 150, 22, 92, 11, 'url(#g)')}${rect(164, 136, 22, 104, 11, 'url(#g)')}${rect(188, 140, 22, 100, 11, 'url(#g)')}${rect(212, 156, 20, 86, 10, 'url(#g)')}` +
      `${rect(138, 206, 96, 84, 22, 'url(#g)')}<rect x="104" y="196" width="22" height="70" rx="11" fill="url(#g)" transform="rotate(-36 115 231)"/>${rect(140, 284, 92, 34, 6, k.dark)}` + stroke('M162 210 L162 240 M186 210 L186 240 M210 210 L210 240', k.line, 1.8, 0.35);
    return `<g transform="translate(46 -20) rotate(10 186 236)" opacity=".9">${glove.replaceAll('url(#g)', k.dark)}</g><g transform="translate(-16 10) rotate(-6 186 236)">${glove}</g>`;
  },
  belt: (k) => `<g transform="rotate(-14 200 210)">${rect(60, 192, 292, 34, 8, 'url(#g)')}${stroke('M66 198 L346 198 M66 220 L346 220', k.line, 1.6, 0.4, '5 4')}` +
    `${stroke('M66 186 L106 186 L106 232 L66 232 Z', METAL, 6, 1)}${stroke('M86 209 L130 209', METAL, 4, 1)}${rect(120, 188, 14, 42, 3, k.dark)}${[262, 284, 306].map((x) => dot(x, 209, 3.6, k.dark)).join('')}</g>`,
  bag: (k) => stroke('M146 176 Q146 92 200 92 Q254 92 254 176', k.dark, 12, 1) + stroke('M166 176 Q166 112 200 112 Q234 112 234 176', 'url(#g)', 10, 1) +
    shape('M114 170 L286 170 L304 330 L96 330 Z') + fill('M114 170 L286 170 L288 190 L112 190 Z', k.dark, 0.5) + stroke('M106 314 L294 314', k.line, 1.8, 0.4, '5 4') + stroke('M200 190 L200 330', k.line, 1.6, 0.25),
  sunglasses: (k) => `${stroke('M84 196 L60 176 M316 196 L340 176', 'url(#g)', 8, 1)}<path d="M92 190 Q92 176 108 176 L172 176 Q188 176 186 194 L182 230 Q178 252 152 252 L124 252 Q98 252 94 228 Z M214 194 Q212 176 228 176 L292 176 Q308 176 308 190 L306 228 Q302 252 276 252 L248 252 Q222 252 218 230 Z" fill="#26262a" stroke="url(#g)" stroke-width="9" stroke-linejoin="round"/>` +
    stroke('M186 192 Q200 180 214 192', 'url(#g)', 8, 1) + stroke('M110 190 L136 218 M232 190 L258 218', '#ffffff', 5, 0.18),
};

const ART = { ...TOPS, ...BOTTOMS, ...SHOES, ...ACCESSORIES };

function shoes(art, k) {
  const back = palette(mix(k.base, '#000000', 0.18));
  return `<g transform="translate(-30 -26)">${SHOES[art](back).replaceAll('url(#g)', back.base)}</g><g transform="translate(14 20)">${SHOES[art](k)}</g>`;
}

export function svg(art, color) {
  if (!ART[art]) throw new Error(`no art: ${art}`);
  const k = palette(COLORS[color] ?? COLORS.kulrang);
  const body = SHOES[art] ? shoes(art, k) : ART[art](k);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efebe4"/><stop offset="1" stop-color="#e3ddd3"/></linearGradient>
<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="120" y1="50" x2="280" y2="350"><stop offset="0" stop-color="${k.light}"/><stop offset=".55" stop-color="${k.base}"/><stop offset="1" stop-color="${k.dark}"/></linearGradient>
<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="9" stdDeviation="10" flood-color="#3b3226" flood-opacity=".18"/></filter>
</defs>
<rect width="400" height="400" fill="url(#bg)"/>
<g filter="url(#s)">${body}</g>
</svg>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(IMAGE_DIR, { recursive: true });
  for (const p of CATALOGUE) await writeFile(`${IMAGE_DIR}${p.sku}.svg`, svg(p.art, p.color));
  console.log(`${CATALOGUE.length} images → ${IMAGE_DIR}`);
}
