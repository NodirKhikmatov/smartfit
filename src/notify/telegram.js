// Task 10: order messages to the customer by Telegram bot (SMS later, see sms.js).
// Outbox style: orders.notified holds the last stage the customer was told about. A loop sends every order whose stage
// moved on, whatever moved it (admin, cashier, Click/Payme, expiry), so a status change never waits on or fails with Telegram.
// Linking: the order screen shows t.me/<bot>?start=<notify_token>; the bot gets "/start <token>" and stores the chat id.
import { qrSvg } from '../qr.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { smsSender } from './sms.js';
import { fittingView } from '../admin/routes.js';
import { dbTime } from '../recommend/routes.js';

const DONE = ['delivered', 'cancelled']; // nothing more to say after these
const START = /^\/start(?:@\w+)?\s+([a-f0-9]{32})$/;
const som = (n) => n.toLocaleString('ru-RU').replace(/\s/g, ' ');

// Both are needed: the token to call the API, the username to build the link. Off (null) until both are set.
export function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  return token && /^\w{5,32}$/.test(username ?? '') ? { token, username } : null;
}

// What the customer's order screen shows: a button link (phone) and a QR of the same link (kiosk).
export const telegramLink = (cfg) => (notifyToken) => {
  if (!cfg) return null;
  const url = `https://t.me/${cfg.username}?start=${notifyToken}`;
  return { channel: 'telegram', url, svg: qrSvg(url) };
};

// new is split by payment, so "paid" is its own message; a refund after a cancel doesn't repeat the cancel message.
export const stageOf = (o) => (o.status === 'new' ? (o.payment_status === 'paid' ? 'paid' : 'pending') : o.status);

// statusUrl: the public status page (needs PUBLIC_URL, since the notifier has no request to take the host from).
export function message(o, statusUrl = null) {
  const head = `${o.store_name}: buyurtma №${o.number ?? o.id}`;
  const text = {
    pending: `${head} qabul qilindi. Jami: ${som(o.total)} so'm. To'lov kutilmoqda.`,
    paid: `${head} to'landi (${som(o.total)} so'm). Tez orada yig'ishni boshlaymiz.`,
    packing: `${head} yig'ilmoqda.`,
    shipping: `${head} yo'lda. Kuryer siz bilan bog'lanadi.`,
    delivered: `${head} ${o.fulfillment === 'pickup' ? 'topshirildi' : 'yetkazildi'}. Xaridingiz uchun rahmat!`,
    cancelled: `${head} bekor qilindi.${o.payment_status === 'paid' ? " To'langan pul qaytariladi." : ''}`,
  }[stageOf(o)];
  if (!statusUrl) return text;
  // Task 23: the "how did it fit?" buttons are on the status page.
  return stageOf(o) === 'delivered' ? `${text}\nKiyimlar o'lchamiga mos keldimi? Shu yerda belgilang:\n${statusUrl}` : `${text}\n${statusUrl}`;
}
const statusUrl = (o, base = process.env.PUBLIC_URL) => (base && o.notify_token ? `${base.replace(/\/+$/, '')}/order/${o.notify_token}` : null);

// Sends one message per order whose stage changed since the last one. telegram/sms: (to, text) => Promise, or null.
export async function flushNotifications(db, { telegram = null, sms = null } = {}) {
  if (!telegram && !sms) return;
  const q = db('orders as o').join('stores as s', 's.id', 'o.store_id')
    .select('o.id', 'o.number', 'o.notify_token', 'o.status', 'o.payment_status', 'o.fulfillment', 'o.total', 'o.phone', 'o.telegram_chat_id', 'o.notified', 's.name as store_name')
    .where((w) => w.whereNull('o.notified').orWhereNotIn('o.notified', DONE));
  if (!sms) q.whereNotNull('o.telegram_chat_id');
  for (const o of await q) {
    const stage = stageOf(o);
    if (stage === o.notified) continue;
    const text = message(o, statusUrl(o));
    const patch = { notified: stage };
    if (telegram && o.telegram_chat_id != null) {
      try {
        await telegram(o.telegram_chat_id, text);
      } catch (err) {
        console.error(`telegram: order ${o.id} not sent:`, err.message);
        if (err.code !== 403 && err.code !== 400) continue; // network, 429, 5xx: try again next round
        patch.telegram_chat_id = null; // customer blocked the bot or the chat is gone
      }
    }
    if (sms) await sms(o.phone, text).catch((err) => console.error(`sms: order ${o.id} not sent:`, err.message));
    await db('orders').where({ id: o.id }).update(patch);
  }
}

// Fitting-room requests (task 17) → the store's staff chat (stores.telegram_chat_id), once each. Requests made while
// no chat was set are not sent later (the customer is long gone); they still show in the admin orders screen.
const FITTING_SEND_MS = 15 * 60 * 1000;
export async function flushFitting(db, telegram) {
  if (!telegram) return;
  const rows = await db('fitting_requests as f').join('stores as s', 's.id', 'f.store_id').whereNull('f.notified_at').where('f.status', 'new')
    .whereNotNull('s.telegram_chat_id').where('f.created_at', '>', dbTime(Date.now() - FITTING_SEND_MS)).orderBy('f.id')
    .select('f.id', 'f.cabin', 'f.items', 'f.created_at', 's.telegram_chat_id');
  for (const f of await fittingView(db, rows)) {
    const lines = f.items.map((i) => `• ${i.name ?? '?'} — ${i.size === 'ONE' ? 'yagona razmer' : i.size}${i.shelf_location ? ` (javon ${i.shelf_location})` : ''}`);
    try {
      await telegram(f.telegram_chat_id, [`Kabina ${f.cabin}: kiyib ko'rish uchun olib boring`, ...lines].join('\n'));
    } catch (err) {
      console.error(`telegram: fitting request ${f.id} not sent:`, err.message);
      if (err.code !== 403 && err.code !== 400) continue; // try again next round
    }
    await db('fitting_requests').where({ id: f.id }).update({ notified_at: new Date().toISOString() });
  }
}

// Low stock (task 20) → the store's staff chat, once per crossing: product_stock.low_alerted is set when a size is told
// about and cleared when it is above the store's threshold again. One message per store per round, sold-out sizes first.
const LOW_LINES = 30; // Telegram caps a message at 4096 characters
export async function flushLowStock(db, telegram) {
  if (!telegram) return;
  const free = 'ps.quantity - ps.reserved';
  const base = () => db('product_stock as ps').join('products as p', 'p.id', 'ps.product_id').join('stores as s', 's.id', 'p.store_id');
  await db('product_stock').where('low_alerted', true).whereIn('id', base().whereRaw(`${free} > s.low_stock_threshold`).select('ps.id')).update({ low_alerted: false });
  const rows = await base().where('ps.low_alerted', false).whereRaw(`${free} <= s.low_stock_threshold`).whereNotNull('s.telegram_chat_id')
    .orderBy('s.id').orderByRaw(`${free}, p.name, ps.id`)
    .select('ps.id', 'ps.size', 'p.name', 'p.sku', 's.id as store_id', 's.telegram_chat_id', db.raw(`${free} as free`));
  for (const storeId of new Set(rows.map((r) => r.store_id))) {
    const mine = rows.filter((r) => r.store_id === storeId);
    const lines = mine.slice(0, LOW_LINES).map((r) => `• ${r.name}${r.sku ? ` (${r.sku})` : ''} — ${r.size === 'ONE' ? 'yagona razmer' : r.size}: ${r.free > 0 ? `${r.free} dona qoldi` : 'tugadi'}`);
    if (mine.length > LOW_LINES) lines.push(`…va yana ${mine.length - LOW_LINES} ta`);
    try {
      await telegram(mine[0].telegram_chat_id, ['Kam qolgan kiyimlar:', ...lines].join('\n'));
    } catch (err) {
      console.error(`telegram: low-stock alert for store ${storeId} not sent:`, err.message);
      if (err.code !== 403 && err.code !== 400) continue; // try again next round
    }
    await db('product_stock').whereIn('id', mine.map((r) => r.id)).update({ low_alerted: true });
  }
}

// Landing-page demo requests (task 22) → the product owner's chat (TELEGRAM_OWNER_CHAT_ID). Outbox like the others:
// without a chat id nothing is sent or marked, so requests wait until it is set; they also show in the super-admin.
export async function flushDemoRequests(db, telegram, chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim()) {
  if (!telegram || !/^-?\d{1,15}$/.test(chatId ?? '')) return;
  for (const d of await db('demo_requests').whereNull('notified_at').orderBy('id').limit(20)) {
    const lines = [`Demo so'rovi #${d.id}: ${d.company}`, `${d.name}, ${d.phone}`, [d.city, d.stores && `${d.stores} ta do'kon`].filter(Boolean).join(', '), d.message].filter(Boolean);
    try {
      await telegram(Number(chatId), lines.join('\n'));
    } catch (err) {
      console.error(`telegram: demo request ${d.id} not sent:`, err.message);
      if (err.code !== 403 && err.code !== 400) continue; // try again next round
    }
    await db('demo_requests').where({ id: d.id }).update({ notified_at: new Date().toISOString() });
  }
}

// "/start <token>" from the order link → the order's messages go to this chat. The first chat to link keeps it.
export async function handleUpdate(db, update, send) {
  const m = update?.message;
  if (typeof m?.text !== 'string' || m.chat?.type !== 'private') return;
  const token = START.exec(m.text.trim())?.[1];
  const chat = m.chat.id;
  if (!token) return send(chat, "Salom! Buyurtmani kuzatish uchun buyurtma ekranidagi Telegram tugmasini bosing yoki QR kodni skanerlang.");
  const n = await db('orders').where({ notify_token: token })
    .where((w) => w.whereNull('telegram_chat_id').orWhere('telegram_chat_id', chat))
    .update({ telegram_chat_id: chat, notified: null }); // null = (re)send the current status
  if (!n) return send(chat, 'Buyurtma topilmadi yoki boshqa Telegram hisobiga ulangan.');
}

// Bot API call; errors carry Telegram's error_code (403 = blocked by the user). Messages never contain the token.
export const telegramApi = (token, fetchFn = fetch) => async (method, body, timeoutMs = 10_000) => {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new Error(`${method} failed: ${data.error_code ?? res.status}`), { code: data.error_code ?? res.status });
  return data.result;
};

// shortcut: long polling (getUpdates) and an in-process outbox need exactly one app instance; switch to a webhook
// (setWebhook + secret_token) and a DB lock on the outbox if the app ever runs as several instances.
export function startNotifications(db, { telegram = telegramConfig(), sms = smsSender(), everyMs = 5000 } = {}) {
  const api = telegram && telegramApi(telegram.token);
  const send = api && ((chat_id, text) => api('sendMessage', { chat_id, text }));
  if (!send && !sms) return console.log('Notifications off: set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME to enable');
  let busy = false;
  const flush = async () => {
    if (busy) return; // a slow round is still sending; never send the same stage twice
    busy = true;
    await flushNotifications(db, { telegram: send, sms }).catch((err) => console.error('notify failed:', err.message));
    await flushFitting(db, send).catch((err) => console.error('fitting notify failed:', err.message));
    await flushLowStock(db, send).catch((err) => console.error('low-stock notify failed:', err.message));
    await flushDemoRequests(db, send).catch((err) => console.error('demo request notify failed:', err.message));
    busy = false;
  };
  setInterval(flush, everyMs).unref();
  if (!api) return;
  (async () => {
    let offset = 0;
    for (;;) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(db, u, send).catch((err) => console.error('telegram update failed:', err.message));
        }
        if (updates.length) flush(); // answer a fresh link at once
      } catch (err) {
        console.error('telegram poll failed:', err.message);
        await sleep(5000);
      }
    }
  })();
}
