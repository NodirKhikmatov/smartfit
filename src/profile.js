// Task 27: customer profile through the Telegram bot, no SMS. The customer opens a one-time deep link, the bot shows
// the consent text and asks for their contact; Telegram's own contact share proves the phone for free. A profile
// belongs to one Telegram user in one organisation and keeps only numbers and sizes about the body, never a photo.
// Kiosk login: the kiosk shows a one-time QR → the customer's own Telegram confirms with the contact → the kiosk
// reads the sizes once. The profile page link goes only into the customer's own bot chat.
// Task 31: "Kelganda xabar bering" uses the same deep link (a_…) to keep a waiting request for one sold-out size.
import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { qrSvg } from './qr.js';
import { fail } from './admin/routes.js';
import { SIZES, isFit } from './size/size.js';
import { REC } from './recommend/routes.js';
import { parseJson, setKey } from './cart/promo.js';
import { stamp } from './cart/cart.js';
import { t, LANGS, productName } from '../public/shared/i18n.js';

export const SAVE_MS = 10 * 60 * 1000; // time to open Telegram and share the contact
export const LOGIN_MS = 3 * 60 * 1000; // the kiosk QR
export const ACCESS_MS = 30 * 24 * 60 * 60 * 1000; // the profile page link; /profile in the bot gives a fresh one
const MAX_LOOKS = 12;
const MAX_ALERTS = 20; // waiting requests per profile; the oldest go first
const TOKEN = /^[a-f0-9]{32}$/;
const START = /^\/start(?:@\w+)?\s+([pka])_([a-f0-9]{32})$/;
const KIND = { p: 'save', k: 'login', a: 'alert' };
const PREFIX = { save: 'p', login: 'k', alert: 'a' };
const iso = (ms) => new Date(ms).toISOString();
const hash = (s) => createHash('sha256').update(s).digest('hex');
const langOf = (v) => (LANGS.includes(v) ? v : 'uz');

// Only these numbers are ever kept; anything else in the body (a photo, a name) is dropped.
const intIn = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null);
export function bodyNumbers(b = {}) {
  return {
    gender: ['male', 'female'].includes(b.gender) ? b.gender : null,
    height: intIn(b.height, 100, 230),
    weight: intIn(b.weight, 30, 250),
    shoes: /^(3[6-9]|4[0-5])$/.test(String(b.shoes ?? '')) ? String(b.shoes) : null,
    top: SIZES.includes(b.top) ? b.top : null,
    bottom: SIZES.includes(b.bottom) ? b.bottom : null,
    shoulder: intIn(b.shoulder, 25, 60), // the size step's photo estimates (src/size/size.js limits)
    hip: intIn(b.hip, 22, 60),
    // Task 29: the no-photo ways (src/size/size.js limits).
    fit: isFit(b.fit) ? b.fit : null,
    jeans: intIn(b.jeans, 26, 40),
    chest: intIn(b.chest, 60, 160),
    waist: intIn(b.waist, 50, 160),
    hips: intIn(b.hips, 60, 170),
  };
}
const NUMBERS = Object.keys(bodyNumbers());

// The kiosk and phone ask whether to show the buttons (store view `profile`); the routes exist only with a bot.
export function createProfileRouter(db, { telegram, limit, pollLimit, now = Date.now }) {
  const r = express.Router();
  const link = (kind, token) => `https://t.me/${telegram.username}?start=${PREFIX[kind]}_${token}`;
  async function storeOf(id) {
    const s = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first('id', 'organization_id') : null;
    if (!s?.organization_id) throw fail(404, 'err.store_not_found');
    return s;
  }
  async function issue(kind, store, lang, data = null) {
    const t0 = now(), token = randomBytes(16).toString('hex'), poll = randomBytes(16).toString('hex'), ms = kind === 'login' ? LOGIN_MS : SAVE_MS;
    await db('profile_tokens').where('expires_at', '<', iso(t0 - 60 * 60 * 1000)).del(); // keep the table small
    await db('profile_tokens').insert({ token, poll, kind, organization_id: store.organization_id, store_id: store.id, lang, data: data && JSON.stringify(data), expires_at: iso(t0 + ms) });
    const url = link(kind, token);
    return { poll, url, svg: qrSvg(url), expires_ms: ms };
  }

  // { store_id, lang, gender, height, weight, shoes, top, bottom, shoulder, hip, fit, jeans, chest, waist, hips, rec?, looks?: [[product ids]] }
  // Looks count only if that results screen (rec) really showed them, so the client can't plant other items.
  r.post('/link', limit, async (req, res) => {
    const b = req.body ?? {};
    const store = await storeOf(b.store_id);
    let looks = [];
    if (typeof b.rec === 'string' && REC.test(b.rec) && Array.isArray(b.looks)) {
      const rec = await db('recommendation_logs').where({ token: b.rec, store_id: store.id }).first('outfits');
      const shown = new Set(parseJson(rec?.outfits, []).map(setKey));
      looks = b.looks.slice(0, 3).filter((l) => Array.isArray(l) && l.length <= 6 && l.every(Number.isInteger) && shown.has(setKey(l)))
        .map((l) => [...l].sort((x, y) => x - y));
    }
    res.status(201).json(await issue('save', store, langOf(b.lang), { ...bodyNumbers(b), looks }));
  });

  r.post('/login', limit, async (req, res) => {
    const store = await storeOf(req.body?.store_id);
    res.status(201).json(await issue('login', store, langOf(req.body?.lang)));
  });

  // Task 31: { store_id, product_id, size, lang } → a deep link that keeps a waiting request for this size once the
  // customer confirms in Telegram. Only for a size of this store's product that has no free stock now.
  r.post('/alert', limit, async (req, res) => {
    const b = req.body ?? {};
    const store = await storeOf(b.store_id);
    const p = Number.isInteger(b.product_id) ? await db('products').where({ id: b.product_id, store_id: store.id }).first('id') : null;
    if (!p) throw fail(404, 'err.product_not_found');
    const s = typeof b.size === 'string' ? await db('product_stock').where({ product_id: p.id, size: b.size }).first('quantity', 'reserved') : null;
    if (!s) throw fail(400, 'err.bad_request');
    if (s.quantity - s.reserved > 0) throw fail(409, 'err.alert_in_stock');
    res.status(201).json(await issue('alert', store, langOf(b.lang), { product_id: p.id, size: b.size }));
  });

  // Polled by the screen that showed the link, with its own secret (not the one in the QR). A finished login hands
  // over the sizes once and the token is gone.
  r.get('/token/:poll', pollLimit, async (req, res) => {
    const row = TOKEN.test(req.params.poll) ? await db('profile_tokens').where({ poll: req.params.poll }).first() : null;
    if (!row) throw fail(404, 'err.not_found');
    if (row.kind === 'login' && row.state === 'done') {
      const p = await db('customer_profiles').where({ id: row.profile_id }).first();
      const gone = await db('profile_tokens').where({ id: row.id, state: 'done' }).del();
      if (!gone || !p) throw fail(404, 'err.not_found'); // a parallel poll already took it
      return res.json({ state: 'done', profile: { lang: p.lang, ...Object.fromEntries(NUMBERS.map((k) => [k, p[k]])) } });
    }
    const left = new Date(row.expires_at).getTime() - now();
    const open = ['new', 'opened'].includes(row.state);
    res.json({ state: open && left <= 0 ? 'expired' : row.state, expires_ms: open ? Math.max(0, left) : 0 });
  });

  const byAccess = async (token) => {
    const p = TOKEN.test(token) ? await db('customer_profiles').where({ access_hash: hash(token) }).where('access_expires_at', '>', iso(now())).first() : null;
    if (!p) throw fail(404, 'err.not_found');
    return p;
  };

  // The profile page (/profile/<token>, linked from the bot chat): numbers, saved looks, orders in this organisation.
  r.get('/me/:token', limit, async (req, res) => {
    const p = await byAccess(req.params.token);
    const org = await db('organizations').where({ id: p.organization_id }).first('name');
    const lookRows = await db('customer_looks as l').join('stores as s', 's.id', 'l.store_id').where('l.profile_id', p.id)
      .orderBy('l.id', 'desc').select('l.id', 'l.items', 'l.created_at', 's.id as store_id', 's.name as store_name');
    const ids = [...new Set(lookRows.flatMap((l) => parseJson(l.items, [])))];
    const products = new Map((await db('products as p').whereIn('p.id', ids)
      .select('p.id', 'p.name', 'p.name_ru', 'p.image_url', 'p.price', 'p.discount_price', 'p.category',
        db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0').count('*').as('sizes_free'))).map((x) => [x.id, x]));
    const looks = lookRows.map((l) => ({
      id: l.id, store: { id: l.store_id, name: l.store_name }, created_at: stamp(l.created_at),
      items: parseJson(l.items, []).map((id) => products.get(id)).filter(Boolean)
        .map(({ sizes_free, ...x }) => ({ ...x, unit_price: x.discount_price ?? x.price, in_stock: Number(sizes_free) > 0 })),
    })).filter((l) => l.items.length);
    const orders = await db('orders as o').join('stores as s', 's.id', 'o.store_id').where('s.organization_id', p.organization_id)
      .where('o.phone', p.phone).orderBy('o.id', 'desc').limit(50)
      .select('o.number', 'o.created_at', 'o.status', 'o.payment_status', 'o.fulfillment', 'o.total', 'o.notify_token', 's.name as store_name');
    const alerts = await db('stock_alerts as a').join('products as pr', 'pr.id', 'a.product_id').join('stores as s', 's.id', 'a.store_id')
      .where('a.profile_id', p.id).whereNull('a.notified_at').orderBy('a.id', 'desc')
      .select('a.id', 'a.size', 'a.created_at', 'pr.id as product_id', 'pr.name', 'pr.name_ru', 'pr.image_url', 's.name as store_name');
    res.json({
      organization: org?.name ?? '', name: p.name, phone: p.phone, lang: p.lang, consent_at: stamp(p.consent_at),
      ...Object.fromEntries(NUMBERS.map((k) => [k, p[k]])), looks,
      alerts: alerts.map((a) => ({ ...a, created_at: stamp(a.created_at) })),
      orders: orders.map(({ notify_token, created_at, ...o }) => ({ ...o, created_at: stamp(created_at), url: notify_token ? `/order/${notify_token}` : null })),
    });
  });

  r.delete('/me/:token/alerts/:id', limit, async (req, res) => {
    const p = await byAccess(req.params.token);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !(await db('stock_alerts').where({ id, profile_id: p.id }).del())) throw fail(404, 'err.not_found');
    res.status(204).end();
  });

  r.delete('/me/:token', limit, async (req, res) => {
    await deleteProfiles(db, [(await byAccess(req.params.token)).id]);
    res.status(204).end();
  });
  return r;
}

// "Ma'lumotlarimni o'chirish": the profile, its looks and tokens go. Its finished orders (same organisation, same
// verified phone) keep only what a sale record needs: number, items, sums, payment, dates and the phone (receipts,
// returns, the per-phone promo limit); the name, address, map pin and Telegram chat are erased. Open orders are
// still being served, so they keep their contact details until they finish.
export async function deleteProfiles(db, ids) {
  if (!ids.length) return 0;
  return db.transaction(async (trx) => {
    for (const p of await trx('customer_profiles').whereIn('id', ids)) {
      await trx('orders').where({ phone: p.phone }).whereIn('status', ['delivered', 'cancelled'])
        .whereIn('store_id', trx('stores').where({ organization_id: p.organization_id }).select('id'))
        .update({ customer_name: '—', address: null, lat: null, lon: null, telegram_chat_id: null });
    }
    await trx('profile_tokens').whereIn('profile_id', ids).del();
    await trx('stock_alerts').whereIn('profile_id', ids).del();
    await trx('customer_looks').whereIn('profile_id', ids).del();
    return trx('customer_profiles').whereIn('id', ids).del();
  });
}

const contactKeyboard = (lang) => ({ reply_markup: { keyboard: [[{ text: t('kiosk.bot.share_btn', {}, lang), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
const NO_KEYBOARD = { reply_markup: { remove_keyboard: true } };
const pageUrl = (base, token) => (base ? `${base.replace(/\/+$/, '')}/profile/${token}` : null);

// A fresh profile page link (the old one stops working). Without PUBLIC_URL there is no page link, only /delete.
async function newAccess(db, profileId, base, now) {
  const token = randomBytes(16).toString('hex');
  await db('customer_profiles').where({ id: profileId }).update({ access_hash: hash(token), access_expires_at: iso(now + ACCESS_MS) });
  return pageUrl(base, token);
}

// Task 31: keep (or re-arm) the waiting request a_… token carried; returns the bot's confirmation in the token's language.
async function addAlert(trx, profileId, row, now) {
  const { product_id, size } = parseJson(row.data, {});
  const p = await trx('products').where({ id: product_id, store_id: row.store_id }).first('name', 'name_ru');
  if (!p) return null; // deleted meanwhile
  await trx('stock_alerts').insert({ profile_id: profileId, store_id: row.store_id, product_id, size, lang: row.lang, created_at: iso(now) })
    .onConflict(['profile_id', 'product_id', 'size']).merge({ notified_at: null, lang: row.lang, created_at: iso(now) });
  const keep = trx('stock_alerts').where({ profile_id: profileId }).whereNull('notified_at').orderBy('id', 'desc').limit(MAX_ALERTS).select('id');
  await trx('stock_alerts').where({ profile_id: profileId }).whereNull('notified_at').whereNotIn('id', keep).del();
  return t('kiosk.bot.alert_saved', { name: productName(p, row.lang), size: size === 'ONE' ? t('common.size_one', {}, row.lang) : size }, row.lang);
}

// Bot messages for task 27. Returns true when the message was about profiles (so the order bot leaves it alone).
// m: a private-chat message. send(chat, text, extra).
export async function handleProfileMessage(db, m, send, { now = Date.now(), base = process.env.PUBLIC_URL } = {}) {
  const chat = m.chat.id, from = m.from?.id;
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const userLang = m.from?.language_code === 'ru' ? 'ru' : 'uz';
  if (!from) return false;

  const start = START.exec(text);
  if (start) {
    const token = start[2];
    // Single use: the first Telegram user to open it owns it; opening it again (same user) only repeats the question.
    await db('profile_tokens').where({ token, state: 'new' }).where('expires_at', '>', iso(now))
      .update({ state: 'opened', telegram_user_id: from });
    const row = await db('profile_tokens as k').join('stores as s', 's.id', 'k.store_id').join('organizations as o', 'o.id', 'k.organization_id')
      .where({ 'k.token': token, 'k.state': 'opened', 'k.telegram_user_id': from }).where('k.expires_at', '>', iso(now))
      .first('k.kind', 'k.lang', 's.name as store', 'o.name as org');
    if (!row || row.kind !== KIND[start[1]]) return send(chat, t('kiosk.bot.expired', {}, userLang)).then(() => true);
    if (row.kind === 'alert') {
      // Already has a profile here (consent given before): keep the request now, no contact needed again.
      const done = await db.transaction(async (trx) => {
        const k = await trx('profile_tokens').where({ token, state: 'opened', telegram_user_id: from }).first();
        if (!k) return null;
        const p = await trx('customer_profiles').where({ organization_id: k.organization_id, telegram_user_id: from }).first('id');
        if (!p || !(await trx('profile_tokens').where({ id: k.id, state: 'opened' }).update({ state: 'done', profile_id: p.id }))) return null;
        return (await addAlert(trx, p.id, k, now)) ?? t('kiosk.bot.expired', {}, row.lang);
      });
      if (done) return send(chat, done).then(() => true);
    }
    const ask = row.kind !== 'login' ? t('kiosk.bot.consent', { org: row.org }, row.lang) : t('kiosk.bot.login', { store: row.store }, row.lang);
    await send(chat, ask, contactKeyboard(row.lang));
    return true;
  }

  if (m.contact) {
    // Only the sender's own contact (Telegram fills user_id for the request_contact button); a forwarded card won't do.
    if (String(m.contact.user_id ?? '') !== String(from)) return send(chat, t('kiosk.bot.not_own', {}, userLang)).then(() => true);
    const phone = `+${String(m.contact.phone_number ?? '').replace(/\D/g, '')}`; // the +998XXXXXXXXX form checkout stores
    const row = await db('profile_tokens').where({ telegram_user_id: from, state: 'opened' }).where('expires_at', '>', iso(now)).orderBy('id', 'desc').first();
    if (!row || !/^\+\d{7,15}$/.test(phone)) return send(chat, t('kiosk.bot.expired', {}, userLang), NO_KEYBOARD).then(() => true);
    const name = [m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ').slice(0, 120) || null;
    const result = await db.transaction(async (trx) => {
      if (!(await trx('profile_tokens').where({ id: row.id, state: 'opened' }).update({ state: 'claimed' }))) return null; // a double tap
      const mine = { organization_id: row.organization_id, telegram_user_id: from };
      let p = await trx('customer_profiles').where(mine).first();
      if (row.kind === 'login') {
        if (p) await trx('customer_profiles').where({ id: p.id }).update({ phone, updated_at: iso(now) });
        await trx('profile_tokens').where({ id: row.id }).update({ state: p ? 'done' : 'missing', profile_id: p?.id ?? null });
        return { kind: 'login', found: !!p };
      }
      const data = parseJson(row.data, {});
      const numbers = Object.fromEntries(NUMBERS.filter((k) => data[k] != null).map((k) => [k, data[k]])); // a later save fills in, never blanks
      const fields = { phone, name, lang: row.lang, consent_at: iso(now), updated_at: iso(now), ...numbers };
      if (p) await trx('customer_profiles').where({ id: p.id }).update(fields);
      else [p] = await trx('customer_profiles').insert({ ...mine, ...fields }).returning('id');
      const id = p.id;
      const have = new Set((await trx('customer_looks').where({ profile_id: id }).select('items')).map((l) => setKey(parseJson(l.items, []))));
      for (const look of data.looks ?? []) {
        if (!have.has(setKey(look))) await trx('customer_looks').insert({ profile_id: id, store_id: row.store_id, items: JSON.stringify(look) });
      }
      const keep = trx('customer_looks').where({ profile_id: id }).orderBy('id', 'desc').limit(MAX_LOOKS).select('id');
      await trx('customer_looks').where({ profile_id: id }).whereNotIn('id', keep).del();
      await trx('profile_tokens').where({ id: row.id }).update({ state: 'done', profile_id: id });
      const alert = row.kind === 'alert' ? await addAlert(trx, id, row, now) : null;
      return { kind: 'save', id, alert, url: await newAccess(trx, id, base, now) };
    });
    if (!result) return true;
    const lang = row.lang;
    if (result.kind === 'login') await send(chat, t(result.found ? 'kiosk.bot.logged_in' : 'kiosk.bot.no_profile', {}, lang), NO_KEYBOARD);
    else await send(chat, [result.alert ?? t('kiosk.bot.saved', {}, lang), result.url && t('kiosk.bot.page', { url: result.url }, lang), t('kiosk.bot.delete_hint', {}, lang)].filter(Boolean).join('\n\n'), NO_KEYBOARD);
    return true;
  }

  if (/^\/delete(?:@\w+)?$/.test(text)) {
    const ids = (await db('customer_profiles').where({ telegram_user_id: from }).select('id')).map((p) => p.id);
    await deleteProfiles(db, ids);
    await send(chat, t(ids.length ? 'kiosk.bot.deleted' : 'kiosk.bot.none', {}, userLang), NO_KEYBOARD);
    return true;
  }
  if (/^\/profile(?:@\w+)?$/.test(text)) {
    const mine = await db('customer_profiles as p').join('organizations as o', 'o.id', 'p.organization_id').where('p.telegram_user_id', from).select('p.id', 'p.lang', 'o.name as org');
    if (!mine.length) return send(chat, t('kiosk.bot.none', {}, userLang)).then(() => true);
    const lines = [];
    for (const p of mine) {
      const url = await newAccess(db, p.id, base, now);
      lines.push(url ? `${p.org}: ${url}` : p.org);
    }
    await send(chat, [...lines, t('kiosk.bot.delete_hint', {}, mine[0].lang)].join('\n\n'));
    return true;
  }
  return false;
}
