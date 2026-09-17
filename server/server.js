require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Render 등 리버스 프록시 뒤에서 req.protocol 등을 올바르게 잡기 위한 설정
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// data/·server/·빌드 파일·리포트는 정적 서빙에서 제외 (내부 자료 노출 방지)
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/data/') || p.startsWith('/server/')) return res.status(403).send('Forbidden');
  if (p === '/package.json' || p === '/package-lock.json' || p.toLowerCase().endsWith('.pdf')) {
    return res.status(403).send('Forbidden');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..')));

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });
const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

const animalCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10분
const detailImageCache = new Map();
const DETAIL_CACHE_TTL = 30 * 60 * 1000; // 30분
let cachedGanghwaParams = null;

// ==============================================================
// 📒 로컬 케어 데이터 레이어 (상태 오버레이 + 케어 로그)
//    국가 API에는 '임시보호중/입양진행중' 상태와 치료 이력이 없으므로
//    보호소가 직접 입력한 데이터를 API 결과 위에 덧씌운다(overlay).
//    개체 매칭 키 = desertionNo (없으면 noticeNo)
// ==============================================================
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { animals: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!db.animals || typeof db.animals !== 'object') db.animals = {};
} catch (_) { /* 최초 실행 시 파일 없음 */ }

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      console.error('💾 DB 저장 실패:', e.message);
    }
  }, 120);
}

// ==============================================================
// ☁️ MongoDB(Atlas) 영구 저장 어댑터
//    MONGODB_URI 환경변수가 있으면 MongoDB에 저장하고,
//    없으면 기존처럼 로컬 data/db.json 에 저장 (개발용)
// ==============================================================
let mongoColl = null;
let mongoEventsColl = null;
(async () => {
  if (!process.env.MONGODB_URI) return;
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const mdb = client.db(process.env.MONGODB_DB || 'shelter');
    mongoColl = mdb.collection('animals');
    mongoEventsColl = mdb.collection('events'); // 📊 이용 집계(P1-1)
    const docs = await mongoColl.find({}).toArray();
    for (const d of docs) {
      const { _id, ...rest } = d;
      db.animals[String(_id)] = rest;
    }
    console.log(`☁️ MongoDB 연결 완료 (기록 ${docs.length}개체 로드)`);
  } catch (e) {
    console.error('⚠️ MongoDB 연결 실패 → 로컬 파일 모드로 동작:', e.message);
    mongoColl = null;
    mongoEventsColl = null;
  }
})();

async function persistAnimal(key) {
  const rec = db.animals[key];
  try {
    if (mongoColl) {
      if (rec) await mongoColl.updateOne({ _id: key }, { $set: rec }, { upsert: true });
      else await mongoColl.deleteOne({ _id: key });
    } else {
      saveDB(); // 로컬 모드
    }
  } catch (e) {
    console.error('💾 저장 실패:', e.message);
  }
}

const VALID_STATUSES = ['foster', 'adopting'];
const VALID_LOG_TYPES = ['intake', 'medical', 'surgery', 'vaccine', 'care', 'foster', 'adopting', 'note'];

function animalKeyOf(item) {
  return String(item?.desertionNo || item?.desertionNO || item?.noticeNo || '').trim();
}
function getRec(key, create = false) {
  if (!key) return null;
  if (create && !db.animals[key]) db.animals[key] = { status: null, statusUpdatedAt: null, logs: [] };
  return db.animals[key] || null;
}
function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function todayStr() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function sortLogs(rec) {
  rec.logs.sort((a, b) =>
    String(b.date).localeCompare(String(a.date)) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
}
function sanitizeLogInput(body) {
  return {
    date: String(body?.date || '').replace(/\D/g, '').slice(0, 8),
    type: VALID_LOG_TYPES.includes(body?.type) ? body.type : 'note',
    title: String(body?.title || '').trim().slice(0, 120),
    content: String(body?.content || '').trim().slice(0, 2000)
  };
}
// API 개체에 로컬 정보 덧씌우기
function enrichItem(item) {
  const key = animalKeyOf(item);
  const rec = key ? db.animals[key] : null;
  const logs = rec?.logs || [];
  const last = logs[0];
  return {
    ...item,
    customStatus: rec?.status || null,          // 'foster' | 'adopting' | null
    statusUpdatedAt: rec?.statusUpdatedAt || null,
    logCount: logs.length,
    lastLog: last ? { date: last.date, type: last.type, title: last.title } : null,
    // 🔗 공유 주소 보조(P0-2/P1-3) — 화면에서 바로 쓸 수 있게 서버가 계산해 둔다
    shareId: shareIdOf(item),
    shortCode: shortCodeOf(shareIdOf(item))
  };
}

// ---- 관리자 인증 (간단 토큰 방식) ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shelter1234';
const adminSessions = new Set();
function tokenOf(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}
function requireAdmin(req, res, next) {
  const t = tokenOf(req);
  if (!t || !adminSessions.has(t)) return res.status(401).json({ error: '관리자 인증이 필요합니다.' });
  next();
}
app.post('/api/admin/login', (req, res) => {
  if (String(req.body?.password || '') !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  const token = newId('t_') + crypto.randomBytes(12).toString('hex');
  adminSessions.add(token);
  console.log('🔑 관리자 로그인 성공');
  res.json({ ok: true, token });
});
app.post('/api/admin/logout', (req, res) => {
  adminSessions.delete(tokenOf(req));
  res.json({ ok: true });
});

// ==============================================================
// 📊 이용 집계 (P1-1) — 개인정보는 일절 담지 않고 집계값만 남긴다
//    MONGODB_URI 가 있으면 events 컬렉션에, 없으면 data/events.json 에 저장.
//    화면은 sendBeacon 으로 보내므로 페이지를 닫아도 전송이 보장된다.
// ==============================================================
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');
const TRACK_EVENTS = new Set([
  'page_view', 'link_open', 'photo_swipe', 'dwell_time',
  'filter_used', 'adopt_inquiry', 'link_share', 'link_copy'
]);
let eventsLocal = [];
try { eventsLocal = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8') || '[]'); } catch (_) { /* 최초 실행 */ }

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta).slice(0, 12)) {
    const key = String(k).slice(0, 32);
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 120);
  }
  return out;
}

let eventsSaveTimer = null;
function persistEvent(rec) {
  if (mongoEventsColl) {
    mongoEventsColl.insertOne(rec).catch(() => {});
    return;
  }
  eventsLocal.push(rec);
  if (eventsLocal.length > 20000) eventsLocal.splice(0, eventsLocal.length - 20000);
  clearTimeout(eventsSaveTimer);
  eventsSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsLocal)); }
    catch (e) { console.error('📊 이벤트 저장 실패:', e.message); }
  }, 500);
}

app.post('/api/track', (req, res) => {
  try {
    const { event, id, meta } = req.body || {};
    if (TRACK_EVENTS.has(event)) {
      persistEvent({
        ts: new Date().toISOString(),
        event,
        id: String(id ?? '').slice(0, 64) || null,
        meta: sanitizeMeta(meta)
      });
    }
  } catch (_) { /* 집계 실패가 화면 동작에 영향 주지 않도록 */ }
  res.status(204).end();
});

// ==============================================================
// 🔗 개체별 공유 페이지 /a/:id (P0-2 링크 미리보기)
//    카카오톡·문자 미리보기 로봇은 샵(#) 뒤를 읽지 못하므로 경로형 주소를
//    새로 연다. 기존 #detail/ 링크도 그대로 동작한다(호환 유지).
// ==============================================================
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
let indexHtmlCache = { mtime: 0, html: null };
function getIndexHtml() {
  try {
    const st = fs.statSync(INDEX_PATH);
    if (indexHtmlCache.html && indexHtmlCache.mtime === st.mtimeMs) return indexHtmlCache.html;
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    indexHtmlCache = { mtime: st.mtimeMs, html };
    return html;
  } catch (_) {
    return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head><body><h1>index.html 을 찾을 수 없습니다.</h1></body></html>';
  }
}

// 메타 태그 속성값용 이스케이프 — 값에 따옴표가 있으면 태그가 깨진다
function escapeHtmlAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 화면(js/app.js getShareId)과 같은 규칙으로 공유 아이디를 뽑는다
function shareIdOf(item) {
  const raw = String(item?.noticeNo || item?.desertionNo || '');
  let id = raw.trim().replace(/[가-힣]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = id.match(/(\d{4}-\d+)/);
  return (m ? m[1] : id) || raw.trim();
}
function sameId(a, b) {
  a = String(a || '').trim().toLowerCase();
  b = String(b || '').trim().toLowerCase();
  return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a));
}
function animalMatchesId(item, id) {
  return sameId(shareIdOf(item), id)
    || sameId(String(item?.desertionNo || ''), id)
    || sameId(String(item?.noticeNo || ''), id);
}

// 문자 전송에 유리한 짧은 코드 (P1-3) — 결정적(deterministic)이라 별도 저장이 필요 없다
function shortCodeOf(id) {
  const h = crypto.createHash('sha256').update(String(id)).digest('hex');
  return BigInt('0x' + h.slice(0, 10)).toString(36).slice(0, 5).padStart(5, '0');
}

function absoluteOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function kindTextOf(item) {
  return String(item?.kindFullNm || item?.kindNm || item?.kindCd || '보호동물')
    .replace(/^\[(개|고양이|기타축종)\]\s*/, '$1 ');
}

// 보호중 개체 전체 (캐시 우선 — OG·사이트맵은 몇 분 뒤처져도 안전)
let allAnimalsFallback = { ts: 0, items: [] };
let allAnimalsFetching = null;
async function getAllAnimals() {
  const merged = [];
  for (const entry of animalCache.values()) merged.push(...entry.items);
  if (merged.length) return merged;
  if (!process.env.API_KEY) return MOCK_ANIMALS.map(enrichItem);
  if (Date.now() - allAnimalsFallback.ts < 60 * 1000 && allAnimalsFallback.items.length) {
    return allAnimalsFallback.items;
  }
  if (allAnimalsFetching) return allAnimalsFetching;
  allAnimalsFetching = (async () => {
    const items = await fetchGanghwaAnimalsFromApi({});
    allAnimalsFallback = { ts: Date.now(), items };
    return items;
  })().finally(() => { allAnimalsFetching = null; });
  return allAnimalsFetching;
}

async function findAnimalById(id) {
  const items = await getAllAnimals();
  return items.find((it) => animalMatchesId(it, id)) || null;
}

function ogTagsFor(req, animal) {
  const origin = absoluteOrigin(req);
  const shareId = shareIdOf(animal);
  const kind = kindTextOf(animal);
  const sex = animal.sexCd === 'M' ? '수컷' : animal.sexCd === 'F' ? '암컷' : '';
  const title = `${animal.colorCd ? animal.colorCd + ' ' : ''}${kind}${sex ? ' ' + sex : ''} · 가족을 기다려요`;

  const bits = [];
  if (animal.happenPlace) bits.push(`${animal.happenPlace} 구조`);
  if (animal.age) bits.push(animal.age);
  if (animal.weight) bits.push(String(animal.weight).replace(/\(Kg\)/i, 'kg'));
  const extraCached = detailImageCache.get(String(animal.desertionNo || ''));
  const photoCount = ['popfile1', 'popfile2', 'popfile3', 'popfile4']
    .filter((k) => animal[k]).length + (extraCached?.images?.length || 0);
  const photoText = photoCount > 1 ? `사진 ${photoCount}장과 상세정보를 확인하세요` : '사진과 상세정보를 확인하세요';
  const desc = `${bits.join(' · ')} · ${photoText}`;

  // ⚠️ 미리보기 이미지는 반드시 우리 서버(프록시) 주소여야 한다 —
  //    원본 animal.go.kr 주소는 로봇이 못 읽는다. w=1000으로 가볍게.
  const pop = animal.popfile1 || animal.popfile2 || '';
  const ogImage = !pop ? ''
    : String(pop).startsWith('/')
      ? `${origin}${pop}`
      : `${origin}/api/image-proxy?url=${encodeURIComponent(pop)}&w=1000`;

  const tags = [
    `<meta property="og:title" content="${escapeHtmlAttr(title)}">`,
    `<meta property="og:site_name" content="강화유기동물보호센터">`,
    `<meta property="og:url" content="${escapeHtmlAttr(`${origin}/a/${encodeURIComponent(shareId)}`)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="ko_KR">`,
    `<meta property="og:description" content="${escapeHtmlAttr(desc)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtmlAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeHtmlAttr(desc)}">`
  ];
  if (ogImage) {
    tags.push(
      `<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">`,
      `<meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}">`
    );
  }
  return tags.join('\n  ');
}

app.get(['/a/:id', '/p/:id'], async (req, res) => {
  const id = decodeURIComponent(String(req.params.id || '')).trim();
  let animal = null;
  try { animal = await findAnimalById(id); } catch (_) { /* 아래 404로 */ }

  if (!animal) {
    return res.status(404)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>페이지를 찾을 수 없습니다 | 강화유기동물보호센터</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#1E293B;"><h1>🐾</h1><p>찾으시는 개체 정보가 없습니다.<br>입소·공고가 종료되었을 수 있습니다.</p><p><a href="/" style="color:#FF6B35;font-weight:bold;">보호중인 아이들 보러가기 →</a></p></body></html>');
  }

  const shareId = shareIdOf(animal);
  let html = getIndexHtml();
  const tags = ogTagsFor(req, animal);
  // <!--OG--> 자리에 미리보기 메타 태그를, <!--BOOT--> 자리에 자동 열기 스크립트를 끼운다
  const boot = `<script>window.__CARELINK_BOOT__=${JSON.stringify(shareId).replace(/</g, '\\u003c')};</script>`;
  html = html.includes('<!--OG-->')
    ? html.replace('<!--OG-->', `  ${tags}`)
    : html.replace('</head>', `  ${tags}\n</head>`);
  html = html.includes('<!--BOOT-->')
    ? html.replace('<!--BOOT-->', `  ${boot}`)
    : html.replace('</body>', `  ${boot}\n</body>`);

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// 짧은 공유 주소 /s/:코드 → /a/:공유아이디 로 넘긴다 (P1-3, 문자 요금 절약)
app.get('/s/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[0-9a-z]{3,12}$/.test(code)) return res.status(404).send('Not Found');
  let hit = null;
  try {
    const items = await getAllAnimals();
    hit = items.find((it) => shortCodeOf(shareIdOf(it)) === code) || null;
  } catch (_) { /* 아래 404로 */ }
  if (!hit) return res.status(404).send('Not Found');
  res.set('Cache-Control', 'public, max-age=300');
  return res.redirect(302, `/a/${encodeURIComponent(shareIdOf(hit))}`);
});

// robots.txt — 관리 화면 차단 명시 + 사이트맵 연결 (P2)
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Disallow: /admin.html\n' +
    'Disallow: /admin.js\n' +
    'Disallow: /js/admin.js\n\n' +
    `Sitemap: ${absoluteOrigin(req)}/sitemap.xml\n`
  );
});

// sitemap.xml — 보호중 개체를 검색에 직접 노출 (P2, 입양 유입 경로)
app.get('/sitemap.xml', async (req, res) => {
  const origin = absoluteOrigin(req);
  const today = todayStr();
  const urls = [`  <url><loc>${origin}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`];
  try {
    const items = await getAllAnimals();
    for (const it of items.slice(0, 500)) {
      const d = String(it.statusUpdatedAt || it.happenDt || today);
      const lastmod = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10);
      urls.push(`  <url><loc>${origin}/a/${encodeURIComponent(shareIdOf(it))}</loc><lastmod>${lastmod}</lastmod></url>`);
    }
  } catch (_) { /* 목록 조회 실패 시 홈만이라도 */ }
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
  );
});

// ---- 공개: 개체 케어 로그 조회 ----
app.get('/api/animals/:key/logs', (req, res) => {
  const rec = getRec(String(req.params.key).trim());
  res.json({ status: rec?.status || null, logs: rec?.logs || [] });
});

// ---- 관리자: 상태 변경 ----
app.put('/api/admin/animals/:key/status', requireAdmin, async (req, res) => {
  const key = String(req.params.key).trim();
  const status = req.body?.status || null;
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status는 foster | adopting | null 이어야 합니다.' });
  }
  const rec = getRec(key, true);
  rec.status = status || null;
  rec.statusUpdatedAt = status ? new Date().toISOString() : null;

  // 상태 변경 시 타임라인에 남을 로그 자동 생성 (addLog=false로 끌 수 있음)
  if (status && req.body?.addLog !== false) {
    const label = status === 'foster' ? '임시보호 이동' : '입양 진행 시작';
    rec.logs.push({
      id: newId('l'),
      date: todayStr(),
      type: status,
      title: label,
      content: String(req.body?.note || '').trim().slice(0, 500),
      createdAt: new Date().toISOString()
    });
    sortLogs(rec);
  }
  await persistAnimal(key);
  res.json({ ok: true, record: rec });
});

// ---- 관리자: 로그 추가 / 수정 / 삭제 ----
app.post('/api/admin/animals/:key/logs', requireAdmin, async (req, res) => {
  const key = String(req.params.key).trim();
  const input = sanitizeLogInput(req.body);
  if (!input.date || !input.title) return res.status(400).json({ error: '날짜와 제목은 필수입니다.' });
  const rec = getRec(key, true);
  const entry = { id: newId('l'), ...input, createdAt: new Date().toISOString() };
  rec.logs.push(entry);
  sortLogs(rec);
  await persistAnimal(key);
  res.json({ ok: true, log: entry, logs: rec.logs });
});

app.put('/api/admin/animals/:key/logs/:logId', requireAdmin, async (req, res) => {
  const key = String(req.params.key).trim();
  const rec = getRec(key);
  const log = rec?.logs.find((l) => l.id === req.params.logId);
  if (!log) return res.status(404).json({ error: '로그를 찾을 수 없습니다.' });
  const input = sanitizeLogInput(req.body);
  if (!input.date || !input.title) return res.status(400).json({ error: '날짜와 제목은 필수입니다.' });
  Object.assign(log, input);
  sortLogs(rec);
  await persistAnimal(key);
  res.json({ ok: true, logs: rec.logs });
});

app.delete('/api/admin/animals/:key/logs/:logId', requireAdmin, async (req, res) => {
  const key = String(req.params.key).trim();
  const rec = getRec(key);
  if (!rec) return res.status(404).json({ error: '개체 기록이 없습니다.' });
  rec.logs = rec.logs.filter((l) => l.id !== req.params.logId);
  await persistAnimal(key);
  res.json({ ok: true, logs: rec.logs });
});

// ==============================================================
// 🧪 데모(목) 모드 — .env에 API_KEY가 없으면 샘플 데이터로 동작
//    실제 운영 시에는 API_KEY가 있으므로 이 블록은 동작하지 않음
// ==============================================================
const MOCK_CARE = {
  careNm: '강화군 동물보호센터',
  careAddr: '인천광역시 강화군 길상면',
  careTel: '032-930-3000',
  orgNm: '인천광역시 강화군',
  chargeNm: '강화군 동물보호센터',
  officetel: '032-930-3000'
};
const MOCK_ANIMALS = [
  {
    desertionNo: '2026081500012', noticeNo: '인천-강화-2026-00042',
    happenDt: '20260815', happenPlace: '강화군 길상면 논두렁',
    kindCd: '417000', kindFullNm: '[개] 믹스견', kindNm: '믹스견',
    colorCd: '갈색', age: '2025(추정)', weight: '8.5(Kg)',
    sexCd: 'M', neuterYn: 'Y',
    noticeSdt: '20260905', noticeEdt: '20260919', processState: '공고중',
    specialMark: '입소 시 귀 뒤 피부병으로 각질이 많았으나 치료 중 회복. 사람을 무척 좋아하고 산책을 좋아하는 순한 성격.',
    popfile1: '/img/mock_dog1.jpg', ...MOCK_CARE
  },
  {
    desertionNo: '2026072000011', noticeNo: '인천-강화-2026-00031',
    happenDt: '20260720', happenPlace: '강화군 화도면',
    kindCd: '417000', kindFullNm: '[개] 지독믹스', kindNm: '지독믹스',
    colorCd: '흰색', age: '2024(추정)', weight: '12.2(Kg)',
    sexCd: 'F', neuterYn: 'Y',
    noticeSdt: '20260722', noticeEdt: '20260805', processState: '보호중',
    specialMark: '순하고 사람을 잘 따름. 기초 교육(하우스, 리드줄) 완료.',
    popfile1: '/img/mock_dog2.jpg', ...MOCK_CARE
  },
  {
    desertionNo: '2026061000008', noticeNo: '인천-강화-2026-00025',
    happenDt: '20260610', happenPlace: '강화군 강화읍',
    kindCd: '422400', kindFullNm: '[고양이] 코리안숏헤어', kindNm: '코리안숏헤어',
    colorCd: '회색', age: '2026(추정)', weight: '3.1(Kg)',
    sexCd: 'M', neuterYn: 'Y',
    noticeSdt: '20260612', noticeEdt: '20260626', processState: '보호중',
    specialMark: '왼쪽 귀 끝 살짝 찢어짐(TNR 흔적 추정). 애교 많고 사람 손을 잘 잡음.',
    popfile1: '/img/mock_cat1.jpg', ...MOCK_CARE
  },
  {
    desertionNo: '2026082800004', noticeNo: '인천-강화-2026-00051',
    happenDt: '20260828', happenPlace: '강화군 송해면',
    kindCd: '422400', kindFullNm: '[고양이] 삼색이', kindNm: '삼색이',
    colorCd: '삼색', age: '2025(추정)', weight: '2.8(Kg)',
    sexCd: 'F', neuterYn: 'N',
    noticeSdt: '20260901', noticeEdt: '20260915', processState: '보호중',
    specialMark: '초기 사회화 진행 중. 아직 사람에게 경계가 조금 있음.',
    popfile1: '/img/mock_cat2.jpg', ...MOCK_CARE
  },
  {
    desertionNo: '2026090100003', noticeNo: '인천-강화-2026-00055',
    happenDt: '20260901', happenPlace: '강화군 양사면',
    kindCd: '417000', kindFullNm: '[개] 믹스견', kindNm: '믹스견',
    colorCd: '검정', age: '2026(추정)', weight: '4.2(Kg)',
    sexCd: 'M', neuterYn: 'N',
    noticeSdt: '20260908', noticeEdt: '20260922', processState: '공고중',
    specialMark: '추정 3개월 영역. 기생충 구충 완료, 예방접종 예정.',
    popfile1: '/img/mock_dog3.jpg', ...MOCK_CARE
  }
];
const MOCK_EXTRA_IMAGES = {
  '2026081500012': ['/img/mock_care1.jpg', '/img/mock_dog3.jpg']
};
function mockFilterItems(q = {}) {
  return MOCK_ANIMALS.filter((a) => {
    if (q.upkind === '417000' && !a.kindFullNm.startsWith('[개]')) return false;
    if (q.upkind === '422400' && !a.kindFullNm.startsWith('[고양이]')) return false;
    if (q.upkind === '429900' && !a.kindFullNm.startsWith('[기타축종]')) return false;
    const dt = String(a.happenDt);
    if (q.bgnde && dt < q.bgnde) return false;
    if (q.endde && dt > q.endde) return false;
    return true;
  });
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.animal.go.kr/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function sanitizeUrl(raw) {
  let url = decodeHtmlEntities(raw).trim().replace(/^["'\s(]+/, '').replace(/["'\s)]+$/, '');
  if (!url) return '';
  url = url.replace(/;jsessionid=[^?#]+/i, '');

  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = 'https://www.animal.go.kr' + url;
  else if (/^(files\/shelter|front\/fileMng|query\.do)/i.test(url)) url = 'https://www.animal.go.kr/' + url;

  url = url
    .replace(/https?:\/\/openapi\.animal\.go\.kr\/openapi\/service\/rest\/fileDownloadSrvc/gi, 'https://www.animal.go.kr')
    .replace(/http:\/\/www\.animal\.go\.kr/gi, 'https://www.animal.go.kr');

  return url.split('#')[0];
}

function filenameOf(url) {
  const u = sanitizeUrl(url);
  if (!u) return '';
  if (/f_seq=/i.test(u) || /f_id=/i.test(u)) {
    const id = (u.match(/f_id=(\d+)/i) || [])[1] || '';
    const seq = (u.match(/f_seq=(\d+)/i) || [])[1] || '';
    if (id || seq) return `fid${id}_seq${seq}`;
  }
  const lastPart = u.split('/').pop().split('?')[0];
  if (lastPart && lastPart.includes('.')) {
    return decodeURIComponent(lastPart).toLowerCase();
  }
  return u.toLowerCase();
}

function dedupeKeepOrder(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    const url = sanitizeUrl(raw);
    if (!url || !/^https?:\/\//i.test(url)) continue;

    const isShelterFile = /\/files\/shelter\//i.test(url);
    const isImageView = /\/front\/fileMng\/imageView\.do/i.test(url);
    const isDownload = /fileDownload/i.test(url) && /f_id=\d+/i.test(url);

    if (!isShelterFile && !isImageView && !isDownload) continue;
    if (/\/(?:logo|banner|common)\//i.test(url)) continue;

    const key = filenameOf(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

async function fetchOpenApi(endpoint, params = {}) {
  const serviceKey = process.env.API_KEY;
  if (!serviceKey) throw new Error('.env 파일에 API_KEY가 없습니다.');
  const queryParams = new URLSearchParams({
    serviceKey: decodeURIComponent(serviceKey),
    _type: 'json',
    ...params
  });
  const requestUrl = `${BASE_URL}/${endpoint}?${queryParams.toString()}`;
  const response = await axios.get(requestUrl, {
    timeout: 10000,
    httpsAgent,
    httpAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return response.data;
}

async function getGanghwaParams() {
  if (cachedGanghwaParams) return cachedGanghwaParams;
  try {
    const sigunguData = await fetchOpenApi('sigungu_v2', { upr_cd: '6280000' });
    const sItems = sigunguData?.response?.body?.items?.item || [];
    const sList = Array.isArray(sItems) ? sItems : [sItems];
    const ganghwa = sList.find((i) => (i.orgdownNm || '').includes('강화'));
    const orgCd = ganghwa ? ganghwa.orgCd : '3280000';
    const shelterData = await fetchOpenApi('shelter_v2', { upr_cd: '6280000', org_cd: orgCd });
    const shItems = shelterData?.response?.body?.items?.item || [];
    const shList = Array.isArray(shItems) ? shItems : [shItems];
    const shelter = shList.find((i) => (i.careNm || '').includes('강화')) || shList[0];
    cachedGanghwaParams = {
      upr_cd: '6280000',
      org_cd: orgCd,
      care_reg_no: shelter ? shelter.careRegNo : ''
    };
    console.log('✅ [캐시 완료] 강화군 코드 정보 등록 성공');
    return cachedGanghwaParams;
  } catch {
    return { upr_cd: '6280000', org_cd: '3280000' };
  }
}

function generateCandidateUrls(rawUrl) {
  const cleanUrl = String(rawUrl || '').trim();
  if (!cleanUrl) return [];
  const candidates = [];
  const abs = sanitizeUrl(cleanUrl);
  if (abs) candidates.push(abs);

  if (cleanUrl.includes('/files/shelter/')) {
    const filePath = cleanUrl.substring(cleanUrl.indexOf('/files/shelter/'));
    candidates.push(`https://www.animal.go.kr${filePath}`);
  }
  if (cleanUrl.includes('openapi.animal.go.kr')) {
    candidates.push(
      cleanUrl
        .replace(/openapi\.animal\.go\.kr/gi, 'www.animal.go.kr')
        .replace('/openapi/service/rest/fileDownloadSrvc', '')
        .replace('http://', 'https://')
    );
  }
  candidates.push(cleanUrl.replace('http://', 'https://'), cleanUrl);
  return [...new Set(candidates.filter(Boolean))];
}

// ==============================================================
// 🖼️ 이미지 축소·WebP 변환 + 2단 캐시 (P0-4)
//    원본(≈430KB)을 그대로 내보내지 않고 용도별 크기로 변환해 전송량을
//    8~12분의 1로 줄인다. 변환이 오히려 로딩을 늦추지 않도록:
//      1) 메모리 캐시 → 2) 디스크 캐시 → 3) (최초 1회만) 원본 다운로드+변환
//      - 동일 변환 요청이 동시에 몰려도 한 번만 처리(단일 비행)
//      - 원본이 목표 폭보다 작으면 재부호화하지 않고 그대로 전송
//      - sharp 이 없거나 변환에 실패하면 원본 그대로(기존 동작 보장)
//      - 첫 화면 카드 이미지는 백그라운드 예열(warmCardImages)
// ==============================================================
let sharp = null;
try { sharp = require('sharp'); }
catch (_) { console.warn('⚠️ sharp 없음 — 이미지 축소·WebP 변환을 생략하고 원본으로 응답합니다'); }

const IMG_CACHE_DIR = path.join(DATA_DIR, 'img-cache');
try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }); } catch (_) { /* 쓰기 불가 환경이면 메모리 캐시만 사용 */ }

const ALLOWED_WIDTHS = new Set([160, 400, 800, 1000]); // 썸네일 / 카드 / 카드(레티나) / 상세
const IMG_MEM_LIMIT = 128 * 1024 * 1024;               // 메모리 캐시 상한(바이트)
const IMG_DISK_MAX_FILES = 600;                        // 디스크 캐시 파일 수 상한
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const imgMem = new Map();        // key → { buf, type }
const imgInflight = new Map();   // key → Promise (동시 요청 합침)
let imgMemBytes = 0;

function imgKey(rawUrl, w, fmt) {
  return crypto.createHash('sha1').update(`${rawUrl}|${w}|${fmt}`).digest('hex');
}

function imgMemSet(key, buf, type) {
  if (buf.length > IMG_MEM_LIMIT / 8) return; // 지나치게 큰 항목은 메모리에 올리지 않음
  if (imgMem.has(key)) imgMemBytes -= imgMem.get(key).buf.length;
  imgMem.set(key, { buf, type });
  imgMemBytes += buf.length;
  while (imgMemBytes > IMG_MEM_LIMIT && imgMem.size > 1) {
    const oldest = imgMem.keys().next().value; // Map은 삽입 순서 유지 → 오래된 것부터 방출
    imgMemBytes -= imgMem.get(oldest).buf.length;
    imgMem.delete(oldest);
  }
}

function imgDiskPath(key, ext) { return path.join(IMG_CACHE_DIR, `${key}.${ext}`); }

async function imgDiskGet(key) {
  for (const ext of Object.keys(TYPE_OF_EXT)) {
    try {
      const buf = await fs.promises.readFile(imgDiskPath(key, ext));
      return { buf, type: TYPE_OF_EXT[ext] };
    } catch (_) { /* 다음 확장자 시도 */ }
  }
  return null;
}

let imgDiskSweepTimer = null;
function scheduleImgDiskSweep() {
  if (imgDiskSweepTimer) return;
  imgDiskSweepTimer = setTimeout(async () => {
    imgDiskSweepTimer = null;
    try {
      const files = await fs.promises.readdir(IMG_CACHE_DIR);
      if (files.length <= IMG_DISK_MAX_FILES) return;
      const stats = await Promise.all(files.map((f) =>
        fs.promises.stat(path.join(IMG_CACHE_DIR, f)).then((st) => ({ f, m: st.mtimeMs })).catch(() => null)
      ));
      const sorted = stats.filter(Boolean).sort((a, b) => a.m - b.m);
      const removeCount = sorted.length - Math.floor(IMG_DISK_MAX_FILES * 0.8);
      await Promise.all(sorted.slice(0, removeCount).map((x) =>
        fs.promises.unlink(path.join(IMG_CACHE_DIR, x.f)).catch(() => {})
      ));
    } catch (_) { /* 정리 실패는 무시 */ }
  }, 10000);
  if (imgDiskSweepTimer.unref) imgDiskSweepTimer.unref();
}

// 원본 이미지 다운로드 — 기존 후보 URL 로직을 그대로 재사용하고,
// Content-Type 에 붙어 오는 charset 같은 부착 정보는 뗀다(P2)
async function fetchOriginalImage(imageUrl) {
  for (const targetUrl of generateCandidateUrls(imageUrl)) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxRedirects: 7,
        httpsAgent,
        httpAgent,
        headers: {
          ...BROWSER_HEADERS,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        validateStatus: (s) => s >= 200 && s < 400
      });
      const buf = response.data;
      if (!buf || buf.length < 200) continue;

      let contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const b0 = buf[0];
      const b1 = buf[1];
      if (!contentType.startsWith('image/')) {
        if (b0 === 0xff && b1 === 0xd8) contentType = 'image/jpeg';
        else if (b0 === 0x89 && b1 === 0x50) contentType = 'image/png';
        else if (b0 === 0x47 && b1 === 0x49) contentType = 'image/gif';
        else continue;
      }
      return { buf: Buffer.from(buf), type: contentType };
    } catch {
      continue;
    }
  }
  return null;
}

// (원본URL, 가로폭, webp 여부) → { buf, type, etag }. 캐시 조회·단일 비행 포함.
async function getImageVariant(rawUrl, w, wantsWebp) {
  const canResize = !!(sharp && w && ALLOWED_WIDTHS.has(w));
  const fmt = canResize ? (wantsWebp ? 'webp' : 'jpeg') : 'orig';
  const key = imgKey(rawUrl, canResize ? w : 0, fmt);

  const mem = imgMem.get(key);
  if (mem) return { ...mem, etag: key };

  const running = imgInflight.get(key);
  if (running) return running;

  const job = (async () => {
    const disk = await imgDiskGet(key);
    if (disk) {
      imgMemSet(key, disk.buf, disk.type);
      return { ...disk, etag: key };
    }

    const orig = await fetchOriginalImage(rawUrl);
    if (!orig) throw new Error('IMAGE_NOT_FOUND');

    let out = orig;
    if (canResize && (orig.type === 'image/jpeg' || orig.type === 'image/png' || orig.type === 'image/webp')) {
      try {
        const meta = await sharp(orig.buf).metadata();
        if (meta.width && meta.width > w) {
          let pipeline = sharp(orig.buf).rotate(); // 휴대폰 사진 방향(EXIF) 자동 보정
          pipeline = pipeline.resize({ width: w, withoutEnlargement: true });
          const buf = wantsWebp
            ? await pipeline.webp({ quality: 78 }).toBuffer()
            : await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
          out = { buf, type: wantsWebp ? 'image/webp' : 'image/jpeg' };
        }
        // 원본이 목표 폭보다 작으면 재부호화하지 않고 그대로(품질·속도 보존)
      } catch (_) {
        out = orig; // 변환 실패 시 원본 폴백 — 이미지가 안 뜨는 상황을 만들지 않는다
      }
    }

    imgMemSet(key, out.buf, out.type);
    const ext = EXT_OF_TYPE[out.type];
    if (ext) {
      fs.promises.writeFile(imgDiskPath(key, ext), out.buf)
        .then(() => scheduleImgDiskSweep())
        .catch(() => { /* 디스크 캐시 실패는 응답에 지장 없음 */ });
    }
    return { ...out, etag: key };
  })().finally(() => imgInflight.delete(key));

  imgInflight.set(key, job);
  return job;
}

// 첫 화면 카드 이미지(w=400)를 백그라운드에서 미리 변환해 둔다.
// 이용자가 도착할 때쯤엔 캐시가 완성돼 있어 "변환 때문에 늦어지는" 첫 장면이 없다.
let lastImgWarmAt = 0;
function warmCardImages(items) {
  if (!sharp || !Array.isArray(items) || !items.length) return;
  if (Date.now() - lastImgWarmAt < 5 * 60 * 1000) return; // 5분 내 재예열 방지
  lastImgWarmAt = Date.now();
  const urls = items
    .slice(0, 12)
    .map((it) => String(it.popfile1 || ''))
    .filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) return;
  console.log(`🖼️ 카드 이미지 예열 시작 (${urls.length}장, w=400 webp)`);
  (async () => {
    for (let i = 0; i < urls.length; i += 3) { // 업스트림 동시 3개로 순한 예열
      await Promise.all(urls.slice(i, i + 3).map((u) => getImageVariant(u, 400, true).catch(() => {})));
    }
    console.log('🖼️ 카드 이미지 예열 완료');
  })();
}

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  // 로컬 정적 이미지(데모 등)는 해당 파일로 바로 안내
  if (typeof imageUrl === 'string' && imageUrl.startsWith('/')) return res.redirect(imageUrl);

  const w = parseInt(req.query.w, 10) || 0;
  const wantsWebp = /\bimage\/webp\b/i.test(String(req.headers.accept || ''));

  let variant;
  try {
    variant = await getImageVariant(String(imageUrl), w, wantsWebp);
  } catch {
    return res.status(404).send('Image Not Found');
  }

  res.set('Content-Type', variant.type); // 이미지엔 charset 을 붙이지 않는다(P2)
  // 1년 immutable — 브라우저·CDN(Cloudflare)이 저장해 재요청 자체를 없앤다
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Vary', 'Accept'); // webp 협상 결과가 Accept 헤더에 따라 다르므로
  res.set('ETag', `"${variant.etag}"`);
  return res.send(variant.buf);
});

// ==============================================================
// 🕷️ 크롤러 (GET/POST 다중 수집 및 f_id 자동 추적)
// ==============================================================
async function fetchDetailHtml(desertionNo) {
  const id = encodeURIComponent(String(desertionNo));
  const chunks = [];

  const gets = [
    `https://www.animal.go.kr/front/awtis/public/publicDtl.do?desertionNo=${id}&fileListCnt=50&pageSize=50`,
    `https://www.animal.go.kr/front/awtis/public/publicDtl.do?desertionNo=${id}`,
    `https://www.animal.go.kr/front/awtis/protection/protectionDtl.do?desertionNo=${id}`
  ];

  for (const url of gets) {
    try {
      const r = await axios.get(url, {
        timeout: 10000,
        httpsAgent,
        httpAgent,
        headers: BROWSER_HEADERS,
        responseType: 'text',
        decompress: true
      });
      if (r.data && String(r.data).length > 400) chunks.push(String(r.data));
    } catch (_) {}
  }

  try {
    const body = new URLSearchParams({
      desertionNo: String(desertionNo),
      fileListCnt: '50',
      pageSize: '50'
    });
    const r = await axios.post(
      'https://www.animal.go.kr/front/awtis/public/publicDtl.do',
      body.toString(),
      {
        timeout: 10000,
        httpsAgent,
        httpAgent,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        responseType: 'text'
      }
    );
    if (r.data && String(r.data).length > 400) chunks.push(String(r.data));
  } catch (_) {}

  return decodeHtmlEntities(chunks.join('\n'));
}

function extractShelterPathsFromHtml(html) {
  const found = [];
  const patterns = [
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*(?:files\/shelter|imageView\.do|fileDownload)[^"']*)["']/gi,
    /(?:src|data-src|data-original|data-lazy)\s*=\s*["']([^"']*(?:files\/shelter|imageView\.do|fileDownload)[^"']*)["']/gi,
    /(?:https?:\/\/(?:www\.)?animal\.go\.kr)?\/(?:files\/shelter\/[A-Za-z0-9_./-]+\.(?:jpe?g|png|gif|webp)|front\/fileMng\/imageView\.do[^\s"'<>]*)/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) found.push(m[1] || m[0]);
  }
  return dedupeKeepOrder(found);
}

function extractFIdAndSeqs(html) {
  let fId = null;
  const seqs = new Set();

  const patterns = [
    /f_id\s*=\s*["']?(\d+)/i,
    /fileId\s*=\s*["']?(\d+)/i,
    /atchFileId\s*=\s*["']?(\d+)/i,
    /fn_fileDownload\s*\(\s*["']?(\d+)/i,
    /f_id["']?\s*:\s*["']?(\d+)/i,
    /f_id=(\d+)/i,
    /f_id_(\d+)/i
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].length >= 5) {
      fId = m[1];
      break;
    }
  }

  const seqRe = /f_seq\s*=\s*["']?(\d+)/gi;
  let sm;
  while ((sm = seqRe.exec(html)) !== null) {
    seqs.add(Number(sm[1]));
  }

  return { fId, seqs: [...seqs].filter(n => n > 0 && n < 50) };
}

async function probeFileSequences(fId) {
  if (!fId) return [];
  const foundUrls = [];
  const seqList = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const tasks = seqList.map(async (seq) => {
    const downloadUrl = `https://www.animal.go.kr/query.do?pid=desertion_shelter&cmd=fileDownload&f_id=${fId}&f_seq=${seq}`;
    try {
      const response = await axios.get(downloadUrl, {
        timeout: 5000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        httpsAgent,
        httpAgent,
        headers: BROWSER_HEADERS,
        validateStatus: (s) => s >= 200 && s < 400
      });

      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || '';
      if (finalUrl && /\/files\/shelter\//i.test(finalUrl)) {
        return sanitizeUrl(finalUrl).split('?')[0];
      }

      const buf = response.data;
      if (buf && buf.length > 300) {
        const b0 = buf[0], b1 = buf[1];
        if ((b0 === 0xff && b1 === 0xd8) || (b0 === 0x89 && b1 === 0x50)) {
          return downloadUrl;
        }
      }
    } catch (_) {}
    return null;
  });

  const results = await Promise.all(tasks);
  results.forEach(u => { if (u) foundUrls.push(u); });
  return dedupeKeepOrder(foundUrls);
}

app.get('/api/detail-images', async (req, res) => {
  const desertionNo = String(req.query.desertionNo || '').trim();
  if (!desertionNo) return res.status(400).json({ error: 'desertionNo 필요', images: [], count: 0 });

  // 🧪 데모 모드
  if (!process.env.API_KEY) {
    const images = MOCK_EXTRA_IMAGES[desertionNo] || [];
    return res.json({ images, fromCache: true, count: images.length, filenames: images.map(filenameOf) });
  }

  if (req.query.refresh === '1' || req.query.refresh === 'true') {
    detailImageCache.delete(desertionNo);
  }

  const cached = detailImageCache.get(desertionNo);
  if (cached && Date.now() - cached.timestamp < DETAIL_CACHE_TTL) {
    return res.json({
      images: cached.images,
      fromCache: true,
      count: cached.images.length,
      filenames: cached.images.map(filenameOf)
    });
  }

  try {
    const html = await fetchDetailHtml(desertionNo);
    if (!html) return res.json({ images: [], error: '상세페이지 접근 실패', count: 0 });

    let fromHtml = extractShelterPathsFromHtml(html);
    const { fId } = extractFIdAndSeqs(html);

    let fromProbing = [];
    if (fId) {
      fromProbing = await probeFileSequences(fId);
    }

    const merged = dedupeKeepOrder([...fromHtml, ...fromProbing]).slice(0, 16);

    detailImageCache.set(desertionNo, { timestamp: Date.now(), images: merged });

    console.log(
      `🕷️ [크롤링] desertionNo=${desertionNo} → 총 ${merged.length}장 수집 성공 | ` +
      `f_id=${fId || '-'} | files=${merged.map(filenameOf).join(', ')}`
    );

    res.json({
      images: merged,
      fromCache: false,
      count: merged.length,
      filenames: merged.map(filenameOf)
    });
  } catch (error) {
    console.error(`❌ 크롤링 실패 (${desertionNo}):`, error.message);
    res.json({ images: [], error: error.message, count: 0 });
  }
});

// ==============================================================
// 유기동물 목록 API
// ==============================================================
async function fetchGanghwaAnimalsFromApi(queryParams) {
  const ganghwaParams = await getGanghwaParams();
  const baseParams = { ...ganghwaParams, ...queryParams, numOfRows: '50' };
  const firstPageData = await fetchOpenApi('abandonmentPublic_v2', { ...baseParams, pageNo: '1' });
  const body = firstPageData?.response?.body;
  if (!body?.items?.item) return [];

  const totalCount = parseInt(body.totalCount) || 0;
  let allItems = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
  const totalPages = Math.min(Math.ceil(totalCount / 50), 20);

  if (totalPages > 1) {
    // 페이지 하나가 실패해도 목록이 잘리지 않도록 재시도 3회
    const fetchPageWithRetry = async (pageNo) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await fetchOpenApi('abandonmentPublic_v2', { ...baseParams, pageNo: String(pageNo) });
        } catch (e) {
          console.warn(`⚠️ ${pageNo}페이지 조회 실패 (시도 ${attempt}/3):`, e.message);
          if (attempt === 3) return null;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    };
    const pagesResults = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPageWithRetry(i + 2))
    );
    pagesResults.forEach((data) => {
      if (data?.response?.body?.items?.item) {
        const items = data.response.body.items.item;
        allItems = allItems.concat(Array.isArray(items) ? items : [items]);
      }
    });
    if (allItems.length < totalCount) {
      console.warn(`⚠️ 전체 ${totalCount}건 중 ${allItems.length}건만 수집됨 — 일부 누락 가능. 잠시 후 새로고침 필요`);
    }
  }

  let filtered = allItems.filter((a) => {
    const careNm = a.careNm || '';
    const orgNm = a.orgNm || '';
    const happenPlace = a.happenPlace || '';
    return careNm.includes('강화') || orgNm.includes('강화') || happenPlace.includes('강화');
  });
  if (!filtered.length && allItems.length) filtered = allItems;

  filtered = filtered.filter((a) => {
    const state = String(a.processState || '');
    if (/(종료|입양|자연사|안락사|반환|기증)/.test(state)) return false;
    return /보호|공고/.test(state);
  });

  filtered.sort((a, b) =>
    String(b.happenDt || '').replace(/\D/g, '').localeCompare(String(a.happenDt || '').replace(/\D/g, ''))
  );
  return filtered;
}

app.get('/api/animals', async (req, res) => {
  try {
    const { bgnde, endde, upkind, refresh } = req.query;
    const queryParams = {};
    if (bgnde) queryParams.bgnde = String(bgnde).replace(/\D/g, '');
    if (endde) queryParams.endde = String(endde).replace(/\D/g, '');
    if (upkind) queryParams.upkind = upkind;

    // 날짜 미지정 시(관리자 페이지 등): 최근 3년 전체 조회로 기본값을 채워 누락 방지
    if (!queryParams.bgnde || !queryParams.endde) {
      const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const now = new Date();
      if (!queryParams.endde) queryParams.endde = ymd(now);
      if (!queryParams.bgnde) queryParams.bgnde = ymd(new Date(now.getFullYear() - 3, now.getMonth(), now.getDate()));
    }

    const cacheKey = JSON.stringify(queryParams);
    const forceRefresh = refresh === '1' || refresh === 'true';
    if (forceRefresh) {
      animalCache.delete(cacheKey);
      // ⚠️ detailImageCache(사진 크롤링 캐시)는 비우지 않는다 —
      //    목록 새로고침 한 번으로 전 개체가 재크롤링되면 이용자의 사진이
      //    늦어진다. 사진 캐시는 30분 TTL과 /api/detail-images?refresh=1 로만 갱신.
      console.log('🗑️ 목록 캐시 초기화');
    }

    // 🧪 데모 모드: API_KEY가 없으면 샘플 데이터 + 로컬 케어 데이터로 응답
    if (!process.env.API_KEY) {
      const mockItems = mockFilterItems(queryParams).map(enrichItem);
      console.log(`🧪 [데모] 보호중 ${mockItems.length}마리 (조회기간 ${queryParams.bgnde} ~ ${queryParams.endde})`);
      return res.json({ total: mockItems.length, items: mockItems, fromCache: false, mock: true });
    }

    const cachedData = animalCache.get(cacheKey);
    if (!forceRefresh && cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
      return res.json({ total: cachedData.items.length, items: cachedData.items.map(enrichItem), fromCache: true });
    }

    const items = (await fetchGanghwaAnimalsFromApi(queryParams)).map(enrichItem);
    animalCache.set(cacheKey, { timestamp: Date.now(), items });
    warmCardImages(items); // 새 목록이 오면 첫 화면 카드 사진도 미리 준비 (P0-4)
    console.log(`✨ [조회] 보호중 ${items.length}마리`);
    res.json({ total: items.length, items, fromCache: false });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: error.message, total: 0, items: [] });
  }
});

app.post('/api/cache/clear', (req, res) => {
  animalCache.clear();
  detailImageCache.clear();
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`🐾 강화군 동물보호센터 서버 포트 ${PORT} 실행중`);
  try {
    await getGanghwaParams();
    const items = await fetchGanghwaAnimalsFromApi({});
    animalCache.set(JSON.stringify({}), { timestamp: Date.now(), items });
    console.log(`🚀 예열 ${items.length}마리 완료`);
    warmCardImages(items); // 깨어난 직후 첫 화면 사진부터 백그라운드 준비 (P0-4)
  } catch (e) {}
});
