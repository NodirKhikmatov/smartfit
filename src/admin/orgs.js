// Task 22: organisations (super-admin only) and the landing page's "Demo so'rash" requests.
import express from 'express';
import { fail, text, int, paging, langOf } from './routes.js';
import { createInvite } from './settings.js';
import { audit } from './audit.js';
import { normalizePhone, stamp } from '../cart/cart.js';

const superOnly = (admin) => {
  if (admin.role !== 'super') throw fail(403, 'err.forbidden');
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function orgRoutes(r, db) {
  // Organisations with how many stores, admins and open owner invites they have.
  r.get('/orgs', async (req, res) => {
    superOnly(req.admin);
    const count = (table, extra = (q) => q) => extra(db(table).select('organization_id').count({ n: '*' }).groupBy('organization_id'));
    const [orgs, stores, admins, invites] = await Promise.all([
      db('organizations').orderBy('id', 'desc').select('id', 'name', 'created_at'),
      count('stores'), count('admins'),
      count('admin_invites', (q) => q.whereNull('used_at').where('expires_at', '>', new Date().toISOString())),
    ]);
    const n = (rows, id) => Number(rows.find((x) => x.organization_id === id)?.n ?? 0);
    res.json(orgs.map((o) => ({ ...o, created_at: stamp(o.created_at), stores: n(stores, o.id), admins: n(admins, o.id), invites: n(invites, o.id) })));
  });

  // { name, owner_email } → the organisation and its owner's one-time link. The owner makes the first store in the wizard.
  r.post('/orgs', async (req, res) => {
    superOnly(req.admin);
    const name = text(req.body?.name, 120, 'field.org_name', true);
    const email = typeof req.body?.owner_email === 'string' ? req.body.owner_email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 200) throw fail(400, 'err.invalid', { field: 'field.email' });
    const out = await db.transaction(async (trx) => {
      const [{ id }] = await trx('organizations').insert({ name }).returning('id');
      await audit(trx, req.admin, { action: 'org.create', entityId: id, label: name, after: { name } });
      return { id, name, invite: await createInvite(req, trx, { email, role: 'owner', storeId: null, orgId: id }) };
    });
    res.status(201).json(out);
  });

  // Demo requests, newest first.
  r.get('/demo-requests', async (req, res) => {
    superOnly(req.admin);
    const { limit, offset } = paging(req.query);
    const [{ n }] = await db('demo_requests').count({ n: '*' });
    const rows = await db('demo_requests').orderBy('id', 'desc').limit(limit).offset(offset)
      .select('id', 'name', 'phone', 'company', 'city', 'stores', 'message', 'lang', 'created_at', 'handled_at');
    res.json({ items: rows.map((d) => ({ ...d, created_at: stamp(d.created_at), handled_at: d.handled_at && stamp(d.handled_at) })), total: Number(n), limit, offset });
  });

  // { handled: true|false } marks a request as dealt with (or not).
  r.patch('/demo-requests/:id', async (req, res) => {
    superOnly(req.admin);
    const d = await db('demo_requests').where({ id: Number(req.params.id) || 0 }).first();
    if (!d) throw fail(404, 'err.not_found');
    const handled = req.body?.handled;
    if (typeof handled !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.status' });
    if (handled !== (d.handled_at != null)) {
      await db.transaction(async (trx) => {
        await trx('demo_requests').where({ id: d.id }).update({ handled_at: handled ? new Date().toISOString() : null });
        await audit(trx, req.admin, { action: 'demo.handle', entityId: d.id, label: d.company, before: { handled: !handled }, after: { handled } });
      });
    }
    res.json({ id: d.id, handled });
  });
}

// Public: the landing page's form. Rate-limited per IP in app.js; the product owner hears about it on Telegram.
export function createDemoRouter(db) {
  const r = express.Router();
  r.post('/', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const name = text(b.name, 80, 'field.customer_name', true);
    if (name.length < 2) throw fail(400, 'err.invalid', { field: 'field.customer_name' });
    const stores = b.stores == null || b.stores === '' ? null : int(typeof b.stores === 'string' ? Number(b.stores) : b.stores, 1, 1000, 'field.stores');
    const row = {
      name, phone: normalizePhone(b.phone), company: text(b.company, 120, 'field.company', true),
      city: text(b.city, 80, 'field.city', false), stores, message: text(b.message, 500, 'field.message', false), lang: langOf(req),
    };
    const [{ id }] = await db('demo_requests').insert(row).returning('id');
    res.status(201).json({ id });
  });
  return r;
}
