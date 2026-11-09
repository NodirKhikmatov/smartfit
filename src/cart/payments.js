// Task 9: Click (SHOP API Prepare/Complete) and Payme (Merchant API JSON-RPC) callbacks.
// A provider is on only when all its keys are in .env. The browser is never trusted: an order is paid only by a callback
// that passes the signature/auth check and carries exactly the server-computed total, through the same markPaid as the cashier.
// Each provider transaction is one payment_transactions row, so repeated callbacks get the same answer and stock moves once.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HOLD_MS, markPaid, cancelPending, refundPaid, releaseExpired } from './cart.js';

export function paymentConfig(env = process.env) {
  const has = (...keys) => keys.every((k) => env[k]?.trim());
  return {
    payme: has('PAYME_MERCHANT_ID', 'PAYME_KEY')
      ? { merchantId: env.PAYME_MERCHANT_ID.trim(), key: env.PAYME_KEY.trim(), checkoutUrl: (env.PAYME_CHECKOUT_URL || 'https://test.paycom.uz').replace(/\/+$/, '') }
      : null,
    click: has('CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY')
      ? { serviceId: env.CLICK_SERVICE_ID.trim(), merchantId: env.CLICK_MERCHANT_ID.trim(), secret: env.CLICK_SECRET_KEY.trim() }
      : null,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, '') || null,
  };
}

// Checkout methods for createCartRouter: cashier always, plus each configured provider with its pay link.
export function paymentMethods(cfg) {
  // Where the provider sends the customer afterwards: the order's status page.
  const back = (o) => cfg.publicUrl && (o.notify_token ? `${cfg.publicUrl}/order/${o.notify_token}` : `${cfg.publicUrl}/m?store=${o.store_id}`);
  const m = { cashier: async () => ({ method: 'cashier' }) };
  if (cfg.payme) {
    m.payme = async (o) => {
      const params = [`m=${cfg.payme.merchantId}`, `ac.order_id=${o.id}`, `a=${o.total * 100}`, 'l=uz', ...(back(o) ? [`c=${back(o)}`] : [])];
      return { method: 'payme', url: `${cfg.payme.checkoutUrl}/${Buffer.from(params.join(';')).toString('base64')}` };
    };
  }
  if (cfg.click) {
    m.click = async (o) => {
      const q = new URLSearchParams({ service_id: cfg.click.serviceId, merchant_id: cfg.click.merchantId, amount: `${o.total}.00`, transaction_param: String(o.id) });
      if (back(o)) q.set('return_url', back(o));
      return { method: 'click', url: `https://my.click.uz/services/pay/?${q}` };
    };
  }
  return m;
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const num = (v) => (v == null ? null : Number(v)); // Postgres returns bigint columns as strings
// Starting a payment gives the order a fresh 15 minutes, so it doesn't expire while the customer is on the provider's page.
// The UPDATE also locks the order row, so two payment attempts on one order are serialised.
const holdForPayment = (trx, orderId, now) =>
  trx('orders').where({ id: orderId, payment_status: 'pending' }).where('expires_at', '>', new Date(now).toISOString())
    .update({ expires_at: new Date(now + HOLD_MS).toISOString(), updated_at: trx.fn.now() });

// --- Payme Merchant API. Always HTTP 200; errors are JSON-RPC errors with a ru/uz/en message.
const PAYME = {
  '-32504': ["Ruxsat yo'q", 'Недостаточно привилегий', 'Insufficient privileges'],
  '-32700': ["JSON noto'g'ri", 'Ошибка парсинга JSON', 'Parse error'],
  '-32600': ["So'rov noto'g'ri", 'Неверный RPC-запрос', 'Invalid request'],
  '-32601': ['Metod topilmadi', 'Метод не найден', 'Method not found'],
  '-32400': ['Tizim xatosi', 'Системная ошибка', 'System error'],
  '-31001': ["Summa noto'g'ri", 'Неверная сумма', 'Invalid amount'],
  '-31003': ['Tranzaksiya topilmadi', 'Транзакция не найдена', 'Transaction not found'],
  '-31007': ["Buyurtma topshirilgan, bekor qilib bo'lmaydi", 'Заказ выполнен, отмена невозможна', 'Order fulfilled, cannot cancel'],
  '-31008': ["Amalni bajarib bo'lmaydi", 'Невозможно выполнить операцию', 'Unable to perform operation'],
  '-31050': ['Buyurtma topilmadi', 'Заказ не найден', 'Order not found'],
  '-31051': ["Buyurtma to'langan yoki bekor qilingan", 'Заказ уже оплачен или отменён', 'Order already paid or cancelled'],
};
const rpcError = (code, data) => {
  const [uz, ru, en] = PAYME[code];
  return Object.assign(new Error(en), { rpc: { code, message: { uz, ru, en }, ...(data && { data }) } });
};
// Payme sends `Authorization: Basic base64("Paycom:<key>")`.
function paymeAuthOk(header, key) {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  return !!m && same(Buffer.from(m[1], 'base64').toString(), `Paycom:${key}`);
}

function paymeMethods(db) {
  const tx = (id) => (typeof id === 'string' && id.length <= 64 ? db('payment_transactions').where({ provider: 'payme', ext_id: id }).first() : null);
  const mustTx = async (id) => (await tx(id)) ?? Promise.reject(rpcError(-31003));
  const amountOf = (v) => (Number.isInteger(v) && v > 0 ? v : Promise.reject(rpcError(-31001)));
  async function payableOrder(account, amount) {
    const id = Number(account?.order_id);
    const order = Number.isInteger(id) && id > 0 ? await db('orders').where({ id, payment_method: 'payme' }).first() : null;
    if (!order) throw rpcError(-31050, 'order_id');
    if (amount !== order.total * 100) throw rpcError(-31001);
    if (order.payment_status !== 'pending') throw rpcError(-31051, 'order_id');
    return order;
  }
  const view = (t) => ({
    create_time: num(t.create_time), perform_time: num(t.perform_time) ?? 0, cancel_time: num(t.cancel_time) ?? 0,
    transaction: String(t.id), state: t.state, reason: t.reason,
  });

  return {
    async CheckPerformTransaction(p) {
      await payableOrder(p.account, await amountOf(p.amount));
      return { allow: true };
    },

    async CreateTransaction(p) {
      const now = Date.now();
      const old = await tx(p.id);
      if (old) {
        if (old.state !== 1) throw rpcError(-31008);
        const order = await db('orders').where({ id: old.order_id }).first('payment_status');
        if (order.payment_status !== 'pending') {
          await db('payment_transactions').where({ id: old.id, state: 1 }).update({ state: -1, reason: 4, cancel_time: now });
          throw rpcError(-31008);
        }
        const { create_time, transaction, state } = view(old);
        return { create_time, transaction, state };
      }
      if (typeof p.id !== 'string' || !p.id || p.id.length > 64 || !Number.isInteger(p.time)) throw rpcError(-32600);
      const order = await payableOrder(p.account, await amountOf(p.amount));
      const id = await db.transaction(async (trx) => {
        if (!(await holdForPayment(trx, order.id, now))) throw rpcError(-31051, 'order_id');
        // One open transaction per order (Payme sandbox: the order is "awaiting payment").
        if (await trx('payment_transactions').where({ order_id: order.id, state: 1 }).first('id')) throw rpcError(-31008);
        const [{ id }] = await trx('payment_transactions')
          .insert({ provider: 'payme', ext_id: p.id, order_id: order.id, amount: order.total, state: 1, provider_time: p.time, create_time: now })
          .returning('id');
        return id;
      });
      return { create_time: now, transaction: String(id), state: 1 };
    },

    async PerformTransaction(p) {
      const t = await mustTx(p.id);
      if (t.state === 1) {
        const now = Date.now();
        await db.transaction(async (trx) => {
          if (!(await trx('payment_transactions').where({ id: t.id, state: 1 }).update({ state: 2, perform_time: now }))) return; // a parallel call won
          // Order expired, cancelled or paid at the cashier meanwhile: the transaction can't go through.
          if (!(await markPaid(trx, t.order_id, now))) await trx('payment_transactions').where({ id: t.id }).update({ state: -1, reason: 4, perform_time: null, cancel_time: now });
        });
      }
      const after = await mustTx(p.id);
      if (after.state !== 2) throw rpcError(-31008);
      return { transaction: String(after.id), perform_time: num(after.perform_time), state: 2 };
    },

    async CancelTransaction(p) {
      const t = await mustTx(p.id);
      const reason = Number.isInteger(p.reason) ? p.reason : null;
      const now = Date.now();
      if (t.state === 1) {
        await db.transaction(async (trx) => {
          if (await trx('payment_transactions').where({ id: t.id, state: 1 }).update({ state: -1, reason, cancel_time: now })) {
            await cancelPending(trx, t.order_id, now); // the order's holds come back now, not at expiry
          }
        });
      } else if (t.state === 2) {
        await db.transaction(async (trx) => {
          if (!(await trx('payment_transactions').where({ id: t.id, state: 2 }).update({ state: -2, reason, cancel_time: now }))) return;
          if (!(await refundPaid(trx, t.order_id))) throw rpcError(-31007); // rolls the state change back
        });
      }
      const after = await mustTx(p.id);
      if (after.state > 0) throw rpcError(-31008); // only if a parallel perform slipped in between
      return { transaction: String(after.id), cancel_time: num(after.cancel_time), state: after.state };
    },

    async CheckTransaction(p) {
      return view(await mustTx(p.id));
    },

    async GetStatement(p) {
      if (!Number.isInteger(p.from) || !Number.isInteger(p.to)) throw rpcError(-32600);
      const rows = await db('payment_transactions').where({ provider: 'payme' }).whereBetween('create_time', [p.from, p.to]).orderBy('create_time');
      return {
        transactions: rows.map((t) => ({
          id: t.ext_id, time: num(t.provider_time), amount: t.amount * 100, account: { order_id: String(t.order_id) }, ...view(t), receivers: null,
        })),
      };
    },
  };
}

// --- Click SHOP API. Form-encoded POST in, JSON out; sign_string = md5 of the fields below with our secret.
const CLICK = { 0: 'Success', '-1': 'SIGN CHECK FAILED!', '-2': 'Incorrect parameter amount', '-3': 'Action not found', '-4': 'Already paid', '-5': 'User does not exist', '-6': 'Transaction does not exist', '-8': 'Error in request from click', '-9': 'Transaction cancelled' };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const sameAmount = (raw, som) => /^\d+(\.\d{1,2})?$/.test(raw) && Number(raw) === som; // Click sends so'm as "1000" or "1000.00"

function clickHandler(db, cfg, action) {
  const fields = ['click_trans_id', 'service_id', 'click_paydoc_id', 'merchant_trans_id', 'amount', 'action', 'error', 'sign_time', 'sign_string', ...(action ? ['merchant_prepare_id'] : [])];
  return async (b) => {
    const out = (error, extra = {}) => ({ click_trans_id: b.click_trans_id, merchant_trans_id: b.merchant_trans_id, ...extra, error, error_note: CLICK[error] });
    if (fields.some((k) => typeof b[k] !== 'string' || b[k].length > 64)) return out(-8);
    const signed = md5(b.click_trans_id + b.service_id + cfg.secret + b.merchant_trans_id + (action ? b.merchant_prepare_id : '') + b.amount + b.action + b.sign_time);
    if (!same(signed, b.sign_string.toLowerCase())) return out(-1);
    if (b.service_id !== cfg.serviceId) return out(-8);
    if (b.action !== String(action)) return out(-3);
    const orderId = /^\d{1,9}$/.test(b.merchant_trans_id) ? Number(b.merchant_trans_id) : 0;
    const order = await db('orders').where({ id: orderId, payment_method: 'click' }).first();
    if (!order) return out(-5);
    const now = Date.now();

    if (action === 0) { // Prepare: check the order and amount, hold the stock for the payment
      if (!sameAmount(b.amount, order.total)) return out(-2);
      const old = await db('payment_transactions').where({ provider: 'click', ext_id: b.click_trans_id }).first();
      if (old) return old.state === 1 ? out(0, { merchant_prepare_id: old.id }) : out(old.state === 2 ? -4 : -9);
      if (order.payment_status === 'paid') return out(-4);
      const id = await db.transaction(async (trx) => {
        if (!(await holdForPayment(trx, order.id, now))) return null;
        const [{ id }] = await trx('payment_transactions')
          .insert({ provider: 'click', ext_id: b.click_trans_id, order_id: order.id, amount: order.total, state: 1, create_time: now })
          .returning('id');
        return id;
      });
      return id ? out(0, { merchant_prepare_id: id }) : out(-9);
    }

    // Complete
    const t = await db('payment_transactions').where({ id: Number(b.merchant_prepare_id) || 0, provider: 'click', ext_id: b.click_trans_id, order_id: order.id }).first();
    if (!t) return out(-6);
    if (t.state === 2) return out(-4);
    if (t.state !== 1) return out(-9);
    if (Number(b.error) < 0) { // Click reports the payment failed: cancel it and give the stock back
      await db.transaction(async (trx) => {
        if (await trx('payment_transactions').where({ id: t.id, state: 1 }).update({ state: -1, cancel_time: now })) await cancelPending(trx, order.id, now);
      });
      return out(-9);
    }
    if (!sameAmount(b.amount, t.amount)) return out(-2);
    await db.transaction(async (trx) => {
      if (!(await trx('payment_transactions').where({ id: t.id, state: 1 }).update({ state: 2, perform_time: now }))) return;
      // shortcut: an order that expired or was paid at the cashier meanwhile gets -9; Click's docs want "success" plus a
      // payment/reversal call (Merchant API, separate credentials). Add that when going live if Click flags these.
      if (!(await markPaid(trx, order.id, now))) await trx('payment_transactions').where({ id: t.id }).update({ state: -1, perform_time: null, cancel_time: now });
    });
    const after = await db('payment_transactions').where({ id: t.id }).first('state');
    return after.state === 2 ? out(0, { merchant_confirm_id: t.id }) : out(-9);
  };
}

// Mounted at /api/pay before the app's JSON parser: Payme must get HTTP 200 with -32700 for bad JSON, Click posts a form.
export function createPaymentRouter(db, cfg) {
  const r = express.Router();
  if (cfg.payme) {
    const methods = paymeMethods(db);
    r.post('/payme', express.text({ type: () => true, limit: '20kb' }), async (req, res) => {
      let id = null;
      const reply = (body) => res.json({ jsonrpc: '2.0', id, ...body });
      try {
        if (!paymeAuthOk(req.get('authorization'), cfg.payme.key)) throw rpcError(-32504);
        let rpc;
        try { rpc = JSON.parse(typeof req.body === 'string' ? req.body : ''); } catch { throw rpcError(-32700); }
        id = rpc?.id ?? null;
        if (typeof rpc?.method !== 'string' || typeof rpc.params !== 'object' || rpc.params === null) throw rpcError(-32600);
        if (!Object.hasOwn(methods, rpc.method)) throw rpcError(-32601, rpc.method.slice(0, 64));
        await releaseExpired(db);
        reply({ result: await methods[rpc.method](rpc.params) });
      } catch (err) {
        if (!err.rpc) console.error('payme callback failed:', err.message);
        reply({ error: err.rpc ?? rpcError(-32400).rpc });
      }
    });
  }
  if (cfg.click) {
    const form = express.urlencoded({ extended: false, limit: '10kb' });
    for (const [path, action] of [['prepare', 0], ['complete', 1]]) {
      const handle = clickHandler(db, cfg.click, action);
      r.post(`/click/${path}`, form, async (req, res) => {
        try {
          await releaseExpired(db);
          res.json(await handle(req.body ?? {}));
        } catch (err) {
          console.error('click callback failed:', err.message);
          res.json({ error: -7, error_note: 'Failed to update user' });
        }
      });
    }
  }
  return r;
}
