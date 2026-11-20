// 메리 미 이프 유 캔 — 웹 푸시 테스트 서버
// 의존성: web-push 하나뿐. 나머지는 Node 기본 모듈.
// 실행: npm install && npm start

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env 읽기 (dotenv 없이) ----------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

let webpush;
try {
  webpush = require('web-push');
} catch (e) {
  console.error('\n[!] web-push 패키지가 없습니다. 먼저 `npm install` 을 실행하세요.\n');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = 'Asia/Seoul';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 관리자 키 ----------
let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  const f = path.join(DATA_DIR, 'admin-key.txt');
  if (fs.existsSync(f)) ADMIN_KEY = fs.readFileSync(f, 'utf8').trim();
  else {
    ADMIN_KEY = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(f, ADMIN_KEY);
  }
  console.warn(`[!] ADMIN_KEY 환경변수가 없어 임시 키를 만들었습니다: ${ADMIN_KEY}`);
}

// ---------- VAPID 키 ----------
// 키가 바뀌면 기존 구독이 전부 무효가 되므로, 배포 환경에서는 반드시 환경변수로 고정하세요.
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const f = path.join(DATA_DIR, 'vapid.json');
  let keys;
  if (fs.existsSync(f)) keys = JSON.parse(fs.readFileSync(f, 'utf8'));
  else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(f, JSON.stringify(keys, null, 2));
  }
  VAPID_PUBLIC = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
  console.warn('[!] VAPID 키를 환경변수에 고정하세요 (배포 서버가 재시작되면 키가 바뀔 수 있음):');
  console.warn(`    VAPID_PUBLIC_KEY=${VAPID_PUBLIC}`);
  console.warn(`    VAPID_PRIVATE_KEY=${VAPID_PRIVATE}`);
}
// 애플 푸시 서버는 subject가 실제 메일 주소/https URL이 아니면 거부함
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// ---------- 저장소 (JSON 파일) ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DEFAULT_DB = {
  subs: [],
  schedule: {
    enabled: true,
    time: '21:00',
    title: '🔴 ON AIR',
    body: '오늘 밤 방송이 시작됐어요. 지금 입장하세요!',
    url: '/onair.html',
    lastSentDate: null,
  },
  oneShot: null,
  logs: [],
};
let db = DEFAULT_DB;
try {
  if (fs.existsSync(DB_FILE)) db = { ...DEFAULT_DB, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  console.error('db.json 읽기 실패, 새로 시작합니다.', e.message);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}

// ---------- 시간 도우미 (KST) ----------
function kstNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` };
}
const kstToDate = (date, hm) => new Date(`${date}T${hm}:00+09:00`);

// ---------- 발송 ----------
const newId = () => crypto.randomBytes(4).toString('hex');

async function sendPush({ kind, title, body, url, targetIds = null, scheduledFor = null }) {
  const targets = db.subs.filter((s) => !targetIds || targetIds.includes(s.id));
  const log = {
    id: newId(),
    kind, // manual | scheduled | oneshot | self
    title, body, url,
    scheduledFor,
    sentAt: new Date().toISOString(),
    results: {}, // subId -> { status, error? }
    acks: {},    // subId -> { receivedAt, clickedAt }
  };
  db.logs.unshift(log);
  db.logs = db.logs.slice(0, 100);

  const payload = JSON.stringify({ id: log.id, title, body, url: url || '/onair.html', sentAt: log.sentAt });
  const dead = [];

  await Promise.all(targets.map(async (s) => {
    try {
      const r = await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        payload,
        { TTL: 60 * 60, urgency: 'high' } // high: 안드로이드 도즈(절전) 상태에서도 최대한 빨리 깨우도록 요청
      );
      log.results[s.id] = { status: r.statusCode };
      s.lastStatus = `OK ${r.statusCode}`;
    } catch (err) {
      const code = err.statusCode || 0;
      log.results[s.id] = { status: code, error: (err.body || err.message || '').toString().slice(0, 200) };
      s.lastStatus = `실패 ${code}`;
      if (code === 404 || code === 410) dead.push(s.id); // 만료/해지된 구독
    }
    s.lastStatusAt = new Date().toISOString();
  }));

  if (dead.length) db.subs = db.subs.filter((s) => !dead.includes(s.id));
  save();
  console.log(`[push] ${kind} "${title}" → ${targets.length}대 (만료 정리 ${dead.length})`);
  return log;
}

// ---------- 예약 발송 ----------
// 매일 schedule.time(KST)에 1회. 서버가 잠들어 있다 깨어난 경우를 위해 5분 창을 둠.
const CATCHUP_MIN = 5;
async function tick() {
  const now = kstNow();
  const sc = db.schedule;
  if (sc.enabled && sc.lastSentDate !== now.date) {
    const target = kstToDate(now.date, sc.time);
    const diffMin = (Date.now() - target.getTime()) / 60000;
    if (diffMin >= 0 && diffMin < CATCHUP_MIN) {
      sc.lastSentDate = now.date;
      save();
      await sendPush({ kind: 'scheduled', title: sc.title, body: sc.body, url: sc.url, scheduledFor: target.toISOString() });
    }
  }
  if (db.oneShot && Date.now() >= new Date(db.oneShot.at).getTime()) {
    const o = db.oneShot;
    db.oneShot = null;
    save();
    await sendPush({ kind: 'oneshot', title: o.title, body: o.body, url: o.url, scheduledFor: o.at });
  }
}
setInterval(() => tick().catch((e) => console.error('tick 오류', e)), 2 * 1000); // 2초마다 확인 → 정시 오차 최대 2초

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon',
};

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function isAdmin(req, url) {
  return (req.headers['x-admin-key'] || url.searchParams.get('key')) === ADMIN_KEY;
}
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    // 서비스 워커/HTML은 캐시하지 않아야 업데이트가 바로 반영됨
    if (/\.(html|js|webmanifest)$/.test(file)) headers['Cache-Control'] = 'no-cache';
    else headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const publicSub = (s) => ({
  id: s.id, label: s.label, platform: s.platform, browser: s.browser, standalone: s.standalone,
  createdAt: s.createdAt, lastStatus: s.lastStatus, lastStatusAt: s.lastStatusAt,
  pushService: (() => { try { return new URL(s.endpoint).host; } catch { return '?'; } })(),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    // ----- 공개 API -----
    if (p === '/api/config') return send(res, 200, { vapidPublicKey: VAPID_PUBLIC, serverTime: kstNow().text });

    if (p === '/api/subscribe' && req.method === 'POST') {
      const b = await readBody(req);
      const sub = b.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return send(res, 400, { error: '구독 정보가 없습니다' });
      let s = db.subs.find((x) => x.endpoint === sub.endpoint);
      if (!s) { s = { id: newId(), createdAt: new Date().toISOString() }; db.subs.push(s); }
      Object.assign(s, {
        endpoint: sub.endpoint, keys: sub.keys,
        label: String(b.label || '이름 없는 기기').slice(0, 40),
        platform: String(b.platform || '').slice(0, 30),
        browser: String(b.browser || '').slice(0, 30),
        standalone: !!b.standalone,
        updatedAt: new Date().toISOString(),
      });
      save();
      return send(res, 200, { ok: true, id: s.id });
    }

    if (p === '/api/unsubscribe' && req.method === 'POST') {
      const b = await readBody(req);
      db.subs = db.subs.filter((x) => x.endpoint !== b.endpoint);
      save();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.subs.find((x) => x.endpoint === b.endpoint);
      return send(res, 200, { registered: !!s, sub: s ? publicSub(s) : null });
    }

    // 서비스 워커가 알림을 받았을 때 / 눌렀을 때 보고 → 지연 시간 측정
    if (p === '/api/ack' && req.method === 'POST') {
      const b = await readBody(req);
      const log = db.logs.find((l) => l.id === b.id);
      const s = db.subs.find((x) => x.endpoint === b.endpoint);
      if (log) {
        const key = s ? s.id : 'unknown';
        log.acks[key] = log.acks[key] || {};
        const field = b.type === 'clicked' ? 'clickedAt' : 'receivedAt';
        if (!log.acks[key][field]) log.acks[key][field] = new Date().toISOString(); // 서버 시각 기준(기기 시계 오차 배제)
        save();
      }
      return send(res, 200, { ok: true });
    }

    // 본인 기기 셀프 테스트: N초 뒤 나에게만 발송 (그 사이 브라우저를 닫아볼 수 있음)
    if (p === '/api/self-test' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.subs.find((x) => x.endpoint === b.endpoint);
      if (!s) return send(res, 404, { error: '이 기기는 아직 구독 등록이 안 됐어요' });
      const delay = Math.max(0, Math.min(120, Number(b.delaySec) || 0));
      const at = new Date(Date.now() + delay * 1000).toISOString();
      setTimeout(() => {
        sendPush({ kind: 'self', title: '🔴 ON AIR (셀프 테스트)', body: `${s.label} 기기로 보낸 테스트 알림이에요.`, url: '/onair.html', targetIds: [s.id], scheduledFor: at })
          .catch((e) => console.error(e));
      }, delay * 1000);
      return send(res, 200, { ok: true, delaySec: delay });
    }

    // 외부 크론(cron-job.org 등)에서 매분/정시에 호출 → 잠든 서버 깨우기 + 예약 확인
    if (p === '/api/cron') {
      if (!isAdmin(req, url) && url.searchParams.get('key') !== process.env.CRON_KEY) return send(res, 401, { error: 'key' });
      await tick();
      return send(res, 200, { ok: true, kst: kstNow().text });
    }

    // ----- 관리자 API -----
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req, url)) return send(res, 401, { error: '관리자 키가 틀렸어요' });

      if (p === '/api/admin/state') {
        return send(res, 200, {
          kst: kstNow().text,
          subs: db.subs.map(publicSub),
          schedule: db.schedule,
          oneShot: db.oneShot,
          logs: db.logs.slice(0, 30),
        });
      }
      if (p === '/api/admin/send' && req.method === 'POST') {
        const b = await readBody(req);
        const log = await sendPush({
          kind: 'manual',
          title: b.title || '🔴 ON AIR',
          body: b.body || '방송이 시작됐어요!',
          url: b.url || '/onair.html',
          targetIds: Array.isArray(b.targetIds) && b.targetIds.length ? b.targetIds : null,
        });
        return send(res, 200, { ok: true, log });
      }
      if (p === '/api/admin/schedule' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.time && !/^\d{2}:\d{2}$/.test(b.time)) return send(res, 400, { error: '시간은 HH:MM 형식' });
        const sc = db.schedule;
        const timeChanged = b.time && b.time !== sc.time;
        Object.assign(sc, {
          enabled: b.enabled ?? sc.enabled,
          time: b.time || sc.time,
          title: b.title || sc.title,
          body: b.body || sc.body,
        });
        if (timeChanged || b.resetToday) sc.lastSentDate = null; // 오늘 다시 테스트할 수 있게
        save();
        return send(res, 200, { ok: true, schedule: sc });
      }
      if (p === '/api/admin/oneshot' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.cancel) { db.oneShot = null; save(); return send(res, 200, { ok: true }); }
        let at;
        if (b.minutes) at = new Date(Date.now() + Number(b.minutes) * 60000);
        else if (b.date && b.time) at = kstToDate(b.date, b.time);
        if (!at || isNaN(at)) return send(res, 400, { error: '시각을 확인해주세요' });
        at.setSeconds(0, 0); // 정각(초 0)에 맞춤 — 지연 측정이 쉬워짐
        if (b.minutes && at.getTime() < Date.now() + Number(b.minutes) * 60000 - 1000) at = new Date(at.getTime() + 60000);
        db.oneShot = { at: at.toISOString(), title: b.title || '🔴 ON AIR (예약 테스트)', body: b.body || '예약 발송 테스트예요.', url: '/onair.html' };
        save();
        return send(res, 200, { ok: true, oneShot: db.oneShot });
      }
      if (p === '/api/admin/remove' && req.method === 'POST') {
        const b = await readBody(req);
        db.subs = db.subs.filter((x) => x.id !== b.id);
        save();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/clear-logs' && req.method === 'POST') {
        db.logs = [];
        save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown admin api' });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'unknown api' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    return serveStatic(req, res, decodeURIComponent(p));
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n메리미 웹 푸시 테스트 서버: http://localhost:${PORT}`);
  console.log(`관리자 페이지: http://localhost:${PORT}/admin.html  (키: ADMIN_KEY)`);
  console.log(`현재 KST: ${kstNow().text} / 매일 예약: ${db.schedule.enabled ? db.schedule.time : '꺼짐'}\n`);
  tick().catch(() => {});
});
