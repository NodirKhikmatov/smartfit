// AI stylist: Claude (task 7) or Gemini (task 56). The model only picks product IDs from CANDIDATES; the server re-checks every ID,
// fills missing categories by the rules and prices everything from the DB. Any failure → caller uses the rules.
import Anthropic from '@anthropic-ai/sdk';
import { fail } from '../admin/routes.js';
import { ORDER, requiredCategories, rankPool, cheaperAlternative, totalOf } from './engine.js';
import { t } from '../../public/shared/i18n.js';

export const TIMEOUT_MS = 8000;
export const DEFAULT_MODEL = 'claude-haiku-5-5'; // fast, takes images, and still accepts a forced tool_choice
export const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // takes images, free tier, ~1–3 s; the bigger Flash models answered 503 "high demand" on 2026-11-21
export const PHOTO_MAX = 300_000;
// Task 33: added only when the customer picked an occasion, so a request without one sends the same message as before.
// Task 40: added only for a child, so an adult request sends the same message as before. The candidates are already
// children's items only (the rules filter them); this tells Claude whom it dresses.
const CHILD_LINE = "AUDIENCE — bu bola uchun: SIZES bolaning bo'yi bo'yicha (sm), faqat bolalar kiyimlari berilgan; bolaga mos, qulay obraz tanla.";
const OCCASION_LINE = "OCCASION — mijoz bu kiyimni qayerga kiyadi: shu joyga mos uslubdagi kiyimlarni tanla va oldinga qo'y.";
// Extra user-message line per customer language (none for uz: the system prompt already asks for Uzbek).
const LANG_LINE = { ru: "Mijoz rus tilida gaplashadi: title, reason va style_guess rus tilida yozilsin.\n" }; // base64 chars (~220 KB JPEG); the app sends ~512 px, usually 30–60 KB

// System prompt from docs/SPEC.md ("Tavsiya uchun Claude API prompti"), word for word.
export const SYSTEM_PROMPT = `Sen kiyim do'konidagi stilistsan. Vazifang: mijozga bugungi ob-havoga mos 2-3 ta to'liq obraz tuzish. Qoidalar:
- Faqat CANDIDATES ro'yxatidagi product_id larni ishlat. Boshqa kiyim o'ylab topma.
- Har obrazda: top, bottom, shoes majburiy; outerwear harorat 18°C dan past yoki yomg'ir bo'lsa majburiy; accessory ixtiyoriy.
- Ranglar mos bo'lsin: neytral ranglar (qora, oq, kulrang, to'q ko'k, bej) hammasi bilan; ikkita yorqin rangni bir obrazga qo'yma.
- Rasmga qarab mijozning uslubini taxmin qil (klassik, sport, kundalik).
- BUDGET berilgan bo'lsa, obrazdagi narxlar yig'indisi undan oshmasin.
- Mijozning tashqi ko'rinishi haqida baho berma, faqat kiyim haqida yoz.
- Izohlar o'zbek tilida, har biri 1-2 gap.`;

export const SUBMIT_OUTFITS = {
  name: 'submit_outfits',
  input_schema: {
    type: 'object',
    required: ['outfits'],
    properties: {
      style_guess: { type: 'string' },
      outfits: {
        type: 'array', minItems: 1, maxItems: 3,
        items: {
          type: 'object',
          required: ['title', 'product_ids', 'reason'],
          properties: {
            title: { type: 'string' },
            product_ids: { type: 'array', items: { type: 'integer' } },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

// The optional customer photo: a JPEG data URL, held in memory for this one request only.
export function parsePhoto(v, max = PHOTO_MAX) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' && v.length <= max && /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m || !Buffer.from(m[1].slice(0, 8), 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) throw fail(400, 'err.invalid', { field: 'field.photo' });
  return m[1];
}

// Task 30, single items: the rules already chose the items per category; Claude only puts them in order.
export const SINGLE_PROMPT = `Sen kiyim do'konidagi stilistsan. Mijoz to'liq obraz emas, faqat WANT dagi toifalardan bitta kiyim qidiryapti. Vazifang: CANDIDATES ni eng mosidan boshlab tartiblash. Qoidalar:
- Faqat CANDIDATES ro'yxatidagi product_id larni ishlat. Boshqa kiyim o'ylab topma.
- Bugungi ob-havoga mosini oldinga qo'y.
- OWN — mijozda bor kiyimlar: ular bilan rangi va uslubi mos keladiganini oldinga qo'y; neytral ranglar (qora, oq, kulrang, to'q ko'k, bej) hammasi bilan, ikkita yorqin rang bir-biriga mos emas.
- Rasmga qarab mijozning uslubini taxmin qil (klassik, sport, kundalik).
- Mijozning tashqi ko'rinishi haqida baho berma.`;
export const SUBMIT_RANKING = {
  name: 'submit_ranking',
  input_schema: {
    type: 'object',
    required: ['product_ids'],
    properties: {
      style_guess: { type: 'string' },
      product_ids: { type: 'array', items: { type: 'integer' } },
    },
  },
};

// Shared by both providers: the system prompt, the tool and the user text for one request.
// lang: the customer's UI language. The spec prompt stays Uzbek; a Russian customer gets one extra line and Russian names.
// mode 'single' (task 30): the ranking prompt and tool, plus WANT and OWN.
// occasion (task 33): one of the fixed codes or null; the model gets its Uzbek name and one extra line, never free text.
function buildPrompt({ photo, weather, sizes, budget, candidates, lang = 'uz', mode = 'outfit', want = null, own = [], occasion = null, audience = 'adult' }) {
  const child = audience === 'child';
  const single = mode === 'single';
  const data = {
    WEATHER: { temperature: weather.temperature, apparent_temperature: weather.apparent_temperature, raining: weather.raining, wind_speed: weather.wind_speed },
    SIZES: sizes,
    BUDGET: budget,
    ...(single && { WANT: want, OWN: own }),
    ...(occasion && { OCCASION: t(`kiosk.occasion.${occasion}`, {}, 'uz') }),
    ...(child && { AUDIENCE: 'bola' }),
    CANDIDATES: candidates.map((p) => ({ product_id: p.id, name: (lang === 'ru' && p.name_ru) || p.name, category: p.category, color: p.color, style: p.style, price: p.unit_price, waterproof: p.waterproof, ...(p.shop && { shop: p.shop }) })), // shop: task 42, mall outfit only
  };
  return {
    system: single ? SINGLE_PROMPT : SYSTEM_PROMPT,
    tool: single ? SUBMIT_RANKING : SUBMIT_OUTFITS,
    text: (photo ? 'Mijoz rasmi yuqorida.' : "Mijoz rasmi yo'q (rasmsiz rejim).") + '\n' + (LANG_LINE[lang] ?? '') + (occasion ? `${OCCASION_LINE}\n` : '') + (child ? `${CHILD_LINE}\n` : '') + JSON.stringify(data),
  };
}

// Returns ask(input, signal) → the submit_outfits input or null, or null when there is no key (rules only).
export function createStylist({ client, apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL } = {}) {
  if (!client && !apiKey) return null;
  client ??= new Anthropic({ apiKey });
  const ask = async (input, signal) => {
    const { system, tool, text } = buildPrompt(input);
    const content = [
      ...(input.photo ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.photo } }] : []),
      { type: 'text', text },
    ];
    const msg = await client.messages.create(
      {
        model,
        max_tokens: 2048,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content }],
      },
      { signal, timeout: TIMEOUT_MS, maxRetries: 0 }, // one try: the 8 s budget has no room for retries
    );
    if (msg.stop_reason === 'refusal') return null;
    return msg.content.find((b) => b.type === 'tool_use' && b.name === tool.name)?.input ?? null;
  };
  return Object.assign(ask, { provider: 'claude' });
}

// Task 56: the same stylist on Google Gemini (REST generateContent, no SDK). Same prompt, same tool, forced call
// (mode ANY); the answer goes through the same applyStylist / applyRanking checks as Claude's.
// The key goes in a header, never in the URL, so it can't reach a proxy or access log.
export function createGeminiStylist({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || GEMINI_MODEL, fetchFn = fetch } = {}) {
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ask = async (input, signal) => {
    const { system, tool, text } = buildPrompt(input);
    const res = await fetchFn(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [...(input.photo ? [{ inlineData: { mimeType: 'image/jpeg', data: input.photo } }] : []), { text }] }],
        tools: [{ functionDeclarations: [{ name: tool.name, parameters: tool.input_schema }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tool.name] } },
        // LOW is the lowest thinking level gemini-3.8-flash accepts; thinking tokens count toward maxOutputTokens.
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } },
      }),
    });
    if (!res.ok) throw Object.assign(new Error('gemini request failed'), { status: res.status }); // never the body: it may echo the request
    const body = await res.json();
    const call = (body.candidates?.[0]?.content?.parts ?? []).find((p) => p.functionCall?.name === tool.name)?.functionCall;
    return call?.args ?? null; // blocked prompt, safety stop or no call → null → rules
  };
  return Object.assign(ask, { provider: 'gemini' });
}

// Task 56: AI_PROVIDER=claude|gemini picks one; unset (or unknown) → Claude when its key is set, else Gemini, else none.
export function pickStylist(env = process.env) {
  const claude = () => createStylist({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL });
  const gemini = () => createGeminiStylist({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || GEMINI_MODEL });
  if (env.AI_PROVIDER === 'gemini') return gemini();
  if (env.AI_PROVIDER === 'claude') return claude();
  return claude() ?? gemini();
}

// Runs fn(signal) with a hard deadline; on timeout the request is aborted and this rejects.
export async function withDeadline(fn, ms) {
  const ac = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')); }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Pure: turns Claude's answer into priced outfits, or null when nothing valid is left (→ rules).
// Only CANDIDATES IDs survive, one item per category, no item in two outfits; missing required categories
// are filled with the rules' next best unused item. Prices and totals come from the candidate rows (DB).
// cap (task 42, the mall outfit): the per-shop limit the rules kept; an outfit that would break it is dropped like an
// over-budget one, so Claude can't hand one shop the whole list either.
export function applyStylist(answer, candidates, { temperature, raining, budget = null, cap = null }) {
  if (!Array.isArray(answer?.outfits)) return null;
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const required = requiredCategories(temperature, raining);
  const pool = rankPool(candidates, { temperature, raining, budget });
  const used = new Set();
  const picked = [];
  for (const o of answer.outfits.slice(0, 3)) {
    const items = new Map(); // category → item
    for (const id of Array.isArray(o?.product_ids) ? o.product_ids : []) {
      const p = byId.get(id);
      if (p && !used.has(p.id) && !items.has(p.category)) items.set(p.category, p);
    }
    if (!items.size) continue; // nothing of Claude's left: not an AI outfit
    for (const c of required) {
      if (items.has(c)) continue;
      const p = pool[c].find((x) => !used.has(x.id));
      if (p) items.set(c, p);
    }
    if (!required.every((c) => items.has(c))) continue;
    const list = [...items.values()].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
    if (budget && totalOf(list) > budget) continue;
    if (cap && list.some((p) => [...picked.flatMap((o) => o.items), ...list].filter((x) => x.store_id === p.store_id).length > cap)) continue;
    list.forEach((p) => used.add(p.id));
    picked.push({ title: text(o.title, 80), reason: text(o.reason, 400), items: list });
  }
  if (!picked.length) return null;
  return {
    style_guess: text(answer.style_guess, 40) || null,
    over_budget: 0,
    outfits: picked.map((o) => ({ ...o, total: totalOf(o.items), alternative: cheaperAlternative(o.items, pool, used) })),
  };
}

// Pure, task 30: puts the rule groups' items in Claude's order. Only IDs the rules already showed move (unknown,
// repeated or non-integer IDs are ignored, nothing is added or dropped); unranked items keep the rules' order after
// the ranked ones. null when none of Claude's IDs is shown (→ rules).
export function applyRanking(answer, groups) {
  if (!Array.isArray(answer?.product_ids)) return null;
  const order = new Map();
  answer.product_ids.forEach((id, i) => Number.isInteger(id) && !order.has(id) && order.set(id, i));
  const rank = (p) => order.get(p.id) ?? Number.MAX_SAFE_INTEGER;
  if (!groups.some((g) => g.items.some((p) => order.has(p.id)))) return null;
  return {
    style_guess: text(answer.style_guess, 40) || null,
    groups: groups.map((g) => ({ ...g, items: [...g.items].sort((a, b) => rank(a) - rank(b)) })), // stable sort: rules order for ties
  };
}
