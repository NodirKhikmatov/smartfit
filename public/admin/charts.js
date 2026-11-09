// Inline SVG charts for the admin (no library). Colours come from ui.css tokens through classes in admin.css.
// Single-series line/area chart with a crosshair tooltip (pointer and arrow keys), and an HTML funnel.
import { niceTicks } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// points: [{ label, value }]; format(v) for the tooltip, tick(v) for the axis. Redraws itself when the box resizes.
export function lineChart(box, points, { format, tick = format, label, xLabel = (p) => p.label }) {
  box.replaceChildren();
  box.classList.add('chart');
  const tip = Object.assign(document.createElement('div'), { className: 'chart-tip' });
  tip.hidden = true;
  tip.setAttribute('aria-live', 'polite'); // arrow keys read the value out
  const svg = svgEl('svg', { role: 'img', 'aria-label': label, focusable: 'false' });
  const frame = Object.assign(document.createElement('div'), { className: 'chart-frame', tabIndex: 0 });
  frame.setAttribute('aria-label', label);
  frame.setAttribute('role', 'group');
  frame.append(svg, tip);
  box.append(frame);
  let active = -1, geom = null;

  function draw() {
    const W = Math.max(box.clientWidth, 280), H = box.clientHeight || 220;
    const pad = { t: 12, r: 16, b: 26, l: 52 };
    const ticks = niceTicks(Math.max(...points.map((p) => p.value), 0));
    const top = ticks.at(-1);
    const x = (i) => pad.l + (points.length < 2 ? 0 : (i * (W - pad.l - pad.r)) / (points.length - 1));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
    geom = { x, y, W, H, pad };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.replaceChildren();
    for (const v of ticks) {
      svg.append(svgEl('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      const t = svgEl('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = tick(v);
      svg.append(t);
    }
    // x labels: first, middle and last, so they never collide.
    for (const i of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]) {
      const t = svgEl('text', { class: 'axis', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' });
      t.textContent = xLabel(points[i]);
      svg.append(t);
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    svg.append(svgEl('path', { class: 'area', d: `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }));
    svg.append(svgEl('path', { class: 'line', d }));
    const last = points.length - 1;
    svg.append(svgEl('circle', { class: 'dot', cx: x(last), cy: y(points[last].value), r: 4 }));
    geom.cross = svgEl('line', { class: 'cross', y1: pad.t, y2: H - pad.b });
    geom.hover = svgEl('circle', { class: 'dot', r: 4 });
    geom.cross.style.display = geom.hover.style.display = 'none';
    svg.append(geom.cross, geom.hover);
    if (active >= 0) show(active);
  }

  function show(i) {
    active = Math.max(0, Math.min(points.length - 1, i));
    const p = points[active], cx = geom.x(active), cy = geom.y(p.value);
    for (const [k, v] of [['x1', cx], ['x2', cx]]) geom.cross.setAttribute(k, v);
    geom.hover.setAttribute('cx', cx);
    geom.hover.setAttribute('cy', cy);
    geom.cross.style.display = geom.hover.style.display = '';
    const strong = Object.assign(document.createElement('strong'), { textContent: format(p.value) });
    tip.replaceChildren(strong, Object.assign(document.createElement('span'), { textContent: p.label }));
    tip.hidden = false;
    // Keep the tooltip inside the chart: flip to the left of the crosshair past the middle.
    tip.style.left = `${cx}px`;
    tip.style.transform = cx > geom.W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
  }
  function hide() {
    active = -1;
    tip.hidden = true;
    if (geom) geom.cross.style.display = geom.hover.style.display = 'none';
  }

  frame.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * geom.W;
    const step = points.length < 2 ? 1 : (geom.W - geom.pad.l - geom.pad.r) / (points.length - 1);
    show(Math.round((px - geom.pad.l) / step));
  });
  frame.addEventListener('pointerleave', hide);
  frame.addEventListener('blur', hide);
  frame.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (e.key === 'Escape') return hide();
    if (!(e.key in moves)) return;
    e.preventDefault();
    const from = active < 0 ? points.length - 1 : active;
    show(Number.isFinite(moves[e.key]) ? from + moves[e.key] : moves[e.key] < 0 ? 0 : points.length - 1);
  });
  draw();
  box.chartObserver?.disconnect(); // the box is redrawn on every refresh: one observer per box, not one per draw
  box.chartObserver = new ResizeObserver(() => geom && Math.abs(box.clientWidth - geom.W) > 4 && draw());
  box.chartObserver.observe(box);
}

// steps: [{ label, value }], the first is the 100% base. Bars are widths of the base; numbers sit beside them.
export function funnelChart(box, steps, { pct }) {
  const base = steps[0]?.value || 0;
  box.replaceChildren(...steps.map((s) => {
    const row = Object.assign(document.createElement('div'), { className: 'funnel-row' });
    const bar = Object.assign(document.createElement('span'), { className: 'funnel-bar' });
    bar.style.width = `${base ? Math.max((s.value / base) * 100, s.value ? 1.5 : 0) : 0}%`;
    const track = Object.assign(document.createElement('span'), { className: 'funnel-track' });
    track.append(bar);
    row.append(
      Object.assign(document.createElement('span'), { className: 'funnel-label', textContent: s.label }),
      track,
      Object.assign(document.createElement('strong'), { className: 'funnel-value num', textContent: String(s.value) }),
      Object.assign(document.createElement('span'), { className: 'funnel-pct num', textContent: pct(s.value, base) }),
    );
    return row;
  }));
}
