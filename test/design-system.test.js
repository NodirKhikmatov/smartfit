import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { CATEGORIES } from '../src/admin/routes.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uiCss = read('public/shared/ui.css');
const sprite = read('public/shared/icons.svg');
const pages = { app: read('public/app/index.html'), admin: read('public/admin/index.html') };
const pageCss = { app: read('public/app/app.css'), admin: read('public/admin/admin.css') };

// Tokens from the first :root block of ui.css.
const tokens = Object.fromEntries([...uiCss.match(/:root\s*{([^}]*)}/)[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

// WCAG 2.x relative luminance and contrast ratio for #rrggbb.
const lum = (hex) => {
  const [r, g, b] = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i).slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(tokens[a]), lum(tokens[b])].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('token colour pairs meet WCAG AA', () => {
  // Text: 4.5:1. [foreground, background] as used in ui.css and the pages.
  const text = [
    ['ink', 'paper'], ['ink', 'surface'], ['ink', 'sunken'],
    ['ink-2', 'paper'], ['ink-2', 'surface'], ['ink-2', 'sunken'], // muted text, table headers, badges
    ['ink-3', 'paper'], ['ink-3', 'surface'], // placeholders, upcoming steps
    ['accent', 'paper'], ['accent', 'surface'], ['accent', 'accent-soft'], // links, active tab, accent badge (D3)
    ['accent-ink', 'accent'], ['accent-ink', 'accent-hover'], // primary button, selected chip
    ['clay', 'surface'], // sale price
    ['danger', 'surface'], ['danger', 'paper'], ['danger', 'danger-soft'],
    ['warn-ink', 'warn-soft'],
    ['ink', 'accent-soft'], ['ink', 'warn-soft'], ['ink', 'danger-soft'], // notices
    ['paper', 'ink'], // toast
  ];
  // Non-text UI (field borders, focus ring): 3:1.
  const ui = [['field-border', 'surface'], ['field-border', 'paper'], ['accent', 'paper'], ['accent', 'surface'], ['on-ink-ok', 'ink'], ['on-ink-danger', 'ink']];
  const fails = [
    ...text.filter(([f, b]) => ratio(f, b) < 4.5).map(([f, b]) => `${f} on ${b}: ${ratio(f, b).toFixed(2)} < 4.5`),
    ...ui.filter(([f, b]) => ratio(f, b) < 3).map(([f, b]) => `${f} on ${b}: ${ratio(f, b).toFixed(2)} < 3`),
  ];
  assert.deepEqual(fails, []);
});

test('both pages use the shared ui.css and define no tokens or colours of their own', () => {
  for (const [name, html] of Object.entries(pages)) {
    assert.match(html, /<link rel="stylesheet" href="\/shared\/ui\.css">/, `${name} links ui.css`);
    assert.ok(!/<style[\s>]/i.test(html), `${name} has no inline <style> block`);
    assert.match(html, /<link rel="icon" href="\/favicon\.ico"/, `${name} has a favicon`);
    const css = pageCss[name];
    assert.ok(!/--[\w-]+\s*:/.test(css), `${name} css defines no tokens`);
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), `${name} css has no hex colours`);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(uiCss.replace(/:root\s*{[^}]*}/, '').replace(/url\("data:[^"]*"\)/g, '')),
    'ui.css uses colours only through tokens (outside :root)');
});

test('every icon the pages use exists in the sprite, including categories and weather', () => {
  const symbols = new Set([...sprite.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]));
  const code = [pages.app, pages.admin, read('public/app/app.js'), read('public/shared/styleguide.html')].join('\n');
  const used = new Set([
    ...[...code.matchAll(/icon\('([\w-]+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/icons\.svg#([\w-]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\["([\w-]+)", "/g)].map((m) => m[1]), // weatherHint pairs
    ...CATEGORIES, // thumb placeholder: icon(p.category)
    'rain', 'snow', 'cloud-sun', 'sun', // weatherIcon
  ]);
  assert.deepEqual([...used].filter((n) => !symbols.has(n)), []);
  assert.ok(!/<script|on\w+=/i.test(sprite), 'sprite is plain SVG');
});

test('self-hosted fonts exist and cover Latin, Uzbek and Russian', () => {
  const faces = [...uiCss.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.ok(faces.length >= 8);
  for (const f of faces) {
    const file = f.match(/url\(([^)]+)\)/)[1];
    assert.ok(existsSync(new URL(`../public/shared/${file}`, import.meta.url)), file);
    assert.ok(!/https?:/.test(f), 'no remote fonts');
  }
  const covers = (family, cp) => faces.some((f) => f.includes(`'${family}'`) && f.match(/unicode-range:([^;]+)/)[1].split(',').some((r) => {
    const [a, b = a] = r.trim().replace(/U\+/g, '').split('-').map((h) => parseInt(h, 16));
    return cp >= a && cp <= b;
  }));
  // o' (U+02BB), Russian я, Uzbek Cyrillic ў қ ғ ҳ, № sign.
  for (const family of ['Onest', 'Cormorant']) for (const ch of 'aʻяўқғҳ№') assert.ok(covers(family, ch.codePointAt(0)), `${family} covers ${ch}`);
});

const db = testDb();
let server, base;
before(async () => {
  await db.migrate.latest();
  server = createApp(db, { weather: async () => ({ temperature: 12, apparent_temperature: 10, raining: false, wind_speed: 2, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('favicon, design-system assets and the styleguide are served', async () => {
  const ico = await fetch(base + '/favicon.ico');
  assert.equal(ico.status, 200);
  assert.equal(Buffer.from(await ico.arrayBuffer()).readUInt16LE(2), 1, 'ICO header');
  for (const [path, type] of [['/shared/ui.css', 'text/css'], ['/shared/ui.js', 'javascript'], ['/shared/icons.svg', 'image/svg+xml'], ['/shared/favicon.svg', 'image/svg+xml'], ['/shared/fonts/onest-cyrillic-wght-normal.woff2', 'font/woff2'], ['/app/app.css', 'text/css'], ['/admin/admin.css', 'text/css'], ['/styleguide', 'text/html']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').includes(type), path);
  }
  assert.equal((await fetch(base + '/shared/')).status, 404, 'no directory index');
});
