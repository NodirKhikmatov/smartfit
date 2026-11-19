// Task 48: a shop's own size chart. Owners and managers (and super) keep one chart per size kind as the organisation's
// default and one per category; a new one starts as a copy of the built-in table (the editor gets it with the list).
// Every read and write is scoped to the caller's organisation (another organisation's category is a 404, like a
// missing one); staff and the mall admin never reach these routes (STAFF_ROUTES / MALL_ROUTES).
import { fail } from './routes.js';
import { audit } from './audit.js';
import { CHART_KINDS, validChart } from '../size/chart.js';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const view = (c) => ({ scope: c.scope, category_id: c.category_id ?? null, kind: c.kind, data: JSON.parse(c.data), updated_at: c.updated_at });

export function sizeChartRoutes(r, db) {
  const editor = (admin) => {
    if (!['owner', 'manager', 'super'].includes(admin.role)) throw fail(403, 'err.forbidden');
  };
  // The organisation: the admin's own; a super-admin names it (organization_id, or a store_id of it).
  async function orgOf(req, b) {
    if (req.admin.role !== 'super') {
      if (!req.admin.organization_id) throw fail(403, 'err.forbidden');
      return req.admin.organization_id;
    }
    const org = b.store_id != null
      ? (await db('stores').where({ id: Number(b.store_id) || 0 }).first('organization_id'))?.organization_id
      : (await db('organizations').where({ id: Number(b.organization_id) || 0 }).first('id'))?.id;
    if (!org) throw fail(400, 'err.invalid', { field: 'field.org' });
    return org;
  }
  // ':scope' = a size kind (the organisation's default) or a category id of this organisation with a sized kind.
  async function target(orgId, scope) {
    if (Object.hasOwn(CHART_KINDS, scope)) return { scope, kind: scope, category_id: null, label: scope };
    const c = /^\d{1,10}$/.test(scope) ? await db('categories').where({ id: Number(scope), organization_id: orgId }).first('id', 'name', 'size_kind') : null;
    if (!c) throw fail(404, 'err.not_found');
    if (!Object.hasOwn(CHART_KINDS, c.size_kind)) throw fail(400, 'err.chart_kind');
    return { scope: `c${c.id}`, kind: c.size_kind, category_id: c.id, label: c.name };
  }
  // The organisation's first store, so the owner's (store-scoped) audit viewer shows the row.
  const auditStore = async (q, orgId) => (await q('stores').where({ organization_id: orgId }).orderBy('id').first('id'))?.id ?? null;

  // → { kinds: { kind: { sizes, groups, measures, builtin } }, charts: [{ scope, category_id, kind, data, updated_at }] }
  r.get('/size-charts', async (req, res) => {
    editor(req.admin);
    const orgId = await orgOf(req, req.query);
    const charts = await db('size_charts').where({ organization_id: orgId }).orderBy('id');
    res.json({ kinds: CHART_KINDS, charts: charts.map(view) });
  });

  // { data, organization_id? (super) } → the saved chart. Replaces the whole chart of that scope.
  r.put('/size-charts/:scope', async (req, res) => {
    editor(req.admin);
    const b = plain(req.body) ? req.body : {};
    const orgId = await orgOf(req, b);
    const t = await target(orgId, req.params.scope);
    const data = validChart(t.kind, b.data);
    await db.transaction(async (trx) => {
      const old = await trx('size_charts').where({ organization_id: orgId, scope: t.scope }).first('data');
      const row = { organization_id: orgId, category_id: t.category_id, scope: t.scope, kind: t.kind, data: JSON.stringify(data), updated_by: req.admin.id, updated_at: trx.fn.now() };
      await trx('size_charts').insert(row).onConflict(['organization_id', 'scope']).merge(['category_id', 'kind', 'data', 'updated_by', 'updated_at']);
      await audit(trx, req.admin, { action: 'size_chart.save', storeId: await auditStore(trx, orgId), entityId: t.category_id, label: t.label,
        before: old ? { scope: t.scope, data: JSON.parse(old.data) } : null, after: { scope: t.scope, data } });
    });
    res.json(view(await db('size_charts').where({ organization_id: orgId, scope: t.scope }).first()));
  });

  // Back to the organisation's default (a category) or the built-in table (a default).
  r.delete('/size-charts/:scope', async (req, res) => {
    editor(req.admin);
    const orgId = await orgOf(req, req.query);
    const t = await target(orgId, req.params.scope);
    await db.transaction(async (trx) => {
      const old = await trx('size_charts').where({ organization_id: orgId, scope: t.scope }).first('data');
      if (!old) return;
      await trx('size_charts').where({ organization_id: orgId, scope: t.scope }).del();
      await audit(trx, req.admin, { action: 'size_chart.delete', storeId: await auditStore(trx, orgId), entityId: t.category_id, label: t.label,
        before: { scope: t.scope, data: JSON.parse(old.data) } });
    });
    res.status(204).end();
  });
}
