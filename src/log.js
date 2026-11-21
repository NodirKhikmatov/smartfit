// Structured logs: console.* becomes one JSON line per entry ({time, level, msg, ...fields}) on stdout/stderr.
// Every string is redacted first: secrets from .env, data: URLs, long base64 runs and 32+ hex tokens
// (cart, order and recommendation tokens) never reach the log. Customer photos are never logged in the first place.

const SECRET_VARS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'PAYME_KEY', 'CLICK_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'ADMIN_TOKEN_SECRET', 'DATABASE_URL', 'POSTGRES_PASSWORD', 'ERROR_WEBHOOK_URL', 'FASHN_API_KEY'];
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error' };
const WEBHOOK_PER_MINUTE = 10;

export function redact(s, env = process.env) {
  let out = s
    .replace(/data:[^\s"'\\]*/g, '[data]')
    .replace(/[A-Za-z0-9+/=_-]{200,}/g, '[base64]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[token]');
  for (const name of SECRET_VARS) {
    const v = env[name];
    if (v && v.length >= 6) out = out.split(v).join('[secret]');
  }
  return out;
}

const text = (a) => (a instanceof Error ? a.stack || `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a));

// console.info({ msg, ...fields }) keeps the fields; anything else is joined into msg.
export function entry(level, args, env = process.env) {
  const one = args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Error) ? args[0] : null;
  const e = { time: new Date().toISOString(), level, ...(one ?? { msg: args.map(text).join(' ') }) };
  for (const [k, v] of Object.entries(e)) if (typeof v === 'string') e[k] = redact(v, env);
  return e;
}

// ERROR_WEBHOOK_URL (optional): every error entry is POSTed as JSON {text, content, level, time} — the shape Slack,
// Mattermost and Discord incoming webhooks accept — at most 10 a minute. Returns a function that restores console.
export function installLogging({ webhook = process.env.ERROR_WEBHOOK_URL, post = fetch, write, env = process.env } = {}) {
  write ??= (level, line) => (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
  const original = {};
  let sent = 0;
  let windowEnd = 0;
  const alert = (e) => {
    if (!webhook) return;
    if (Date.now() > windowEnd) [sent, windowEnd] = [0, Date.now() + 60_000];
    if (++sent > WEBHOOK_PER_MINUTE) return;
    const msg = `[smart-fit] ${e.msg ?? JSON.stringify(e)}`.slice(0, 1800);
    post(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: msg, content: msg, level: e.level, time: e.time }), signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok || write('warn', JSON.stringify({ time: new Date().toISOString(), level: 'warn', msg: `error webhook: HTTP ${r.status}` })))
      .catch((err) => write('warn', JSON.stringify({ time: new Date().toISOString(), level: 'warn', msg: `error webhook failed: ${err.name}` })));
  };
  for (const [method, level] of Object.entries(LEVELS)) {
    original[method] = console[method];
    console[method] = (...args) => {
      const e = entry(level, args, env);
      write(level, JSON.stringify(e));
      if (level === 'error') alert(e);
    };
  }
  return () => Object.assign(console, original);
}
