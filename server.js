/* 统一服务器：静态托管 H5 + 词库持久化到 PostgreSQL + 注册登录
 * - GET  /api/kv/:key         -> { value }  (按当前用户作用域；不存在返回 404)
 * - PUT  /api/kv/:key         -> 写入 JSON（body），覆盖式（按用户作用域）
 * - POST /api/auth/register   -> 注册并自动登录
 * - POST /api/auth/login      -> 登录
 * - POST /api/auth/logout     -> 登出
 * - GET  /api/auth/me         -> 当前登录用户（401 表示未登录）
 * - 其它路径                  -> 静态文件（项目根目录）
 * 绑定 0.0.0.0:8321，方便手机通过局域网 IP 访问
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = __dirname;
const PORT = process.env.PORT || 8321;
const HOST = process.env.HOST || '0.0.0.0';

const DB = {
  host: 'localhost',
  port: 5432,
  user: 'postuser',
  password: 'postuser',
  database: 'postuser',
  connectionTimeoutMillis: 3000, // 连不上时 3s 内失败，而非永久挂起
  query_timeout: 5000,
};

// 给数据库调用套一层硬超时，保证任何 KV 请求都必然在有限时间内返回（避免前端整个卡死）
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error((label || 'db') + ' timeout')); }, ms);
    })
  ]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let pool = null;
let dbReady = false; // PG 是否可用；不可用时 KV 接口快速返回，前端走本地兜底
function db() {
  if (!pool) pool = new Client(DB);
  return pool.connect().then(client => client).catch(async () => {
    // 懒连接：首次请求时连
    pool = new Client(DB);
    await pool.connect();
    return pool;
  });
}

function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

async function handleApi(req, res, key) {
  // 鉴权：所有 KV 操作必须登录
  const me = await getCurrentUser(req);
  if (!me) return sendJSON(res, 401, { value: null, error: 'not authenticated' });

  // PG 不可用：立即返回，绝不挂起（前端会回退到 localStorage）
  if (!pool) return sendJSON(res, 503, { value: null, error: 'db_unavailable' });

  // 把客户端传来的 key 映射到当前用户的命名空间：
  //   客户端沿用旧名 'wordweek.v1'（向后兼容）-> 实际 key = 'wordweek.v1.<userId>'
  // 其他 key 直接放行（保留未来扩展空间）
  const finalKey = (key === 'wordweek.v1') ? ('wordweek.v1.' + me.id) : key;

  try {
    if (req.method === 'GET') {
      const r = await withTimeout(pool.query('SELECT value FROM kv WHERE key=$1', [finalKey]), 5000, 'kv-get');
      if (!r.rows.length) {
        // 首次登录迁移：若用户的命名空间为空，且**没有任何其他用户已迁移过**（第一个登录的人拿老数据，其他人各自新建）
        if (key === 'wordweek.v1') {
          const anyUser = await withTimeout(pool.query("SELECT key FROM kv WHERE key LIKE 'wordweek.v1.%' LIMIT 1"), 3000, 'kv-check-users');
          if (!anyUser.rows.length) {
            const legacy = await withTimeout(pool.query('SELECT value FROM kv WHERE key=$1', ['wordweek.v1']), 3000, 'kv-legacy');
            if (legacy.rows.length) {
              const legacyVal = legacy.rows[0].value;
              await withTimeout(pool.query(
                'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
                [finalKey, legacyVal]
              ), 5000, 'kv-migrate');
              // 顺手把老 key 删掉，避免后续再次被错误地迁移给别的用户
              await withTimeout(pool.query('DELETE FROM kv WHERE key=$1', ['wordweek.v1']), 3000, 'kv-legacy-del');
              return sendJSON(res, 200, { value: legacyVal, migrated: true });
            }
          }
        }
        return sendJSON(res, 404, { value: null });
      }
      return sendJSON(res, 200, { value: r.rows[0].value });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const raw = await readBody(req);
      let val;
      try { val = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'invalid json' }); }
      await withTimeout(pool.query(
        'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [finalKey, val]
      ), 5000, 'kv-put');
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }
}

/* ---------- 在线 TTS 代理（有道词典发音，国内可达、无需 key） ----------
 * 浏览器内置 Web Speech API 在 Android / 微信 WebView 上常不可用或无声，
 * 故提供在线 TTS 兜底：前端请求同源 /api/tts，服务端转发到有道 dictvoice 取 MP3 返回。
 * 仅允许本域名来源的 GET 调用（无鉴权但限制 text 长度，防滥用）。
 */
function handleTts(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
  try {
    const u = new URL(req.url, 'http://localhost');
    const text = (u.searchParams.get('text') || '').trim();
    const type = u.searchParams.get('type') === '1' ? '1' : '2'; // 1=英音 2=美音
    if (!text) { res.writeHead(400); return res.end('missing text'); }
    if (Buffer.byteLength(text, 'utf8') > 200) { res.writeHead(400); return res.end('text too long'); }
    const target = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=' + type;
    const reqOpt = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; enStudy TTS)',
        'Referer': 'https://dict.youdao.com/'
      }
    };
    https.get(target, reqOpt, function (up) {
      res.writeHead(200, {
        'Content-Type': up.headers['content-type'] || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      up.pipe(res);
    }).on('error', function (e) {
      res.writeHead(502); res.end('tts upstream error: ' + e.message);
    });
  } catch (e) {
    res.writeHead(500); res.end('tts error: ' + e.message);
  }
}

/* ---------- 整句在线 TTS（有道逐词拼接，环境无可用整句 TTS 时的兜底） ----------
 * 有道 dictvoice 只能读单词、读不了整句；Google/Edge 整句接口在本服务器被网络拦截。
 * 故把例句拆成单词，逐词向有道取 MP3，剥离各自 ID3 头后拼接成一段 MP3 返回，安卓可直接播放。
 */
function stripId3(buf) {
  // 去掉开头的 ID3v2 标签，避免多段拼接时中段出现非法标签
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return buf.slice(size + 10);
  }
  return buf;
}
function fetchYoudaoMp3(word, type) {
  return new Promise(function (resolve) {
    const target = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + type;
    const reqOpt = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; enStudy TTS)', 'Referer': 'https://dict.youdao.com/' } };
    https.get(target, reqOpt, function (up) {
      if (up.statusCode !== 200 || (up.headers['content-type'] || '').indexOf('audio') === -1) { up.resume(); return resolve(null); }
      const chunks = [];
      up.on('data', c => chunks.push(c));
      up.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', () => resolve(null));
  });
}
/* ---------- 整句在线 TTS ----------
 * 优先用 edge-tts（Python，本机 ~/venvs/py312 已装）合成「自然整句」英文朗读；
 * 若 edge-tts 不可用（环境缺失/网络失败），回退到「有道逐词拼接」（不自然但能响）。
 * 前端例句发音统一打 /api/tts/sentence。
 */
const EDGE_PY = process.env.EDGE_TTS_PY ||
  path.join(process.env.HOME || '/Users/dingrc', 'venvs', 'py312', 'bin', 'python');
// 嗓音表：英音/美音沿用原设置；听写需要朗读中文释义，这里补上中文嗓音
const EDGE_VOICES = {
  'en-gb': 'en-GB-RyanNeural',
  'en-us': 'en-US-AriaNeural',
  'zh-cn': 'zh-CN-XiaoxiaoNeural' // 听写念中文（女声）；男声可用 zh-CN-YunjianNeural
};

// 主链路：edge-tts 自然朗读。cb(ok, buffer)。voiceOverride 可显式指定嗓音（听写中文用）
function tryEdgeSentence(text, lang, rate, cb, voiceOverride) {
  const key = (lang || 'en-US').replace('_', '-').toLowerCase();
  const voice = voiceOverride || EDGE_VOICES[key] || EDGE_VOICES['en-us'];
  const script = path.join(ROOT, 'tts_edge.py');
  let cp;
  try {
    // 注意：--rate 的值以 '-' 开头（如 -10%），必须用 --rate=-10% 等号写法，
    // 否则 argparse 会把 "-10%" 当成新选项而报错退出（导致静默降级到 youdao 兜底）。
    cp = spawn(EDGE_PY, [script, '--text', text, '--voice', voice, '--rate=' + (rate || '-10%')], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return cb(false);
  }
  const chunks = [];
  let stderr = '';
  let settled = false;
  const done = function (ok, buf) { if (!settled) { settled = true; cb(ok, buf); } };
  cp.stdout.on('data', function (d) { chunks.push(d); });
  cp.stderr.on('data', function (d) { stderr += d.toString(); });
  cp.on('error', function () { done(false); });
  const timer = setTimeout(function () { try { cp.kill(); } catch (e) {} done(false); }, 20000);
  cp.on('close', function (code) {
    clearTimeout(timer);
    const buf = Buffer.concat(chunks);
    if (code === 0 && buf.length > 200) done(true, buf);
    else { if (process.env.ENSTUDY_DEBUG) console.error('[edge-tts] fallback:', code, stderr.slice(0, 200)); done(false); }
  });
}

// 兜底：有道逐词拼接（不自然，但保证有声音）
function youdaoSentence(req, res, text, type) {
  const words = [];
  text.split(/\s+/).forEach(function (tok) {
    tok.split(/[-–—]/).forEach(function (part) {
      const cleaned = part.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
      if (!cleaned) return;
      cleaned.split("'").forEach(function (w) {
        w = w.toLowerCase();
        if (/^[a-z]{1,}$/.test(w)) words.push(w);
      });
    });
  });
  if (!words.length) { res.writeHead(400); return res.end('no pronounceable words'); }
  Promise.all(words.map(function (w) { return fetchYoudaoMp3(w, type); })).then(function (bufs) {
    const okBufs = bufs.filter(Boolean).map(stripId3);
    if (!okBufs.length) { res.writeHead(502); return res.end('no audio fetched'); }
    const out = Buffer.concat(okBufs);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Tts-Engine': 'youdao-fallback' });
    res.end(out);
  }).catch(function (e) {
    res.writeHead(500); res.end('sentence tts error: ' + e.message);
  });
}

function handleSentenceTts(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
  try {
    const u = new URL(req.url, 'http://localhost');
    const text = (u.searchParams.get('text') || '').trim();
    if (!text) { res.writeHead(400); return res.end('missing text'); }
    if (Buffer.byteLength(text, 'utf8') > 2000) { res.writeHead(400); return res.end('text too long'); }
    const type = u.searchParams.get('type') === '1' ? '1' : '2'; // 1=英音 2=美音
    const lang = type === '1' ? 'en-GB' : 'en-US';
    const rate = u.searchParams.get('rate') || '-10%';
    tryEdgeSentence(text, lang, rate, function (ok, buf) {
      if (ok) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Tts-Engine': 'edge' });
        return res.end(buf);
      }
      // edge 不可用 -> 有道逐词兜底
      return youdaoSentence(req, res, text, type);
    });
  } catch (e) {
    res.writeHead(500); res.end('sentence tts error: ' + e.message);
  }
}

/* ---------- 中文 TTS（听写专用）----------
 * 听写要「念出中文释义」，但有道 dictvoice 对中文返回 null audio（读不了），
 * 所以中文统一走 edge-tts 中文嗓音（默认女声 Xiaoxiao，可 ?g=m 切男声 Yunjian）。
 * 经 /api/tts 的 youdao 链路对中文无效，这里不做有道兜底；失败直接 502。
 */
function handleZhTts(req, res) {
  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
  try {
    const u = new URL(req.url, 'http://localhost');
    const text = (u.searchParams.get('text') || '').trim();
    if (!text) { res.writeHead(400); return res.end('missing text'); }
    if (Buffer.byteLength(text, 'utf8') > 2000) { res.writeHead(400); return res.end('text too long'); }
    const rate = u.searchParams.get('rate') || '-10%';
    const male = (u.searchParams.get('g') || '').toLowerCase() === 'm';
    const voice = male ? 'zh-CN-YunjianNeural' : 'zh-CN-XiaoxiaoNeural';
    tryEdgeSentence(text, 'zh-CN', rate, function (ok, buf) {
      if (ok) {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*', 'X-Tts-Engine': 'edge-zh'
        });
        return res.end(buf);
      }
      // 中文没有可用的在线兜底（有道读不了中文），明确报错便于前端提示
      res.writeHead(502); return res.end('chinese tts failed');
    }, voice);
  } catch (e) {
    res.writeHead(500); res.end('zh tts error: ' + e.message);
  }
}

/* ---------- 外部 AI 调用代理（规避浏览器 CORS） ----------
 * 浏览器直连 token-plan 等端点会被 CORS 拦截，故前端经本同源端点转发。
 * 仅允许白名单内的 https 服务商，避免沦为开放代理（SSRF 防护）。
 */
const ALLOWED_HOST_SUFFIXES = [
  'dashscope.aliyuncs.com', '.maas.aliyuncs.com',
  'api.siliconflow.cn', 'api.openai.com',
  'open.bigmodel.cn', '.bigmodel.cn'
];
function hostAllowed(h) {
  return ALLOWED_HOST_SUFFIXES.some(function (s) { return h === s || h.endsWith(s); });
}

/* ---------- 注册登录 ---------- */
// 用户名规则：3-31 位，必须以英文字母开头，仅含字母/数字/下划线
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,30}$/;
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + derived;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const salt = parts[0];
  const expected = parts[1];
  if (!salt || !expected) return false;
  const got = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected, 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach(function (c) {
    const i = c.indexOf('=');
    if (i >= 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, days) {
  const exp = new Date(Date.now() + (days || 30) * 864e5).toUTCString();
  res.setHeader('Set-Cookie', name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Expires=' + exp);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
async function getCurrentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !pool) return null;
  try {
    const r = await withTimeout(pool.query(
      'SELECT u.id, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = $1',
      [sid]
    ), 3000, 'auth-me');
    return r.rows[0] || null;
  } catch (e) { return null; }
}
async function initAuthSchema() {
  if (!pool) return;
  try {
    await withTimeout(pool.query([
      'CREATE TABLE IF NOT EXISTS users (',
      '  id            SERIAL PRIMARY KEY,',
      '  username      TEXT NOT NULL UNIQUE,',
      '  password_hash TEXT NOT NULL,',
      '  created_at    TIMESTAMP NOT NULL DEFAULT NOW()',
      ');',
      'CREATE TABLE IF NOT EXISTS sessions (',
      '  sid        TEXT PRIMARY KEY,',
      '  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
      '  created_at TIMESTAMP NOT NULL DEFAULT NOW()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);'
    ].join('\n')), 5000, 'auth-schema');
    console.log('✅ users / sessions 表已就绪');
  } catch (e) {
    console.error('⚠️ users/sessions 表创建失败：', e.message);
  }
}

async function handleAuthRegister(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) return sendJSON(res, 400, { error: '用户名 3-31 位，必须以英文字母开头，仅含字母/数字/下划线' });
  if (password.length < 4 || password.length > 64) return sendJSON(res, 400, { error: '密码 4-64 位' });
  if (!pool) return sendJSON(res, 503, { error: '数据库不可用' });
  try {
    const existed = await withTimeout(pool.query('SELECT id FROM users WHERE username=$1', [username]), 3000, 'auth-check');
    if (existed.rows.length) return sendJSON(res, 409, { error: '用户名已被占用' });
    const hash = hashPassword(password);
    const ins = await withTimeout(pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, hash]
    ), 3000, 'auth-insert');
    const user = ins.rows[0];
    const sid = crypto.randomBytes(32).toString('hex');
    await withTimeout(pool.query('INSERT INTO sessions (sid, user_id) VALUES ($1, $2)', [sid, user.id]), 3000, 'auth-session');
    setCookie(res, 'sid', sid, 30);
    return sendJSON(res, 200, { ok: true, userId: user.id, username: user.username, createdAt: user.created_at });
  } catch (e) { return sendJSON(res, 500, { error: e.message }); }
}

async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return sendJSON(res, 400, { error: '请输入用户名和密码' });
  if (!pool) return sendJSON(res, 503, { error: '数据库不可用' });
  try {
    const r = await withTimeout(pool.query('SELECT id, username, password_hash FROM users WHERE username=$1', [username]), 3000, 'auth-login');
    if (!r.rows.length) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const u = r.rows[0];
    if (!verifyPassword(password, u.password_hash)) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const sid = crypto.randomBytes(32).toString('hex');
    await withTimeout(pool.query('INSERT INTO sessions (sid, user_id) VALUES ($1, $2)', [sid, u.id]), 3000, 'auth-session');
    setCookie(res, 'sid', sid, 30);
    return sendJSON(res, 200, { ok: true, userId: u.id, username: u.username });
  } catch (e) { return sendJSON(res, 500, { error: e.message }); }
}

async function handleAuthLogout(req, res) {
  const sid = parseCookies(req).sid;
  if (sid && pool) {
    try { await withTimeout(pool.query('DELETE FROM sessions WHERE sid=$1', [sid]), 3000, 'auth-logout'); } catch (e) { }
  }
  clearCookie(res, 'sid');
  return sendJSON(res, 200, { ok: true });
}

async function handleAuthMe(req, res) {
  const u = await getCurrentUser(req);
  if (!u) return sendJSON(res, 401, { error: 'not authenticated' });
  return sendJSON(res, 200, { ok: true, userId: u.id, username: u.username, createdAt: u.created_at });
}

async function handleAiChat(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
  try {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'invalid json' }); }
    const apiBase = (body.apiBase || '').trim();
    const apiKey = (body.apiKey || '').trim();
    const messages = body.messages;
    if (!apiBase || !apiKey || !Array.isArray(messages)) {
      return sendJSON(res, 400, { error: '缺少 apiBase / apiKey / messages' });
    }
    let ub;
    try { ub = new URL(apiBase); } catch (e) { return sendJSON(res, 400, { error: 'apiBase 不是合法 URL' }); }
    if (ub.protocol !== 'https:') return sendJSON(res, 400, { error: '仅支持 https 端点' });
    if (!hostAllowed(ub.host)) return sendJSON(res, 403, { error: '该 apiBase 不在允许的服务商列表内' });
    const target = ub.origin + ub.pathname.replace(/\/+$/, '') + '/chat/completions';
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: body.model,
        messages: messages,
        max_tokens: body.max_tokens || 1024,
        temperature: (body.temperature != null ? body.temperature : 0.1)
      })
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    return sendJSON(res, 502, { error: '代理转发失败：' + e.message });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底：未知路径回 index.html
      const idx = path.join(ROOT, 'index.html');
      return fs.readFile(idx, (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(d2);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function main() {
  pool = new Client(DB);
  try {
    await withTimeout(pool.connect(), 3000, 'pg-connect');
    dbReady = true;
    await initAuthSchema();
    console.log('✅ 已连接 PostgreSQL (postuser@localhost:5432 / db: postuser / table: kv)');
  } catch (e) {
    console.error('⚠️ 无法连接 PostgreSQL（词库将只在浏览器本地缓存，无法持久化）：', e.message);
    try { await pool.end(); } catch (_) { }
    pool = null; dbReady = false;
  }
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/api/ai/chat') return handleAiChat(req, res);
    if (u === '/api/auth/register') return handleAuthRegister(req, res);
    if (u === '/api/auth/login') return handleAuthLogin(req, res);
    if (u === '/api/auth/logout') return handleAuthLogout(req, res);
    if (u === '/api/auth/me') return handleAuthMe(req, res);
    if (u === '/api/tts') return handleTts(req, res);
    if (u === '/api/tts/sentence') return handleSentenceTts(req, res);
    if (u === '/api/tts/zh') return handleZhTts(req, res);
    if (u.startsWith('/api/kv/')) {
      const key = decodeURIComponent(u.slice('/api/kv/'.length));
      return handleApi(req, res, key);
    }
    return serveStatic(req, res);
  });
  server.listen(PORT, HOST, () => {
    console.log('🚀 服务器已启动: http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
    console.log('   手机访问：用电脑局域网 IP 替换 127.0.0.1，例如 http://192.168.x.x:' + PORT);
    console.log('   词库状态：' + (dbReady ? '已接入 PostgreSQL' : 'PostgreSQL 不可用，词库仅本地缓存') + ' (postuser@localhost:5432 / db: postuser / table: kv)');
  });
}

main();
