// CONNECT MEET — сервер бота и мини-приложения.
// Без внешних библиотек: нужен только Node.js 20+.
// Переменные окружения:
//   BOT_TOKEN   — токен бота от @BotFather (обязательно)
//   ADMIN_ID    — Telegram ID администратора, который проверяет фото
//                 (если не задан, админом станет первый, кто нажмёт /start)
//   PUBLIC_URL  — адрес сервера (на Render берётся сам из RENDER_EXTERNAL_URL)
//   PORT        — порт (Render задаёт сам)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEV_AUTH = process.env.DEV_AUTH === '1'; // только для локальной проверки
const MAX_DISTANCE_M = 300;      // насколько близко должны стоять двое
const QR_TTL_MS = 5 * 60 * 1000; // QR действует 5 минут
const PAIR_COOLDOWN_MS = 24 * 3600 * 1000; // одна награда на пару в сутки

if (!BOT_TOKEN) { console.error('Нет BOT_TOKEN. Добавь его в переменные окружения.'); process.exit(1); }

/* ---------------- хранилище ---------------- */
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { admin: process.env.ADMIN_ID ? +process.env.ADMIN_ID : null, users: {}, invites: {}, meetings: [], qr: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
if (process.env.ADMIN_ID) db.admin = +process.env.ADMIN_ID;
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 200);
}
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');

/* ---------------- Telegram API ---------------- */
async function tg(method, body) {
  try {
    const isForm = body instanceof FormData;
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.error('Telegram', method, j.description);
    return j;
  } catch (e) { console.error('Telegram', method, e.message); return { ok: false }; }
}
const appButton = (text = 'Открыть CONNECT MEET') => ({ inline_keyboard: [[{ text, web_app: { url: PUBLIC_URL + '/' } }]] });
const notify = (uid, text) => tg('sendMessage', { chat_id: uid, text, parse_mode: 'HTML', reply_markup: appButton() });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function sendPhotoToAdmin(u) {
  if (!db.admin) return;
  const fd = new FormData();
  fd.append('chat_id', String(db.admin));
  fd.append('caption', `📷 Новое фото на проверку\n${u.name}, ${u.age} · ${u.city}\nID: ${u.id}`);
  fd.append('reply_markup', JSON.stringify({ inline_keyboard: [[
    { text: '✅ Одобрить', callback_data: `ph:ok:${u.id}` }, { text: '❌ Отклонить', callback_data: `ph:no:${u.id}` }]] }));
  fd.append('photo', new Blob([fs.readFileSync(photoPath(u))], { type: 'image/jpeg' }), 'photo.jpg');
  await tg('sendPhoto', fd);
}
const photoPath = u => path.join(DATA_DIR, 'photos', `${u.photoKey}.jpg`);

/* ---------------- проверка входа из Telegram ---------------- */
function checkInitData(initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dataCheck = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - +p.get('auth_date') > 7 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

function getUser(tgUser) {
  const id = String(tgUser.id);
  let u = db.users[id];
  if (!u) {
    u = db.users[id] = { id, name: tgUser.first_name || 'Без имени', username: tgUser.username || '', age: null, city: '', about: '',
      photoKey: null, photoStatus: 'none', meet: 0, created: Date.now(), profileDone: false };
    if (!db.admin) db.admin = +id;
    save();
  }
  if (tgUser.username !== undefined) u.username = tgUser.username || '';
  return u;
}

/* ---------------- вспомогательное ---------------- */
function publicUser(u) {
  return { id: u.id, name: u.name, age: u.age, city: u.city, about: u.about, meet: u.meet,
    photo: u.photoStatus === 'approved' ? `/photo/${u.photoKey}.jpg` : null };
}
function distanceM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const validLoc = l => l && Number.isFinite(+l.lat) && Number.isFinite(+l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180;
function pairKey(a, b) { return [a, b].sort().join(':'); }
function lastMeeting(a, b) { const k = pairKey(a, b); return db.meetings.filter(m => pairKey(m.a, m.b) === k).pop(); }
function cleanupQr() { const now = Date.now(); for (const [k, v] of Object.entries(db.qr)) if (v.exp < now) delete db.qr[k]; }

class ApiError extends Error {}
const fail = msg => { throw new ApiError(msg); };

/* ---------------- API мини-приложения ---------------- */
const api = {
  me(u) {
    return { me: { ...publicUser(u), username: u.username, photoStatus: u.photoStatus, profileDone: u.profileDone,
      ownPhoto: u.photoKey ? `/photo/${u.photoKey}.jpg` : null }, isAdmin: +u.id === db.admin,
      people: Object.keys(db.users).length };
  },

  profile(u, b) {
    const name = String(b.name || '').trim().slice(0, 30);
    const age = parseInt(b.age, 10);
    const city = String(b.city || '').trim().slice(0, 40);
    if (!name) fail('Напиши имя');
    if (!(age >= 18 && age <= 99)) fail('CONNECT MEET только для тех, кому 18+');
    if (city.length < 2) fail('Напиши город');
    Object.assign(u, { name, age, city, about: String(b.about || '').trim().slice(0, 300), profileDone: true });
    save();
    return api.me(u);
  },

  async photo(u, b) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(b.data || ''));
    if (!m) fail('Не удалось прочитать фото');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2_500_000) fail('Фото слишком большое');
    if (!u.profileDone) fail('Сначала заполни анкету');
    if (u.photoKey) try { fs.unlinkSync(photoPath(u)); } catch {}
    u.photoKey = rid(12);
    fs.writeFileSync(photoPath(u), buf);
    u.photoStatus = 'pending';
    save();
    if (+u.id === db.admin) { // админ сам себе фото не проверяет
      u.photoStatus = 'approved'; save();
    } else await sendPhotoToAdmin(u);
    return api.me(u);
  },

  people(u) {
    const mine = Object.values(db.invites).filter(i => i.from === u.id || i.to === u.id);
    const rel = id => {
      const i = mine.filter(x => x.from === id || x.to === id).pop();
      if (!i) return null;
      if (i.status === 'accepted') return 'match';
      if (i.status === 'pending') return i.from === u.id ? 'sent' : 'incoming';
      return null;
    };
    return { list: Object.values(db.users)
      .filter(x => x.id !== u.id && x.profileDone && x.photoStatus === 'approved')
      .sort((a, b) => b.created - a.created).slice(0, 100)
      .map(x => ({ ...publicUser(x), rel: rel(x.id) })) };
  },

  async invite(u, b) {
    if (u.photoStatus !== 'approved') fail('Приглашать можно после проверки фото');
    const to = db.users[String(b.to)];
    if (!to || to.id === u.id || to.photoStatus !== 'approved') fail('Человек не найден');
    const open = Object.values(db.invites).find(i => pairKey(i.from, i.to) === pairKey(u.id, to.id) && i.status !== 'declined');
    if (open) fail(open.status === 'accepted' ? 'Вы уже договорились о встрече' : 'Приглашение уже отправлено');
    const id = rid(6);
    db.invites[id] = { id, from: u.id, to: to.id, status: 'pending', created: Date.now() };
    save();
    await notify(to.id, `${esc(u.name)} приглашает вас познакомиться.`);
    return { ok: true };
  },

  invites(u) {
    const view = i => {
      const other = db.users[i.from === u.id ? i.to : i.from];
      const last = lastMeeting(i.from, i.to);
      return { id: i.id, status: i.status, mine: i.from === u.id, created: i.created, user: other ? publicUser(other) : null,
        nextAt: last ? last.time + PAIR_COOLDOWN_MS : 0 };
    };
    const all = Object.values(db.invites).filter(i => (i.from === u.id || i.to === u.id) && i.status !== 'declined')
      .sort((a, b) => b.created - a.created).map(view).filter(x => x.user);
    return {
      incoming: all.filter(x => x.status === 'pending' && !x.mine),
      outgoing: all.filter(x => x.status === 'pending' && x.mine),
      matches: all.filter(x => x.status === 'accepted'),
    };
  },

  async answer(u, b) {
    const i = db.invites[b.id];
    if (!i || i.to !== u.id || i.status !== 'pending') fail('Приглашение не найдено');
    i.status = b.accept ? 'accepted' : 'declined';
    save();
    if (b.accept) await notify(i.from, `${esc(u.name)} принимает ваше приглашение! Договоритесь о месте и подтвердите встречу по QR-коду.`);
    return api.invites(u);
  },

  qr(u, b) {
    const i = db.invites[b.id];
    if (!i || i.status !== 'accepted' || (i.from !== u.id && i.to !== u.id)) fail('Встреча не найдена');
    if (!validLoc(b.loc)) fail('Нужна геолокация');
    const last = lastMeeting(i.from, i.to);
    if (last && Date.now() - last.time < PAIR_COOLDOWN_MS) fail('С этим человеком MEET можно получить раз в сутки');
    cleanupQr();
    const token = rid(12);
    db.qr[token] = { invite: i.id, user: u.id, loc: { lat: +b.loc.lat, lon: +b.loc.lon }, exp: Date.now() + QR_TTL_MS };
    save();
    return { code: `cmeet:${token}`, exp: db.qr[token].exp };
  },

  async confirm(u, b) {
    const token = String(b.code || '').replace(/^cmeet:/, '');
    cleanupQr();
    const q = db.qr[token];
    if (!q) fail('QR устарел или не от CONNECT MEET. Попроси показать новый');
    if (q.user === u.id) fail('Это твой собственный QR');
    const i = db.invites[q.invite];
    if (!i || (i.from !== u.id && i.to !== u.id)) fail('Этот QR для встречи с другим человеком');
    if (!validLoc(b.loc)) fail('Нужна геолокация');
    const d = distanceM(q.loc, { lat: +b.loc.lat, lon: +b.loc.lon });
    if (d > MAX_DISTANCE_M) fail(`Вы слишком далеко друг от друга (${Math.round(d)} м). Подойдите ближе`);
    const last = lastMeeting(i.from, i.to);
    if (last && Date.now() - last.time < PAIR_COOLDOWN_MS) fail('С этим человеком MEET можно получить раз в сутки');
    delete db.qr[token];
    const a = db.users[q.user], me = u;
    a.meet += 1; me.meet += 1;
    const m = { id: rid(6), a: a.id, b: me.id, time: Date.now(), n: db.meetings.length + 1, dist: Math.round(d) };
    db.meetings.push(m);
    save();
    await notify(a.id, `🎉 Встреча с ${esc(me.name)} подтверждена! +1 MEET`);
    await notify(me.id, `🎉 Встреча с ${esc(a.name)} подтверждена! +1 MEET`);
    return { ok: true, n: m.n, with: a.name, meet: me.meet };
  },

  history(u) {
    return { list: db.meetings.filter(m => m.a === u.id || m.b === u.id).reverse().map(m => {
      const o = db.users[m.a === u.id ? m.b : m.a];
      return { n: m.n, time: m.time, name: o ? o.name : '—', photo: o && o.photoStatus === 'approved' ? `/photo/${o.photoKey}.jpg` : null };
    }) };
  },
};

/* ---------------- бот ---------------- */
async function onUpdate(up) {
  if (up.message) {
    const msg = up.message, from = msg.from;
    if (!from || msg.chat.type !== 'private') return;
    const u = getUser(from);
    const text = msg.text || '';
    if (text.startsWith('/start')) {
      await tg('sendMessage', { chat_id: from.id, parse_mode: 'HTML', reply_markup: appButton(),
        text: '<b>CONNECT MEET: знакомства и реальные встречи.</b>\n\n' +
          'Заполните анкету, дождитесь проверки фото, договоритесь о встрече в общественном месте и подтвердите её вместе с собеседником по QR-коду и геолокации. ' +
          'За подтверждённую встречу каждый участник получает 1 MEET.\n\n' +
          'Сейчас работает тестовый режим: реальные платежи и выплаты не проводятся.' +
          (+u.id === db.admin ? '\n\n👑 Вы администратор: фото новых участников будут приходить сюда на проверку.' : '') });
      return;
    }
    await tg('sendMessage', { chat_id: from.id, text: 'Всё происходит в приложении 👇', reply_markup: appButton() });
    return;
  }
  if (up.callback_query) {
    const cq = up.callback_query;
    const [kind, act, uid] = String(cq.data || '').split(':');
    if (kind !== 'ph') return tg('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.from.id !== db.admin) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Только для администратора' });
    const u = db.users[uid];
    if (!u || u.photoStatus !== 'pending') return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Уже проверено' });
    u.photoStatus = act === 'ok' ? 'approved' : 'rejected';
    save();
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: act === 'ok' ? 'Одобрено' : 'Отклонено' });
    await tg('editMessageCaption', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      caption: `${cq.message.caption || ''}\n\n${act === 'ok' ? '✅ Одобрено' : '❌ Отклонено'}` });
    await notify(u.id, act === 'ok' ? 'Ваше фото одобрено. Откройте приложение, чтобы продолжить.'
      : 'Фото не прошло проверку. На фото должно быть хорошо видно ваше лицо. Загрузите другое в приложении.');
  }
}

/* ---------------- HTTP ---------------- */
const WEBHOOK_PATH = '/tg/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 24);
const INDEX = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'index.html');

function readBody(req, limit) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { rej(new ApiError('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      const up = JSON.parse(await readBody(req, 1_000_000) || '{}');
      send(res, 200, { ok: true });
      onUpdate(up).catch(e => console.error('update', e));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!Object.hasOwn(api, name)) return send(res, 404, { error: 'Нет такого метода' });
      const body = JSON.parse(await readBody(req, 4_000_000) || '{}');
      let tgUser = checkInitData(req.headers['x-init-data']);
      if (!tgUser && DEV_AUTH && req.headers['x-dev-user']) tgUser = JSON.parse(decodeURIComponent(req.headers['x-dev-user']));
      if (!tgUser) return send(res, 401, { error: 'Открой приложение через бота в Telegram' });
      const u = getUser(tgUser);
      return send(res, 200, await api[name](u, body));
    }
    if (req.method === 'GET' && /^\/photo\/[\w-]+\.jpg$/.test(url.pathname)) {
      const key = url.pathname.slice(7, -4);
      const owner = Object.values(db.users).find(x => x.photoKey === key);
      if (!owner) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(photoPath(owner)).pipe(res);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true, users: Object.keys(db.users).length });
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if (e instanceof ApiError) return send(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, async () => {
  console.log(`CONNECT MEET слушает порт ${PORT}`);
  if (!PUBLIC_URL) { console.warn('PUBLIC_URL не задан — webhook не установлен'); return; }
  const r = await tg('setWebhook', { url: PUBLIC_URL + WEBHOOK_PATH, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  if (r.ok) console.log('Webhook установлен:', PUBLIC_URL);
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: PUBLIC_URL + '/' } } });
});
