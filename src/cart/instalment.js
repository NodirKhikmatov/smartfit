// Task 35: "Muddatli to'lov (kassada)". No provider API: the store's own Uzum/Alif Nasiya terminal makes the contract.
// The server only computes the monthly amount the screens show and checks the term the customer picked.
import { fail } from '../admin/routes.js';
import { parseJson } from './promo.js';

export const TERM_MONTHS = [3, 6, 9, 12, 18, 24];

// The store's offered terms, shortest first, or null when instalments are off (or none are set).
export function termsOf(store) {
  if (!store?.instalment_on) return null;
  const terms = parseJson(store.instalment_terms, []);
  return terms.length ? terms : null;
}

// Integer so'm per month, rounded up: owed × (100 + percent) / 100 / months, in integer maths.
export const monthly = (owed, months, percent) => {
  const a = owed * (100 + percent), b = 100 * months;
  return Math.floor((a + b - 1) / b);
};

// What a screen shows for an amount: [{ months, percent, monthly }], or undefined (off, or nothing left to pay).
export const plan = (terms, owed) => (terms && owed >= 1 ? terms.map((t) => ({ ...t, monthly: monthly(owed, t.months, t.percent) })) : undefined);

// Settings form: [{ months, percent }] with months from TERM_MONTHS (each once) and an integer markup 0–100.
export function validTerms(v) {
  const bad = () => fail(400, 'err.invalid', { field: 'field.instalment_terms' });
  let list = v ?? [];
  if (typeof v === 'string') try { list = JSON.parse(v); } catch { throw bad(); }
  if (!Array.isArray(list) || list.length > TERM_MONTHS.length) throw bad();
  const out = list.map((x) => {
    if (!TERM_MONTHS.includes(x?.months) || !Number.isInteger(x.percent) || x.percent < 0 || x.percent > 100) throw bad();
    return { months: x.months, percent: x.percent };
  });
  if (new Set(out.map((x) => x.months)).size !== out.length) throw bad();
  return out.sort((a, b) => a.months - b.months);
}
