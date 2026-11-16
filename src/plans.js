// Task 45: plans, the trial, grace and the read-only state. One table of limits and features in code; no prices (the
// team hasn't set them, and the invoice is sent outside the app: super marks an organisation as paid until a day).
// Every "may this organisation do X now" goes through mayDo(): the admin middleware (read-only), the create routes
// (limits), the feature checks (stylist, instalments, points, try-on, offers) and the customer side (a paused shop).
// Nothing is ever deleted because of a plan: over a limit only adding more is refused; a feature switched off keeps its data.
import { fail, dayKey } from './admin/routes.js'; // used at call time only (routes.js imports this file too)
import { BUILTIN } from './db/migrations/023_categories.js';

export const FEATURES = ['stylist', 'instalments', 'points', 'tryon', 'offers'];
export const LIMITS = ['stores', 'products', 'kiosks', 'team'];
// team = active admins of the organisation + its open invites; kiosks = devices seen in the last 7 days.
export const PLANS = {
  start: { stores: 1, products: 300, kiosks: 2, team: 3, features: ['instalments'] },
  pro: { stores: 3, products: 3000, kiosks: 10, team: 15, features: FEATURES },
  biznes: { stores: 50, products: 20000, kiosks: 100, team: 100, features: FEATURES },
};
export const PLAN_NAMES = Object.keys(PLANS);
export const TRIAL_PLAN = 'pro';
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY_MS = 86400000;
const KIOSK_WINDOW_MS = 7 * DAY_MS; // the heartbeat forgets a device after a week (kiosk.js)
const PLAN_KEY = { start: 'adm.plan.n_start', pro: 'adm.plan.n_pro', biznes: 'adm.plan.n_biznes' };
const LIMIT_KEY = { stores: 'adm.plan.l_stores', products: 'adm.plan.l_products', kiosks: 'adm.plan.l_kiosks', team: 'adm.plan.l_team' };
const FEATURE_KEY = { stylist: 'adm.plan.f_stylist', instalments: 'adm.plan.f_instalments', points: 'adm.plan.f_points', tryon: 'adm.plan.f_tryon', offers: 'adm.plan.f_offers' };
const iso = (ms) => new Date(ms).toISOString();

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
// A new organisation's trial: today and the next 13 days (Tashkent), of Pro.
export const trialRow = (now = Date.now()) => ({ plan: TRIAL_PLAN, trial_until: addDays(dayKey(now), TRIAL_DAYS - 1) });

// trial_until / paid_until are the last days (inclusive, Tashkent) the organisation works fully. The later one counts.
// Then GRACE_DAYS more days that still work (with a warning), then read-only. Neither date = never ends: the demo,
// and every organisation from before plans (the migration), so nothing locks on upgrade.
export function planState(org, now = Date.now()) {
  const plan = Object.hasOwn(PLANS, org?.plan) ? org.plan : 'biznes'; // shortcut: an unknown plan never locks a paying shop
  const today = dayKey(now);
  const ends = [org?.trial_until, org?.paid_until].filter(Boolean).sort().at(-1) ?? null;
  const grace = ends && addDays(ends, GRACE_DAYS);
  const state = !ends ? 'active' : today <= ends ? (org.paid_until && org.paid_until >= today ? 'paid' : 'trial') : today <= grace ? 'grace' : 'readonly';
  return { plan, ...PLANS[plan], state, ends, grace_until: grace, readonly_from: grace && addDays(grace, 1), trial_until: org?.trial_until ?? null, paid_until: org?.paid_until ?? null };
}

const orgRow = (q, id) => q('organizations').where({ id }).first('id', 'plan', 'trial_until', 'paid_until');
const storesOfOrg = (q, orgId) => q('stores').where({ organization_id: orgId }).select('id');
const n = async (query) => Number((await query.count({ n: '*' }))[0].n);

// What counts toward one limit now.
export async function used(q, orgId, what, now = Date.now()) {
  if (what === 'stores') return n(q('stores').where({ organization_id: orgId }));
  if (what === 'products') return n(q('products').whereIn('store_id', storesOfOrg(q, orgId)));
  if (what === 'kiosks') return n(q('kiosks').whereIn('store_id', storesOfOrg(q, orgId)).where('last_seen_at', '>=', iso(now - KIOSK_WINDOW_MS)));
  return (await n(q('admins').where({ organization_id: orgId }).whereNull('disabled_at')))
    + (await n(q('admin_invites').where({ organization_id: orgId }).whereNull('used_at').where('expires_at', '>', iso(now))));
}
export async function usage(q, orgId, now = Date.now()) {
  return Object.fromEntries(await Promise.all(LIMITS.map(async (k) => [k, await used(q, orgId, k, now)])));
}

// The one check. what: 'read' (just the state), 'write' (not read-only), a limit (adding one more) or a feature.
// Throws 403 with a message that names the limit or feature and the plan; returns the state. A super-admin is the
// team: never limited (it fixes things for a shop). A store without an organisation (pre-task-22 data) has no plan.
export async function mayDo(q, orgId, what, { now = Date.now(), admin = null } = {}) {
  const org = orgId == null ? null : await orgRow(q, orgId);
  if (!org) return null;
  const s = planState(org, now);
  if (what === 'read' || admin?.role === 'super') return s;
  if (s.state === 'readonly') throw fail(403, 'err.plan_readonly');
  if (FEATURES.includes(what) && !s.features.includes(what)) throw fail(403, 'err.plan_feature', { feature: FEATURE_KEY[what], plan: PLAN_KEY[s.plan] });
  if (LIMITS.includes(what) && (await used(q, orgId, what, now)) >= s[what]) throw fail(403, 'err.plan_limit', { what: LIMIT_KEY[what], max: s[what], plan: PLAN_KEY[s.plan] });
  return s;
}
export const allows = (q, orgId, what, now = Date.now()) => mayDo(q, orgId, what, { now }).then(() => true, (err) => {
  if (err.status === 403) return false;
  throw err;
});

// The customer side of read-only: no cart line and no order for a paused shop.
export async function shopOpen(q, storeId, now = Date.now()) {
  const s = await q('stores').where({ id: storeId }).first('organization_id');
  if ((await mayDo(q, s?.organization_id, 'read', { now }))?.state === 'readonly') throw fail(403, 'err.shop_paused');
}

// Organisations a public list must leave out: read-only ones, and (with a feature) those whose plan lacks it.
// shortcut: reads every organisation with an end date or a smaller plan per call; cache it if there are thousands.
export async function closedOrgs(q, feature = null, now = Date.now()) {
  const lacking = PLAN_NAMES.filter((p) => feature && !PLANS[p].features.includes(feature));
  const rows = await q('organizations').where((w) => w.whereNotNull('trial_until').orWhereNotNull('paid_until').orWhereIn('plan', lacking))
    .select('id', 'plan', 'trial_until', 'paid_until');
  return rows.filter((o) => {
    const s = planState(o, now);
    return s.state === 'readonly' || (feature && !s.features.includes(feature));
  }).map((o) => o.id);
}
// q where col (an organisation id) is not one of ids; a row without an organisation stays.
export const openOrgs = (q, col, ids) => (ids.length ? q.where((w) => w.whereNull(col).orWhereNotIn(col, ids)) : q);

// The first-run checklist: each line from real data. done = every line ticked.
export async function checklist(q, orgId) {
  const stores = () => storesOfOrg(q, orgId);
  const has = async (query) => Boolean(await query.first());
  const items = {
    store: await has(q('stores').where({ organization_id: orgId }).whereNotNull('address').whereNotNull('opens_at').select('id')),
    categories: await has(q('categories').where({ organization_id: orgId }).whereNotIn('name', BUILTIN.map((c) => c.name)).select('id'))
      || await has(q('products').whereIn('store_id', stores()).select('id')),
    products: await has(q('products').whereIn('store_id', stores()).select('id')),
    kiosk_pin: await has(q('stores').where({ organization_id: orgId }).whereNotNull('kiosk_pin_hash').select('id')),
    // "QR printed": nothing records a print, so a kiosk that pinged or any customer visit (kiosk or phone) counts.
    qr: await has(q('kiosks').whereIn('store_id', stores()).select('id')) || await has(q('funnel_events').whereIn('store_id', stores()).select('id')),
    team: (await n(q('admins').where({ organization_id: orgId }).whereNull('disabled_at'))) >= 2,
  };
  return Object.entries(items).map(([key, done]) => ({ key, done }));
}
