// Task 22: organisations (super-admin only) and the landing page's "Demo so'rash" requests.
// Task 45: each organisation's plan (super sets it, with a note), the owner's "Tarif" view and the first-run checklist.
import express from 'express';
import { fail, text, int, paging, langOf } from './routes.js';
import { createInvite } from './settings.js';
import { audit } from './audit.js';
import { builtinRows } from '../db/migrations/023_categories.js';
import { normalizePhone, stamp } from '../cart/cart.js';
import { PLANS, PLAN_NAMES, FEATURES, DAY, planState, usage, checklist, mayDo, trialRow } from '../plans.js';

const superOnly = (admin) => {
  if (admin.role !== 'super') throw fail(403, 'err.forbidden');
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A new organisation (a 14-day Pro trial), its built-in categories and its owner's one-time link, in the caller's transaction.
async function newOrg(trx, req, name, email, now) {
  const [{ id }] = await trx('organizations').insert({ name, ...trialRow(now) }).returning('id');
  await trx('categories').insert(builtinRows(id)); // task 36: every shop starts with the five built-in categories
  await audit(trx, req.admin, { action: 'org.create', entityId: id, label: name, after: { name } });
  return { id, name, invite: await createInvite(req, trx, { email, role: 'owner', storeId: null, orgId: id }) };
}
const emailOf = (v) => {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 200) throw fail(400, 'err.invalid', { field: 'field.email' });
  return email;
};
// What the "Tarif" page and super's list show of a plan.
const planOut = (s) => ({ plan: s.plan, state: s.state, ends: s.ends, trial_until: s.trial_until, paid_until: s.paid_until, grace_until: s.grace_until, readonly_from: s.readonly_from });

export function orgRoutes(r, db, { now = Date.now } = {}) {
  // Organisations with how many stores, admins and open owner invites they have, and their plan (task 45).
  r.get('/orgs', async (req, res) => {
    superOnly(req.admin);
    const count = (table, extra = (q) => q) => extra(db(table).select('organization_id').count({ n: '*' }).groupBy('organization_id'));
    const [orgs, stores, admins, invites, owners] = await Promise.all([
      db('organizations').orderBy('id', 'desc').select('id', 'name', 'created_at', 'plan', 'trial_until', 'paid_until', 'plan_note'),
      count('stores'), count('admins'),
      count('admin_invites', (q) => q.whereNull('used_at').where('expires_at', '>', new Date().toISOString())),
      db('admin_invites').where({ role: 'owner' }).whereNotNull('organization_id').orderBy('id', 'desc').select('organization_id', 'email'),
    ]);
    const n = (rows, id) => Number(rows.find((x) => x.organization_id === id)?.n ?? 0);
    const t = now();
    res.json(orgs.map(({ plan, trial_until, paid_until, plan_note, ...o }) => ({ ...o, created_at: stamp(o.created_at), stores: n(stores, o.id), admins: n(admins, o.id), invites: n(invites, o.id),
      owner_email: owners.find((x) => x.organization_id === o.id)?.email ?? null, // the last owner invite: prefills "Yangi havola"
      ...planOut(planState({ plan, trial_until, paid_until }, t)), note: plan_note ?? null })));
  });

  // Task 45: { plan, paid_until: 'YYYY-MM-DD' | null, note: 3–300 chars } → the organisation's plan. Super only (the
  // invoice is sent outside the app); every change is audited with the note. The trial date stays as it was.
  r.patch('/orgs/:id/plan', async (req, res) => {
    superOnly(req.admin);
    const org = /^\d{1,9}$/.test(req.params.id) ? await db('organizations').where({ id: Number(req.params.id) }).first('id', 'name', 'plan', 'trial_until', 'paid_until') : undefined;
    if (!org) throw fail(404, 'err.not_found');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (!PLAN_NAMES.includes(b.plan)) throw fail(400, 'err.invalid', { field: 'field.plan' });
    const paid = b.paid_until ?? null;
    if (paid !== null && (typeof paid !== 'string' || !DAY.test(paid) || Number.isNaN(Date.parse(`${paid}T00:00:00Z`)) || new Date(`${paid}T00:00:00Z`).toISOString().slice(0, 10) !== paid)) throw fail(400, 'err.invalid', { field: 'field.paid_until' });
    const note = text(b.note, 300, 'field.plan_note', true);
    if (note.length < 3) throw fail(400, 'err.invalid', { field: 'field.plan_note' });
    const before = { plan: org.plan, paid_until: org.paid_until ?? null }, after = { plan: b.plan, paid_until: paid };
    await db.transaction(async (trx) => {
      await trx('organizations').where({ id: org.id }).update({ ...after, plan_note: note });
      await audit(trx, req.admin, { action: 'org.plan', entityId: org.id, label: org.name, before, after: { ...after, note } });
    });
    res.json({ id: org.id, ...planOut(planState({ ...org, ...after }, now())), note });
  });

  // Task 45: the owner's "Tarif" page (super: ?organization_id): plan, dates, limits with what counts now, features.
  r.get('/plan', async (req, res) => {
    if (!['owner', 'super'].includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const orgId = req.admin.role === 'super' ? Number(req.query.organization_id) || 0 : req.admin.organization_id;
    const s = await mayDo(db, orgId, 'read', { now: now() });
    if (!s) throw fail(404, 'err.not_found');
    const use = await usage(db, orgId, now());
    res.json({ ...planOut(s), limits: Object.fromEntries(Object.entries(use).map(([k, v]) => [k, { used: v, max: s[k] }])),
      features: Object.fromEntries(FEATURES.map((f) => [f, s.features.includes(f)])), plans: PLANS });
  });

  // Task 45: the first-run checklist on the owner's dashboard → { items: [{ key, done }], done, dismissed }.
  r.get('/checklist', async (req, res) => {
    if (req.admin.role !== 'owner') throw fail(403, 'err.forbidden');
    const items = await checklist(db, req.admin.organization_id);
    const g = await db('organizations').where({ id: req.admin.organization_id }).first('checklist_dismissed_at');
    res.json({ items, done: items.every((i) => i.done), dismissed: g?.checklist_dismissed_at != null });
  });
  r.post('/checklist/dismiss', async (req, res) => {
    if (req.admin.role !== 'owner') throw fail(403, 'err.forbidden');
    const g = await db('organizations').where({ id: req.admin.organization_id }).first('id', 'name', 'checklist_dismissed_at');
    if (!g.checklist_dismissed_at) {
      await db.transaction(async (trx) => {
        await trx('organizations').where({ id: g.id }).update({ checklist_dismissed_at: new Date(now()).toISOString() });
        await audit(trx, req.admin, { action: 'org.checklist', storeId: req.admin.store_id, entityId: g.id, label: g.name, after: { dismissed: true } });
      });
    }
    res.status(204).end();
  });

  // { name, owner_email } → the organisation and its owner's one-time link. The owner makes the first store in the wizard.
  r.post('/orgs', async (req, res) => {
    superOnly(req.admin);
    const name = text(req.body?.name, 120, 'field.org_name', true);
    const email = emailOf(req.body?.owner_email);
    res.status(201).json(await db.transaction((trx) => newOrg(trx, req, name, email, now())));
  });

  // Task 45: a demo request → its organisation and owner invite in one step, and the request marked handled. Only super
  // does this: the public form itself never creates a tenant. { name (default: the request's company), owner_email }.
  r.post('/demo-requests/:id/org', async (req, res) => {
    superOnly(req.admin);
    const d = /^\d{1,9}$/.test(req.params.id) ? await db('demo_requests').where({ id: Number(req.params.id) }).first() : undefined;
    if (!d) throw fail(404, 'err.not_found');
    const name = text(req.body?.name ?? d.company, 120, 'field.org_name', true);
    const email = emailOf(req.body?.owner_email);
    const out = await db.transaction(async (trx) => {
      const org = await newOrg(trx, req, name, email, now());
      if (!d.handled_at) {
        await trx('demo_requests').where({ id: d.id }).update({ handled_at: new Date(now()).toISOString() });
        await audit(trx, req.admin, { action: 'demo.handle', entityId: d.id, label: d.company, before: { handled: false }, after: { handled: true } });
      }
      return org;
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
