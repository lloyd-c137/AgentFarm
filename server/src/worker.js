/* Agent Farm server: one Cloudflare Worker + D1.
   - /ingest/<source>  AI tools report events here (Claude Code http hook, the Codex forwarder, later the browser extension).
                       Authenticated by a per-device token; always answers with an empty 200 so it never decides anything for the AI.
   - /api/*            the farm page: who am I, poll the farm (version-gated), device tokens, manual harvest.
                       Authenticated by Cloudflare Access (its signed JWT), or DEV_USER when running locally.
   - everything else   the static farm page (public/).
   - every minute      a cron sweep marks quiet crops as lost contact and harvests ones left waiting too long. */

const NEEDS = new Set(['approval', 'reply', 'error', 'stalled']);
const SOURCES = { 'claude-code': 'Claude Code', codex: 'Codex', 'claude-web': 'Claude 聊天', 'chatgpt-web': 'ChatGPT 聊天' };
const ROW_OF = { codex: 0, 'claude-code': 1, 'claude-web': 2 };
const ROWS = 4, COLS = 8;
const MAX_BODY = 1 << 20;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/ingest/')) return await ingest(req, env, url, ctx);
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error('request failed', url.pathname, e && e.stack || e);
      return json({ error: 'server_error' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(sweep(env, Date.now())); }
};

/* ---------- helpers ---------- */
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const empty = status => new Response(null, { status });
async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const clip = (s, n) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);
// a short name for the board: about 8 CJK characters or 16 latin ones
function shortName(s) { let w = 0, out = ''; for (const ch of s) { w += /[\u0000-ÿ]/.test(ch) ? 1 : 2; if (w > 16) return out + '…'; out += ch; } return out; }
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/* ---------- who is asking ---------- */
let certCache = { at: 0, keys: [] };
async function accessKeys(env) {
  if (Date.now() - certCache.at < 10 * 60e3 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`); const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] }; return certCache.keys;
}
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function verifyAccessJwt(token, env) {
  const parts = token.split('.'); if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(unb64(parts[0]))), claims = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  const jwk = (await accessKeys(env)).find(k => k.kid === header.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1])); if (!ok) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD) || claims.exp * 1000 < Date.now() || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return claims;
}
/* accounts: email + password. Passwords are PBKDF2-SHA256 with a per-user salt; a login gets a random
   session token in an HttpOnly cookie, and only the token's hash is stored. Each email owns its own farm. */
const COOKIE = 'af_session', SESSION_DAYS = 90, PBKDF2_ITER = 100000; // 100k is the most Workers allows
const MAX_FAILS = 10, FAIL_WINDOW = 15 * 60e3;
const enc = new TextEncoder();
async function pbkdf2(password, salt, iter) {
  const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$'); if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter)), want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; return diff === 0;
}
function cookieOf(req, name) { const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : null; }
const sessionCookie = (v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function sessionEmail(req, env) {
  const c = cookieOf(req, COOKIE); if (!c) return null;
  const row = await env.DB.prepare('SELECT email, expires_at FROM sessions WHERE token_hash = ?').bind(await sha256hex(c)).first();
  return row && row.expires_at > Date.now() ? row.email : null;
}
async function startSession(env, email, body, status = 200) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256hex(token), email, now, now + SESSION_DAYS * 864e5).run();
  return json(body, status, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function credentials(req) {
  const b = await req.json().catch(() => ({}));
  return { email: clip(b.email, 120).toLowerCase(), password: typeof b.password === 'string' ? b.password : '', b };
}
async function register(req, env) {
  const { email, password } = await credentials(req);
  if (!EMAIL_RE.test(email)) return json({ error: 'bad_email' }, 400);
  if (password.length < 8 || password.length > 200) return json({ error: 'weak_password' }, 400);
  const res = await env.DB.prepare('INSERT OR IGNORE INTO users (email, pw, created_at) VALUES (?, ?, ?)').bind(email, await hashPassword(password), Date.now()).run();
  if (!res.meta.changes) return json({ error: 'email_taken' }, 409);
  await farmOf(env, email);
  return startSession(env, email, { email }, 201);
}
async function login(req, env) {
  const { email, password } = await credentials(req), now = Date.now();
  if (!EMAIL_RE.test(email) || !password) return json({ error: 'bad_login' }, 403);
  const fails = await env.DB.prepare('SELECT count, first_at FROM login_fails WHERE email = ?').bind(email).first();
  if (fails && now - fails.first_at < FAIL_WINDOW && fails.count >= MAX_FAILS) return json({ error: 'locked', retryAfterMin: Math.ceil((fails.first_at + FAIL_WINDOW - now) / 60e3) }, 429);
  const user = await env.DB.prepare('SELECT pw FROM users WHERE email = ?').bind(email).first();
  // hash something even for unknown emails so the response time doesn't reveal which emails exist
  const ok = user ? await checkPassword(password, user.pw) : (await hashPassword(password), false);
  if (!ok) {
    await env.DB.prepare('INSERT INTO login_fails (email, count, first_at) VALUES (?, 1, ?) ON CONFLICT(email) DO UPDATE SET count = CASE WHEN ? - first_at > ? THEN 1 ELSE count + 1 END, first_at = CASE WHEN ? - first_at > ? THEN ? ELSE first_at END')
      .bind(email, now, now, FAIL_WINDOW, now, FAIL_WINDOW, now).run();
    return json({ error: 'bad_login' }, 403);
  }
  await env.DB.prepare('DELETE FROM login_fails WHERE email = ?').bind(email).run();
  return startSession(env, email, { email });
}
async function logout(req, env) {
  const c = cookieOf(req, COOKIE);
  if (c) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(c)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}
async function changePassword(req, env, email) {
  const b = await req.json().catch(() => ({}));
  const user = await env.DB.prepare('SELECT pw FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await checkPassword(String(b.old || ''), user.pw))) return json({ error: 'bad_password' }, 403);
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) return json({ error: 'weak_password' }, 400);
  // a new password signs every other browser out
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw = ? WHERE email = ?').bind(await hashPassword(b.password), email),
    env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email)
  ]);
  return startSession(env, email, { ok: true });
}
const accessOn = env => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

async function userEmail(req, env) {
  if (env.DEV_USER) return String(env.DEV_USER).toLowerCase();
  if (!accessOn(env)) return sessionEmail(req, env);
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion'); if (!jwt) return null;
  const claims = await verifyAccessJwt(jwt, env).catch(() => null);
  return claims && claims.email ? String(claims.email).toLowerCase() : null;
}
async function farmOf(env, email) {
  const key = (await sha256hex(email)).slice(0, 24);
  let row = await env.DB.prepare('SELECT key, version FROM farms WHERE key = ?').bind(key).first();
  if (!row) { await env.DB.prepare('INSERT OR IGNORE INTO farms (key, email, created_at) VALUES (?, ?, ?)').bind(key, email, Date.now()).run(); row = { key, version: 1 }; }
  return row;
}
const bump = (env, farmKey) => env.DB.prepare('UPDATE farms SET version = version + 1 WHERE key = ?').bind(farmKey);

/* ---------- /api: the farm page ---------- */
async function api(req, env, url) {
  const path0 = url.pathname, accounts = !env.DEV_USER && !accessOn(env);
  if (accounts && req.method === 'POST' && (path0 === '/api/login' || path0 === '/api/register')) {
    // a JSON body can't be sent cross-site without a CORS preflight, which we never allow
    if (!(req.headers.get('Content-Type') || '').includes('application/json')) return json({ error: 'bad_request' }, 400);
    return path0 === '/api/login' ? login(req, env) : register(req, env);
  }
  if (accounts && req.method === 'POST' && path0 === '/api/logout') return logout(req, env);
  const email = await userEmail(req, env);
  if (!email) return json({ error: 'not_signed_in', login: accounts ? 'login.html' : null }, 401);
  const farm = await farmOf(env, email), path = url.pathname, m = req.method;
  // writes need our own header: a cross-site form or script can't add it without a CORS preflight we never allow
  if (m !== 'GET' && req.headers.get('X-Agent-Farm') !== '1') return json({ error: 'missing_header' }, 403);

  if (path === '/api/me' && m === 'GET') return json({ email });
  if (path === '/api/password' && m === 'POST') return accounts ? changePassword(req, env, email) : json({ error: 'not_available' }, 404);

  if (path === '/api/farm' && m === 'GET') {
    const v = Number(url.searchParams.get('v') || 0);
    if (v && v === farm.version) return empty(204);
    const now = Date.now(), tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz') || 0)));
    const dayStart = Math.floor((now - tz * 60e3) / 864e5) * 864e5 + tz * 60e3, weekStart = now - 7 * 864e5;
    const [live, today, week] = await env.DB.batch([
      env.DB.prepare('SELECT id, source, name, title, state, round, slot, msg, cwd_name, url, need_since, last_event_at, created_at FROM tasks WHERE farm_key = ? AND harvested_at IS NULL ORDER BY slot').bind(farm.key),
      env.DB.prepare('SELECT name, quality FROM tasks WHERE farm_key = ? AND harvested_at >= ? ORDER BY harvested_at').bind(farm.key, dayStart),
      env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE farm_key = ? AND harvested_at >= ?').bind(farm.key, weekStart)
    ]);
    return json({
      version: farm.version, now,
      tasks: live.results.map(t => ({ id: t.id, source: t.source, src: SOURCES[t.source] || t.source, name: t.name, full: t.title, state: t.state, round: t.round, slot: t.slot, msg: t.msg, cwd: t.cwd_name, url: t.url, needSince: t.need_since, lastEventAt: t.last_event_at, createdAt: t.created_at })),
      shipped: today.results.map(s => ({ name: s.name, q: s.quality || 'normal' })),
      harvestToday: today.results.length, harvestWeek: week.results[0].n
    });
  }

  const hm = path.match(/^\/api\/tasks\/([\w-]+)\/harvest$/);
  if (hm && m === 'POST') {
    const t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND farm_key = ? AND harvested_at IS NULL').bind(hm[1], farm.key).first();
    if (!t) return json({ error: 'not_found' }, 404);
    await env.DB.batch([env.DB.prepare('UPDATE tasks SET harvested_at = ?, quality = ? WHERE id = ?').bind(Date.now(), quality(t, Date.now()), t.id), bump(env, farm.key)]);
    return json({ ok: true });
  }

  if (path === '/api/devices' && m === 'GET') {
    const r = await env.DB.prepare('SELECT id, name, created_at, last_seen FROM devices WHERE farm_key = ? ORDER BY created_at DESC').bind(farm.key).all();
    return json({ devices: r.results });
  }
  if (path === '/api/devices' && m === 'POST') {
    const body = await req.json().catch(() => ({}));
    const name = clip(body.name, 40) || '我的电脑';
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE farm_key = ?').bind(farm.key).first();
    if (count.n >= 50) return json({ error: 'too_many_devices' }, 400);
    const token = 'af_' + b64url(crypto.getRandomValues(new Uint8Array(32))), id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO devices (id, farm_key, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, farm.key, name, await sha256hex(token), Date.now()).run();
    return json({ id, name, token });
  }
  const dm = path.match(/^\/api\/devices\/([\w-]+)$/);
  if (dm && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM devices WHERE id = ? AND farm_key = ?').bind(dm[1], farm.key).run();
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}

/* ---------- /ingest: events from the AI tools ---------- */
async function ingest(req, env, url, ctx) {
  if (req.method !== 'POST') return empty(405);
  const source = url.pathname.split('/')[2];
  if (!SOURCES[source]) return empty(404);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return empty(401);
  const dev = await env.DB.prepare('SELECT id, farm_key FROM devices WHERE token_hash = ?').bind(await sha256hex(token)).first();
  if (!dev) return empty(401);
  const text = await req.text();
  if (text.length > MAX_BODY) return empty(413);
  let body; try { body = JSON.parse(text); } catch (e) { return empty(400); }
  const ev = normalize(body);
  if (ev) await applyEvent(env, dev.farm_key, source, ev, Date.now());
  const now = Date.now();
  ctx.waitUntil(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)').bind(now, dev.id, now - 5 * 60e3).run());
  return empty(200); // an empty 2xx = "no decision": the hook never approves, blocks or adds anything
}

// the hook payloads of Claude Code and Codex share their field names; the extension will send the short names
function normalize(b) {
  if (!b || typeof b !== 'object') return null;
  const name = b.hook_event_name || b.event, sid = clip(b.session_id || b.conversation_id, 200);
  if (!sid) return null;
  const cwdName = b.cwd ? String(b.cwd).split(/[\\/]/).filter(Boolean).pop() || null : null, url = b.url ? clip(b.url, 300) : null;
  switch (name) {
    case 'UserPromptSubmit': case 'prompt': return { kind: 'prompt', sid, cwdName, url, title: clip(b.prompt || b.title, 60) };
    case 'PermissionRequest': case 'permission': return { kind: 'permission', sid, cwdName, url, msg: clip((b.tool_input && b.tool_input.description) || b.tool_name || b.message, 60) };
    case 'Notification': {
      const t = b.notification_type || '';
      if (t === 'permission_prompt' || (!t && /permission/i.test(b.message || ''))) return { kind: 'permission', sid, cwdName, url, msg: clip(b.message, 60) };
      if (t === 'idle_prompt') return { kind: 'stop', sid, cwdName, url, msg: '' };
      return null;
    }
    case 'Stop': case 'Interrupt': case 'stop': return { kind: 'stop', sid, cwdName, url, msg: clip(b.last_assistant_message || b.message, 80) };
    case 'StopFailure': case 'error': return { kind: 'error', sid, cwdName, url, msg: clip(b.error || b.error_type || b.message || 'API 出错', 80) };
    case 'SessionEnd': case 'end': return { kind: 'end', sid };
    case 'PreToolUse': case 'PostToolUse': case 'activity': return { kind: 'activity', sid };
    default: return null;
  }
}
// gold if you never kept it waiting over 10 minutes, silver if never over an hour; the wait still running counts too
function quality(t, now) {
  const running = NEEDS.has(t.state) && t.need_since ? now - t.need_since : 0;
  const over10 = t.waits_over10 + (running > 10 * 60e3 ? 1 : 0), over60 = t.waits_over60 + (running > 60 * 60e3 ? 1 : 0);
  return over10 === 0 ? 'gold' : over60 === 0 ? 'silver' : 'normal';
}
async function freeSlot(env, farmKey, source) {
  const r = await env.DB.prepare('SELECT slot FROM tasks WHERE farm_key = ? AND harvested_at IS NULL').bind(farmKey).all();
  const used = new Set(r.results.map(x => x.slot)), pref = ROW_OF[source] ?? 3;
  for (const row of [pref, 3, 0, 1, 2]) for (let c = 0; c < COLS; c++) if (!used.has(row * COLS + c)) return row * COLS + c;
  return -1;
}
async function applyEvent(env, farmKey, source, ev, now) {
  const id = (await sha256hex(`${farmKey}|${source}|${ev.sid}`)).slice(0, 20);
  let t = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (t && t.harvested_at) { // a session that comes back after its harvest grows a fresh crop
    if (ev.kind !== 'prompt') return;
    await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run(); t = null;
  }
  if (!t) {
    if (ev.kind === 'end' || ev.kind === 'activity') return;
    const slot = await freeSlot(env, farmKey, source); if (slot < 0) return;
    const title = ev.title || (ev.cwdName ? `${ev.cwdName} 里的任务` : '新任务');
    t = { id, state: 'working', round: 1, slot, msg: 'AI 正在干活', need_since: null, waits_over10: 0, waits_over60: 0, title, name: shortName(title), title_auto: ev.title ? 0 : 1, cwd_name: ev.cwdName, url: ev.url, created_at: now, isNew: true };
    if (ev.kind === 'prompt') { await write(env, farmKey, source, ev.sid, t, now); return; }
  }
  const wasNeed = NEEDS.has(t.state);
  const s = { ...t };
  if (ev.cwdName && !s.cwd_name) s.cwd_name = ev.cwdName;
  if (ev.url) s.url = ev.url;
  switch (ev.kind) {
    case 'prompt':
      if (wasNeed) { const w = now - (t.need_since || now); if (w > 10 * 60e3) s.waits_over10++; if (w > 60 * 60e3) s.waits_over60++; s.round++; }
      s.state = 'working'; s.need_since = null; s.msg = 'AI 正在干活';
      if (ev.title && t.title_auto) { s.title = ev.title; s.name = shortName(ev.title); s.title_auto = 0; }
      break;
    case 'permission': s.need_since = wasNeed ? (t.need_since || now) : now; s.state = 'approval'; s.msg = ev.msg ? `请求授权：${ev.msg}` : '请求授权'; break;
    case 'stop': s.need_since = wasNeed ? (t.need_since || now) : now; s.state = 'reply'; s.msg = ev.msg || 'AI 做完一轮，等你回复'; break;
    case 'error': s.need_since = wasNeed ? (t.need_since || now) : now; s.state = 'error'; s.msg = ev.msg; break;
    case 'activity':
      if (t.state !== 'stalled' && now - t.last_event_at < 60e3) return; // heartbeats write at most once a minute
      if (t.state === 'stalled') { s.state = 'working'; s.need_since = null; s.msg = '重新上报，继续干活'; }
      break;
    case 'end':
      if (t.isNew) return;
      await env.DB.batch([env.DB.prepare('UPDATE tasks SET harvested_at = ?, quality = ?, last_event_at = ? WHERE id = ?').bind(now, quality(t, now), now, id), bump(env, farmKey)]);
      return;
  }
  await write(env, farmKey, source, ev.sid, s, now);
}
async function write(env, farmKey, source, sid, s, now) {
  const stmt = s.isNew
    ? env.DB.prepare('INSERT INTO tasks (id, farm_key, source, session_id, name, title, title_auto, state, round, slot, msg, cwd_name, url, need_since, waits_over10, waits_over60, last_event_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(s.id, farmKey, source, sid, s.name, s.title, s.title_auto, s.state, s.round, s.slot, s.msg, s.cwd_name, s.url, s.need_since, s.waits_over10, s.waits_over60, now, s.created_at)
    : env.DB.prepare('UPDATE tasks SET name = ?, title = ?, title_auto = ?, state = ?, round = ?, msg = ?, cwd_name = ?, url = ?, need_since = ?, waits_over10 = ?, waits_over60 = ?, last_event_at = ? WHERE id = ?')
      .bind(s.name, s.title, s.title_auto, s.state, s.round, s.msg, s.cwd_name, s.url, s.need_since, s.waits_over10, s.waits_over60, now, s.id);
  await env.DB.batch([stmt, bump(env, farmKey)]);
}

/* ---------- the minute sweep: lost contact, long waits, old history ---------- */
export async function sweep(env, now) {
  const stallMin = num(env.STALL_MINUTES, 30), harvestH = num(env.AUTO_HARVEST_HOURS, 24);
  const [stalled, harvested] = await env.DB.batch([
    env.DB.prepare("UPDATE tasks SET state = 'stalled', need_since = ?, msg = ? WHERE harvested_at IS NULL AND state = 'working' AND last_event_at < ? RETURNING farm_key")
      .bind(now, `${stallMin} 分钟没有任何上报，可能卡住了或忘了汇报`, now - stallMin * 60e3),
    env.DB.prepare("UPDATE tasks SET harvested_at = ?, quality = CASE WHEN waits_over60 = 0 THEN 'silver' ELSE 'normal' END WHERE harvested_at IS NULL AND state IN ('reply', 'approval', 'error', 'stalled') AND COALESCE(need_since, last_event_at) < ? RETURNING farm_key")
      .bind(now, now - harvestH * 3600e3)
  ]);
  const farms = new Set([...stalled.results, ...harvested.results].map(r => r.farm_key));
  const stmts = [...farms].map(k => bump(env, k));
  stmts.push(env.DB.prepare('DELETE FROM tasks WHERE harvested_at IS NOT NULL AND harvested_at < ?').bind(now - 30 * 864e5));
  if (new Date(now).getUTCMinutes() === 0) stmts.push( // hourly housekeeping
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_fails WHERE first_at < ?').bind(now - FAIL_WINDOW));
  await env.DB.batch(stmts);
  return { stalled: stalled.results.length, harvested: harvested.results.length };
}
