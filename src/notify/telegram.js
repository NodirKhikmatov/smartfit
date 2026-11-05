// Task 10: order messages to the customer by Telegram bot (SMS later, see sms.js).
// Outbox style: orders.notified holds the last stage the customer was told about. A loop sends every order whose stage
// moved on, whatever moved it (admin, cashier, Click/Payme, expiry), so a status change never waits on or fails with Telegram.
// Linking: the order screen shows t.me/<bot>?start=<notify_token>; the bot gets "/start <token>" and stores the chat id.
import qrcode from 'qrcode-generator';
import { setTimeout as sleep } from 'node:timers/promises';
import { smsSender } from './sms.js';

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
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return { channel: 'telegram', url, svg: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) };
};

// new is split by payment, so "paid" is its own message; a refund after a cancel doesn't repeat the cancel message.
export const stageOf = (o) => (o.status === 'new' ? (o.payment_status === 'paid' ? 'paid' : 'pending') : o.status);

export function message(o) {
  const head = `${o.store_name}: buyurtma №${o.id}`;
  return {
    pending: `${head} qabul qilindi. Jami: ${som(o.total)} so'm. To'lov kutilmoqda.`,
    paid: `${head} to'landi (${som(o.total)} so'm). Tez orada yig'ishni boshlaymiz.`,
    packing: `${head} yig'ilmoqda.`,
    shipping: `${head} yo'lda. Kuryer siz bilan bog'lanadi.`,
    delivered: `${head} ${o.fulfillment === 'pickup' ? 'topshirildi' : 'yetkazildi'}. Xaridingiz uchun rahmat!`,
    cancelled: `${head} bekor qilindi.${o.payment_status === 'paid' ? " To'langan pul qaytariladi." : ''}`,
  }[stageOf(o)];
}

// Sends one message per order whose stage changed since the last one. telegram/sms: (to, text) => Promise, or null.
export async function flushNotifications(db, { telegram = null, sms = null } = {}) {
  if (!telegram && !sms) return;
  const q = db('orders as o').join('stores as s', 's.id', 'o.store_id')
    .select('o.id', 'o.status', 'o.payment_status', 'o.fulfillment', 'o.total', 'o.phone', 'o.telegram_chat_id', 'o.notified', 's.name as store_name')
    .where((w) => w.whereNull('o.notified').orWhereNotIn('o.notified', DONE));
  if (!sms) q.whereNotNull('o.telegram_chat_id');
  for (const o of await q) {
    const stage = stageOf(o);
    if (stage === o.notified) continue;
    const text = message(o);
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
