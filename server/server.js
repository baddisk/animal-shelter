require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const dataPath = require('../lib/dataPath');
const { createAnimalSync, apiPhotoCount, filterAnimals, CRAWL_DELAY_MS } = require('../services/animalSync');
const { registerQrRoutes } = require('./qrRoutes');
const { shareFromCode, QrError } = require('../services/qrPhoto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// 이 저장소의 HTML·css/·js/는 public/이 아니라 프로젝트 루트에 있다.
const PUBLIC_DIR = path.join(__dirname, '..');
const COMMIT = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7);
const ASSET_V = `${pkg.version}-${COMMIT || Date.now().toString(36)}`;

// 아래의 고정 파일명만 받는다. 요청 경로를 파일명으로 넘기지 않는다.
function readVersionedTemplate(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replace(/__V__/g, ASSET_V);
}
const htmlCache = new Map();
function renderHtml(file) {
  if (!htmlCache.has(file)) htmlCache.set(file, readVersionedTemplate(file));
  return htmlCache.get(file);
}
const workerScript = readVersionedTemplate('sw.js');

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
// 원본 HTML 템플릿이 정적 파일로 먼저 나가지 않게 한다.
app.get(['/', '/index.html'], (req, res) => {
  const home = renderHtml('index.html');
  res.set('Cache-Control', 'no-cache').type('html').send(req.query.share === 'pending'
    ? home.replace('id="sharePending" hidden', 'id="sharePending"') : home);
});
app.get('/admin.html', (req, res) => {
  res.set('Cache-Control', 'no-store').type('html').send(renderHtml('admin.html'));
});
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ version: ASSET_V });
});
// 등록 URL은 고정하고, 워커의 내용과 캐시 이름은 배포마다 함께 갱신한다.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/javascript').send(workerScript);
});

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });
const BASE_URL = 'https://apis.data.go.kr/1543061/abandonmentPublicService_v2';

let cachedGanghwaParams = null;

// ==============================================================
// 📒 로컬 케어 데이터 레이어 (상태 오버레이 + 케어 로그)
//    보호소가 관리하는 임시보호·입양상담·입양확정 상태와 치료 이력은 별도이므로
//    보호소가 직접 입력한 데이터를 API 결과 위에 덧씌운다(overlay).
//    개체 매칭 키 = desertionNo (없으면 noticeNo)
// ==============================================================
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
function writeLocalDB() {
  const tmp=DB_PATH+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(db,null,2),{mode:0o600});
  fs.renameSync(tmp,DB_PATH);
}
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeLocalDB();
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
let mongoEventsColl = null, mongoDailyColl = null;
const dbReady = (async () => {
  if (!process.env.MONGODB_URI) return;
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const mdb = client.db(process.env.MONGODB_DB || 'shelter');
    mongoColl = mdb.collection('animals');
    mongoDailyColl = mdb.collection('events_daily');
    mongoEventsColl = mdb.collection('events'); // 📊 이용 집계(P1-1)
    const docs = await mongoColl.find({}).toArray();
    for (const d of docs) {
      const { _id, ...rest } = d;
      db.animals[String(_id)] = rest;
    }
    console.log(`☁️ MongoDB 연결 완료 (기록 ${docs.length}개체 로드)`);
  } catch (e) {
    console.error('⚠️ MongoDB 연결 실패 → 로컬 파일 모드로 동작합니다.');
    mongoColl = null;
    mongoEventsColl = null; mongoDailyColl = null;
  }
})();

// MongoDB를 쓰는 경우에만 부팅 시의 최초 케어 로딩을 공유한다. 목록 자체는 계속 RAM에서 읽는다.
// 스냅샷이 더 빨리 열려도 임시보호를 일반 보호로 표기하거나, 읽기 전 상태를 변경하지 않는다.
if (process.env.MONGODB_URI) app.use(['/api/animals','/api/admin/animals'], (_req,_res,next) => { dbReady.then(()=>next(),next); });

async function persistAnimal(key) {
  const rec = db.animals[key];
  try {
    if (mongoColl) {
      if (rec) {
        // QR 생성/자리 저장이 동시에 진행돼도 케어 저장이 그 두 필드를 되돌리지 않는다.
        const {qrMade,qrSlot,...care}=rec;
        await mongoColl.updateOne({ _id:key }, { $set:care }, { upsert:true });
      }
      else await mongoColl.deleteOne({ _id: key });
    } else {
      saveDB(); // 로컬 모드
    }
  } catch (e) {
    console.error('💾 저장 실패:', e.message);
  }
}

// QR은 다운로드 직전 저장 성공을 확인한다. 생성 시 qrSlot을 추정/초기화하지 않는다.
async function writeQrFields(key, fields) {
  try {
    if (mongoColl) {
      await mongoColl.updateOne({_id:key},{$set:fields,$setOnInsert:{status:null,statusUpdatedAt:null,logs:[]}},{upsert:true});
      Object.assign(getRec(key,true),fields);
    } else {
      const previous=getRec(key);
      db.animals[key]={...(previous || {status:null,statusUpdatedAt:null,logs:[]}),...fields};
      try { writeLocalDB(); }
      catch (err) { if(previous)db.animals[key]=previous;else delete db.animals[key]; throw err; }
    }
  } catch (_) { throw new QrError(503,'SAVE','QR 작업 기록을 저장하지 못했습니다. 저장소를 확인한 뒤 다시 시도해 주세요.'); }
}

// 보호중은 기존과 같은 null(오버레이 없음). adopting은 상담 단계로 표시한다.
// confirmed는 보호소의 확정 표시일 뿐, 국가 API의 종료(입양) 처리가 아니다.
const STATUS_CHANGES = new Map([
  [null,        { type: 'care',      title: '보호중으로 변경' }],
  ['foster',    { type: 'foster',    title: '임시보호 이동' }],
  ['adopting',  { type: 'adopting',  title: '입양상담 시작' }],
  ['confirmed', { type: 'confirmed', title: '입양확정' }]
]);
const VALID_LOG_TYPES = ['intake', 'medical', 'surgery', 'vaccine', 'care', 'foster', 'adopting', 'confirmed', 'note'];

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
    customStatus: rec?.status || null,          // null | 'foster' | 'adopting' | 'confirmed'
    statusUpdatedAt: rec?.statusUpdatedAt || null,
    logCount: logs.length,
    lastLog: last ? { date: last.date, type: last.type, title: last.title } : null,
    // 🔗 공유 주소 보조(P0-2/P1-3) — 화면에서 바로 쓸 수 있게 서버가 계산해 둔다
    shareId: shareIdOf(item),
    shortCode: shortCodeOf(shareIdOf(item))
  };
}

// ---- 관리자 인증 (간단 토큰 방식) ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // 운영 비밀번호가 없으면 로그인을 열지 않는다.
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
  if (!ADMIN_PASSWORD) return res.status(503).json({error:'서버에 관리자 비밀번호 설정이 필요합니다.'});
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
// 📊 T8 선행 기록은 읽기 전용, 신규 방문은 일별 합계만 기록한다.
// 이름·연락처·IP·원문 meta·방문 시각·방문자 식별자는 저장하지 않는다.
const {counter,createCounters} = require('../lib/anonymousStats');
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');
let eventsLocal = [];
try { const old = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8')); if(Array.isArray(old)) eventsLocal=old; } catch (_) {}
const dailyCounters = createCounters(path.join(DATA_DIR,'events-daily.json'),()=>mongoDailyColl);
process.once('exit', dailyCounters.flush);
app.post('/api/track', async (req, res) => {
  try {
    const r = counter(req.body, Date.now(), id => {
      if (typeof id !== 'string' && typeof id !== 'number') return null;
      const a=animalSync.findByShareId(String(id)); return a ? animalKeyOf(a) : null;
    });
    if (r) { await dbReady; await dailyCounters.add(r); }
  } catch (_) { console.warn('[통계] 익명 합계를 기록하지 못했습니다.'); }
  res.status(204).end();
});

// ==============================================================
// 📈 통계 집계 API (관리자 전용)
//    /api/track 으로 쌓인 이벤트를 관리자 화면이 바로 그릴 수 있는
//    형태(요약 KPI · 일별 추이 · 퍼널 · 개체 TOP)로 계산해 내려준다.
//    - 과거 events는 읽기만. 새 입력은 events_daily 또는 data/events-daily.json.
//    - 개인정보는 애초에 수집하지 않으므로 집계값만 오간다.
// ==============================================================
const STATS_MAX_DAYS = 365;
const STATS_CACHE_TTL = 60 * 1000; // 같은 조건 1분 캐시 (관리자 새로고침 연타 보호)
const statsCache = new Map();

// KST(UTC+9) 기준 날짜 문자열 — 보호소는 한국 시간으로 하루를 센다
function kstDateStr(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
// KST 기준 N일 전 00:00 의 UTC ISO 시각
function kstDayStartISO(daysAgo) {
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  nowKst.setUTCHours(0, 0, 0, 0);
  return new Date(nowKst.getTime() - daysAgo * 86400000 - 9 * 3600 * 1000).toISOString();
}

// 기간 내 이벤트 읽기 (저장소 무관 동일 인터페이스)
async function readEvents(fromISO) {
  await dbReady;
  const legacy = mongoEventsColl ? await mongoEventsColl.find({ts:{$gte:fromISO}})
    .project({_id:0, ts:1, event:1, id:1, meta:1}).limit(200000).toArray() : eventsLocal.filter(e=>String(e.ts)>=fromISO);
  // 과거 통계를 재기록하지 않는다. 기존 자료도 화면으로 임의 문자열을 내보내지 않는다.
  const bins = await dailyCounters.read(kstDateStr(fromISO));
  for (const e of legacy) {
    const r=counter(e,Date.parse(e.ts),id=>{
      const a=animalSync.findByShareId(String(id||''));
      return a?animalKeyOf(a):(/^\d{12,18}$/.test(String(id||''))?String(id):null);
    });
    if(r)bins.push(r);
  }
  return bins;
}

function emptyDay(date) {
  return {
    date,
    page_view: 0, detail_open: 0, link_open: 0, link_from_link: 0, link_from_list: 0,
    adopt_inquiry: 0, reserve_click: 0, share: 0, photo_swipe: 0, dwell_sec: 0
  };
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

async function buildStats(days) {
  const fromISO = kstDayStartISO(days - 1);
  const events = await readEvents(fromISO);

  // --- 날짜 뼈대 먼저 만들기 (이벤트가 0인 날도 그래프에 빈칸으로 보여야 한다) ---
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = kstDateStr(Date.now() - i * 86400000);
    daily.set(d, emptyDay(d));
  }

  const byEvent = {};
  const perAnimal = new Map();
  const filterUse = new Map();
  let dwellSum = 0, dwellCount = 0;

  const animalOf = (id) => {
    const key = String(id || '(미상)');
    if (!perAnimal.has(key)) {
      perAnimal.set(key, { id: key, detail_open: 0, adopt_inquiry: 0, share: 0, photo_swipe: 0, dwell_sec: 0, dwell_n: 0 });
    }
    return perAnimal.get(key);
  };

  for (const e of events) {
    const ev = String(e.event || '');
    const day = daily.get(e.day), n=e.count;
    if(!day || !Number.isSafeInteger(n) || n<1) continue;
    byEvent[ev] = (byEvent[ev] || 0) + n;
    const meta=e.meta||{};
    if (['page_view','detail_open','link_open','adopt_inquiry','reserve_click','photo_swipe'].includes(ev)) day[ev]+=n;
    if(ev==='link_open') day[meta.path==='link'?'link_from_link':'link_from_list']+=n;
    if(ev==='link_share'||ev==='link_copy') day.share+=n;
    if(ev==='dwell_time'){dwellSum+=e.secSum;dwellCount+=e.secN;day.dwell_sec+=e.secSum;}
    if(ev==='detail_close' && e.id && e.secN){const a=animalOf(e.id);a.dwell_sec+=e.secSum;a.dwell_n+=e.secN;}
    if(e.id && ['detail_open','adopt_inquiry','photo_swipe','link_share','link_copy'].includes(ev)){
      const a=animalOf(e.id); a[['link_share','link_copy'].includes(ev)?'share':ev]+=n;
    }
    if(ev==='filter_used')for(const [k,v] of Object.entries(meta)){const label=`${k}=${v}`;filterUse.set(label,(filterUse.get(label)||0)+n);}
  }

  const series = [...daily.values()];
  const totals = {
    page_view: byEvent.page_view || 0,
    detail_open: byEvent.detail_open || 0,
    link_open: byEvent.link_open || 0,
    photo_swipe: byEvent.photo_swipe || 0,
    adopt_inquiry: byEvent.adopt_inquiry || 0,
    reserve_click: byEvent.reserve_click || 0,
    share: (byEvent.link_share || 0) + (byEvent.link_copy || 0),
    filter_used: byEvent.filter_used || 0,
    events: Object.values(byEvent).reduce((sum,n)=>sum+n,0),
    animals_viewed: perAnimal.size,
    avg_dwell_sec: dwellCount ? Math.round((dwellSum / dwellCount) * 10) / 10 : 0,
    total_dwell_sec: Math.round(dwellSum)
  };

  // --- 유입 경로(링크 공유 vs 목록 탐색) ---
  const fromLink = series.reduce((s, d) => s + d.link_from_link, 0);
  const fromList = series.reduce((s, d) => s + d.link_from_list, 0);

  // --- 전환 퍼널: 상세 열람 → 사진 탐색 → 입양 문의 ---
  //   공유·복사는 한 열람에서 여러 번 일어날 수 있어(100% 초과) 단계가 아닌
  //   보조 지표로 따로 내려준다.
  const funnel = [
    { key: 'detail_open', label: '상세 열람', value: totals.detail_open },
    { key: 'photo_swipe', label: '사진 탐색', value: totals.photo_swipe },
    { key: 'adopt_inquiry', label: '입양 문의', value: totals.adopt_inquiry }
  ].map((s) => ({ ...s, rate: pct(s.value, totals.detail_open) }));
  const shareMetric = { label: '공유·복사', value: totals.share, per100: pct(totals.share, totals.detail_open) };

  // --- 개체 TOP: 이름·품종을 붙여 관리자가 바로 알아보게 한다 ---
  let lookup = new Map();
  try {
    const items = await getAllAnimals();
    for (const it of items) {
      const k = String(it.desertionNo || it.desertionNO || it.noticeNo || '').trim();
      if (k) lookup.set(k, it);
    }
  } catch (_) { /* 외부 API 실패해도 통계는 나와야 한다 */ }

  const topAnimals = [...perAnimal.values()]
    .sort((a, b) => b.detail_open - a.detail_open || b.adopt_inquiry - a.adopt_inquiry)
    .slice(0, 20)
    .map((a) => {
      const it = lookup.get(a.id);
      return {
        id: a.id,
        noticeNo: it?.noticeNo || null,
        kind: it ? kindTextOf(it) : null,
        thumb: it?.popfile1 || it?.popfile2 || null,
        customStatus: db.animals[a.id]?.status || null,
        detail_open: a.detail_open,
        adopt_inquiry: a.adopt_inquiry,
        share: a.share,
        photo_swipe: a.photo_swipe,
        avg_dwell_sec: a.dwell_n ? Math.round((a.dwell_sec / a.dwell_n) * 10) / 10 : 0,
        inquiry_rate: pct(a.adopt_inquiry, a.detail_open)
      };
    });

  // --- 관심을 못 받는 개체(노출 0~소수) — 홍보가 필요한 아이를 찾아준다 ---
  const coldAnimals = [...lookup.entries()]
    .map(([k, it]) => ({
      id: k,
      noticeNo: it.noticeNo || null,
      kind: kindTextOf(it),
      thumb: it.popfile1 || it.popfile2 || null,
      detail_open: perAnimal.get(k)?.detail_open || 0
    }))
    .sort((a, b) => a.detail_open - b.detail_open)
    .slice(0, 10);

  const topFilters = [...filterUse.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([label, count]) => ({ label, count }));

  return {
    range: { days, from: kstDateStr(fromISO), to: kstDateStr(Date.now()) },
    storage: mongoEventsColl ? 'mongodb' : 'file',
    generatedAt: new Date().toISOString(),
    totals,
    byEvent,
    series,
    funnel,
    shareMetric,
    source: { link: fromLink, list: fromList },
    topAnimals,
    coldAnimals,
    topFilters
  };
}

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), STATS_MAX_DAYS);
    const cacheKey = `d${days}`;
    const hit = statsCache.get(cacheKey);
    if (!(req.query.refresh === '1') && hit && Date.now() - hit.ts < STATS_CACHE_TTL) {
      return res.json({ ...hit.data, fromCache: true });
    }
    const data = await buildStats(days);
    statsCache.set(cacheKey, { ts: Date.now(), data });
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error('📈 통계 집계를 읽지 못했습니다.');
    res.status(500).json({ error: '통계를 읽지 못했습니다.' });
  }
});

// 일별 집계 CSV 내려받기 — 엑셀로 열어 보고서에 붙일 수 있게 (BOM 포함)
app.get('/api/admin/stats/export.csv', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), STATS_MAX_DAYS);
    const s = await buildStats(days);
    const head = '날짜,방문,상세열람,링크유입,목록유입,사진탐색,공유·복사,입양문의,예약클릭,체류시간(초)';
    const rows = s.series.map((d) => [
      d.date, d.page_view, d.detail_open, d.link_from_link, d.link_from_list,
      d.photo_swipe, d.share, d.adopt_inquiry, d.reserve_click, Math.round(d.dwell_sec)
    ].join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="carelink-stats-${s.range.from}_${s.range.to}.csv"`);
    res.send('\uFEFF' + [head, ...rows].join('\n') + '\n');
  } catch (e) {
    res.status(500).json({ error: '통계를 읽지 못했습니다.' });
  }
});

// ==============================================================
// 🔗 개체별 공유 페이지 /a/:id (P0-2 링크 미리보기)
//    카카오톡·문자 미리보기 로봇은 샵(#) 뒤를 읽지 못하므로 경로형 주소를
//    새로 연다. 기존 #detail/ 링크도 그대로 동작한다(호환 유지).
// ==============================================================
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

// 통계·사이트맵도 목록 캐시를 따로 만들거나 외부로 요청하지 않는다.
function getAllAnimals() { return animalSync.getSnapshot().items; }
async function lookupWithOneRetry(find) {
  const hit = find();
  if (hit) return hit;
  await animalSync.refreshForShareMiss(); // 동시에 놓친 QR은 새 목록 조회 한 번을 공유한다.
  return find();
}
function pendingShare(res) {
  return res.set('Cache-Control', 'no-store').redirect(302, '/?share=pending');
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
  const photoCount = apiPhotoCount(animal) + animalSync.getImages(animalKeyOf(animal)).length;
  const photoText = photoCount > 1 ? `사진 ${photoCount}장과 상세정보를 확인하세요` : '사진과 상세정보를 확인하세요';
  const desc = `${bits.join(' · ')} · ${photoText}`;

  // ⚠️ 미리보기 이미지는 반드시 우리 서버(프록시) 주소여야 한다 —
  //    원본 animal.go.kr 주소는 로봇이 못 읽는다. w=1000으로 가볍게.
  const uploaded = getRec(animalKeyOf(animal))?.qrSlot;
  // KAWIS의 물리적 자리 번호다. 원본 선택기의 중복 제거 후 번호와 혼동하지 않는다.
  const skip = uploaded===1 || uploaded===2 ? animal['popfile'+uploaded] : null;
  const skipKey = skip && (qrLocalSource(skip) || providerImageUrl(skip)) ? qrPhotoKey(skip) : null;
  const pop = qrPhotoUrls(animal).find(src=>!skipKey || qrPhotoKey(src)!==skipKey) || '';
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

app.get(['/a/:id', '/p/:id'], async (req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 80) return pendingShare(res);
  const animal = await lookupWithOneRetry(() => animalSync.findByShareId(id));
  if (!animal) return pendingShare(res);

  const shareId = shareIdOf(animal);
  // 공통 템플릿만 캐시한다. OG와 모달 시작 ID는 요청마다 별도로 넣는다.
  let html;
  try { html = renderHtml('index.html'); } catch (err) { return next(err); }
  await dbReady; // 부팅 직후에도 이미 KAWIS에 올린 QR 사진을 OG로 보내지 않는다.
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

// 사진에 인쇄한 짧은 주소. 조회/갱신은 기존 /a/ 경로에서만 한 번 수행한다.
app.get('/q/:code',(req,res)=>{
  const id=shareFromCode(req.params.code);
  if(!id)return pendingShare(res);
  return res.set('Cache-Control','no-cache').redirect(302,'/a/'+id);
});

// 짧은 공유 주소 /s/:코드 → /a/:공유아이디 로 넘긴다 (P1-3, 문자 요금 절약)
app.get('/s/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toLowerCase();
  if (!/^[0-9a-z]{3,12}$/.test(code)) return pendingShare(res);
  const hit = await lookupWithOneRetry(() => animalSync.findByShortCode(code));
  if (!hit) return pendingShare(res);
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
  if (!key) return res.status(400).json({ error: '개체 번호가 필요합니다.' });
  const status = req.body?.status; // 잘못된 입력이 기존 상태를 지우지 않도록 null만 해제로 인정
  const change = STATUS_CHANGES.get(status);
  if (!change) return res.status(400).json({ error: 'status는 null | foster | adopting | confirmed 이어야 합니다.' });
  const existing = getRec(key);
  if ((existing?.status ?? null) === status) {
    // 같은 상태 재저장은 역사/날짜를 바꾸거나 빈 DB 레코드를 만들지 않는다.
    return res.json({ ok: true, record: existing || { status: null, statusUpdatedAt: null, logs: [] } });
  }
  const rec = existing || getRec(key, true);
  rec.status = status;
  rec.statusUpdatedAt = status ? new Date().toISOString() : null;

  // 명시적으로 바뀐 단계만 한 줄 기록한다(보호중 복귀 포함). 과거 기록은 다시 쓰지 않는다.
  if (req.body.addLog !== false) {
    if (rec.logs == null) rec.logs = []; // 기록 배열이 없는 예전 상태 문서도 허용
    rec.logs.push({
      id: newId('l'),
      date: todayStr(),
      type: change.type,
      title: change.title,
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
const SITE_HEADERS = {
  'User-Agent': 'GanghwaShelterSite/1.0 (+https://ganghwa-shelter.onrender.com)',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept': 'text/html,image/*;q=0.8,*/*;q=0.5'
};
function providerImageUrl(raw) {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.port &&
      (u.hostname === 'animal.go.kr' || u.hostname.endsWith('.animal.go.kr') || u.hostname === 'apis.data.go.kr');
  } catch (_) { return false; }
}

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
    try { return decodeURIComponent(lastPart).toLowerCase(); } catch (_) { return lastPart.toLowerCase(); }
  }
  return u.toLowerCase();
}

function dedupeKeepOrder(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    const url = sanitizeUrl(raw);
    if (!providerImageUrl(url)) continue;

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
// 🖼️ 첫 방문과 예열은 같은 원본/리사이즈/단일 비행 경로를 사용한다.
// 디스크는 URL+폭마다 JPEG 하나. WebP를 받는 브라우저는 메모리 파생본을 사용한다.
// ==============================================================
let sharp = null;
try { sharp = require('sharp'); }
catch (_) { console.warn('[image] sharp 없음: 리사이즈 없이 원본을 제공합니다.'); }
const IMG_CACHE_DIR = dataPath('img-cache');
const ALLOWED_WIDTHS = new Set([160, 400, 800, 1000]);
const IMG_MEM_LIMIT = 128 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000, IMG_TTL = 7 * DAY_MS;
const imgMem = new Map(), imgInflight = new Map();
let imgMemBytes = 0;
function imgKey(url, w) { return crypto.createHash('sha1').update(`${url}|${w}`).digest('hex'); }
function imgDiskPath(key) { return path.join(IMG_CACHE_DIR, `${key}.jpg`); }
function forgetImage(key) { imgMemBytes -= imgMem.get(key).buf.length; imgMem.delete(key); }
function imageJob(key, build) {
  const hit = imgMem.get(key);
  if (hit && Date.now() - hit.savedAt < IMG_TTL) return Promise.resolve(hit);
  if (hit) forgetImage(key);
  if (imgInflight.has(key)) return imgInflight.get(key);
  const job = Promise.resolve().then(build).then(out => {
    if (out.buf.length <= IMG_MEM_LIMIT / 8) {
      imgMem.set(key, out); imgMemBytes += out.buf.length;
      while (imgMemBytes > IMG_MEM_LIMIT) forgetImage(imgMem.keys().next().value);
    }
    return out;
  }).finally(() => imgInflight.delete(key));
  imgInflight.set(key, job); return job;
}
async function imgDiskGet(key) {
  try {
    const file = imgDiskPath(key), st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs >= IMG_TTL) return null;
    const buf = await fs.promises.readFile(file);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    return { buf, type: 'image/jpeg', savedAt: st.mtimeMs };
  } catch (_) { return null; }
}
async function imgDiskPut(key, out) {
  // 포맷을 모르는 데이터를 .jpg라고 기록하지 않는다.
  if (out.skipDisk || out.type !== 'image/jpeg' || out.buf[0] !== 0xff || out.buf[1] !== 0xd8) return;
  const file = imgDiskPath(key), tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(IMG_CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, out.buf); await fs.promises.rename(tmp, file);
  } catch (_) { await fs.promises.unlink(tmp).catch(() => {}); } // 실패해도 사진은 제공
}
let sweeping = false;
async function sweepImageDisk() {
  if (sweeping) return;
  sweeping = true;
  try {
    const cutoff = Date.now() - IMG_TTL;
    for (const entry of await fs.promises.readdir(IMG_CACHE_DIR, {withFileTypes: true})) {
      if (!entry.isFile() || !/^[0-9a-f]{40}\.(?:jpg|jpeg|png|gif|webp|jpg\.\d+\.tmp)$/.test(entry.name)) continue;
      const file = path.join(IMG_CACHE_DIR, entry.name);
      try { if ((await fs.promises.stat(file)).mtimeMs < cutoff) await fs.promises.unlink(file); } catch (_) {}
    }
  } catch (_) { /* 빈 캐시/읽기 전용 디스크 */ } finally { sweeping = false; }
}
async function getOriginalImage(rawUrl) {
  const key = imgKey(rawUrl, 0);
  return imageJob(key, async () => {
    const disk = await imgDiskGet(key);
    if (disk) return disk;
    let orig = await fetchOriginalImage(rawUrl);
    if (!orig) throw new Error('IMAGE_NOT_FOUND');
    let cleanJPEG = false;
    if (sharp) {
      try { orig = { buf: await sharp(orig.buf).rotate().flatten({background:'#fff'}).jpeg({quality:90}).toBuffer(), type:'image/jpeg' }; cleanJPEG=true; }
      catch (_) { /* 해석 불가 원본은 실제 MIME 그대로 전송한다. */ }
    }
    const out = { ...orig, savedAt: Date.now(), skipDisk: !cleanJPEG };
    // 재인코딩으로 EXIF/GPS를 없앤 JPEG만 디스크에 저장한다.
    await imgDiskPut(key, out); return out;
  });
}

// 원본 이미지 다운로드 — 기존 후보 URL 로직을 그대로 재사용하고,
// Content-Type 에 붙어 오는 charset 같은 부착 정보는 뗀다(P2)
async function fetchOriginalImage(imageUrl) {
  for (const targetUrl of generateCandidateUrls(imageUrl).filter(providerImageUrl)) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxRedirects: 3,
        beforeRedirect(opts) {
          if (!providerImageUrl(`${opts.protocol}//${opts.hostname}${opts.port ? ':' + opts.port : ''}/`)) throw new Error('이미지 호스트 오류');
        },
        maxContentLength: 20 * 1024 * 1024,
        httpsAgent,
        httpAgent,
        headers: {
          ...SITE_HEADERS,
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
    } catch (err) {
      if ([401,403,429].includes(err.response?.status)) break; // 차단/속도 제한은 다른 후보로 재시도하지 않는다.
      continue;
    }
  }
  return null;
}

// 카드 예열과 프록시 모두 이 함수로 진입한다. 같은 폭을 동시에 처리하지 않는다.
async function getImageVariant(rawUrl, width, wantsWebp = false) {
  if (!providerImageUrl(rawUrl)) throw new Error('IMAGE_HOST');
  const w = ALLOWED_WIDTHS.has(width) ? width : 0, key = imgKey(rawUrl, w);
  const base = w === 0 ? await getOriginalImage(rawUrl) : await imageJob(key, async () => {
    const disk = await imgDiskGet(key);
    if (disk) return disk;
    const orig = await getOriginalImage(rawUrl);
    if (!sharp) return orig; // 원본을 '축소 성공'으로 디스크에 저장하지 않는다.
    let out = orig;
    try {
      const meta = await sharp(orig.buf).metadata();
      if (!meta.width) return orig;
      if (meta.width > w || orig.type !== 'image/jpeg') {
        const buf = await sharp(orig.buf).rotate().resize({width:w, withoutEnlargement:true})
          .flatten({background:'#fff'}).jpeg({quality:80, mozjpeg:true}).toBuffer();
        out = { buf, type:'image/jpeg', savedAt: Date.now() };
      }
    } catch (_) { return orig; }
    await imgDiskPut(key, out); return out;
  });
  if (sharp && w && wantsWebp && base.type === 'image/jpeg') {
    const webKey = key + '-webp';
    try {
      const web = await imageJob(webKey, async () => ({ buf: await sharp(base.buf).webp({quality:78}).toBuffer(),
        type:'image/webp', savedAt:base.savedAt }));
      return { ...web, etag:webKey };
    } catch (_) { /* JPEG 폴백 */ }
  }
  return { ...base, etag:key };
}

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  // 로컬 정적 이미지(데모 등)는 해당 파일로 바로 안내
  if (typeof imageUrl === 'string' && /^\/(?:img|uploads)\/[\w./%-]+$/.test(imageUrl)) return res.redirect(imageUrl);
  if (!providerImageUrl(imageUrl)) return res.status(400).send('동물 사진 주소가 아닙니다.');

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
// 🕷️ 공고 중 대상만 백그라운드에서 공개 상세 페이지를 읽는다.
// 주소나 파일 번호를 추측하지 않고 HTML에 명시된 사진만 사용한다.
// ==============================================================
async function fetchDetailHtml(desertionNo) {
  const detailRequest = url => axios.get(url, {
    params: {desertionNo, fileListCnt:50, pageSize:50}, timeout:8000, signal:AbortSignal.timeout(8000),
    maxRedirects:0, maxContentLength:3 * 1024 * 1024, httpsAgent, headers:SITE_HEADERS, responseType:'text'
  });
  let response;
  try { response = await detailRequest('https://www.animal.go.kr/front/awtis/public/publicDtl.do'); }
  catch (err) {
    // 기존 보호 상세 경로는 공개 공고 페이지가 없을 때만 사용한다. 차단·속도 제한은 재시도하지 않는다.
    if (![404,410].includes(err.response?.status)) throw err;
    await new Promise(resolve => setTimeout(resolve, CRAWL_DELAY_MS));
    response = await detailRequest('https://www.animal.go.kr/front/awtis/protection/protectionDtl.do');
  }
  const html = String(response.data || '');
  if (!/<(?:html|body|img)\b/i.test(html)) throw new Error('상세 페이지 없음');
  return decodeHtmlEntities(html);
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

// T8의 HTML 추출기를 사용하되, 페이지 전체에서 서로 다른 파일의 ID와 순번을 짝짓지 않는다.
// 실제 공개된 링크 또는 같은 다운로드 호출에 명시된 (파일 ID, 순번) 쌍만 수집한다.
async function crawlDetailImages(no) {
  if (DEMO) return MOCK_EXTRA_IMAGES[no] || [];
  const html = await fetchDetailHtml(no);
  const paths = extractShelterPathsFromHtml(html);
  const pairs = /\bfn_fileDownload\s*\(\s*["']?(\d{5,24})["']?\s*,\s*["']?(\d{1,3})["']?\s*[,)]/gi;
  for (const [,id,seq] of html.matchAll(pairs)) {
    paths.push(`https://www.animal.go.kr/query.do?pid=desertion_shelter&cmd=fileDownload&f_id=${id}&f_seq=${seq}`);
  }
  return dedupeKeepOrder(paths).slice(0,16);
}
app.get('/api/detail-images', (req, res) => {
  const no = String(req.query.desertionNo || '').trim();
  if (!no) return res.status(400).json({ error:'desertionNo 필요', images:[] });
  const images = animalSync.getImages(no); // refresh 무시. 크롤링·원본 예열도 하지 않는다.
  res.set('Cache-Control','no-store').json({images, count:images.length, fromCache:true, filenames:images.map(filenameOf)});
});

// ==============================================================
// 유기동물 목록 API
// ==============================================================
async function fetchGanghwaAnimalsFromApi(queryParams) {
  const ganghwaParams = await getGanghwaParams();
  const baseParams = { ...ganghwaParams, ...queryParams, numOfRows: '50' };
  async function fetchPage(pageNo) {
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await fetchOpenApi('abandonmentPublic_v2', {...baseParams, pageNo:String(pageNo)});
        const body = data?.response?.body;
        const code = data?.response?.header?.resultCode;
        if (!body || (code != null && !/^0+$/.test(String(code)))) throw new Error('API 오류');
        const count = Number(body.totalCount);
        if (body.totalCount == null || !Number.isSafeInteger(count) || count < 0) throw new Error('totalCount 누락');
        const row = body.items?.item;
        const rows = Array.isArray(row) ? row : row ? [row] : [];
        if (rows.length !== Math.min(50, Math.max(0, count - (pageNo - 1) * 50))) throw new Error('페이지 일부 누락');
        return { count, rows };
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  const first = await fetchPage(1), allItems = [...first.rows];
  // 20페이지 상한을 없애고 순서대로 받는다. 일부 페이지 실패 시 전체를 폐기한다.
  for (let p = 2; p <= Math.ceil(first.count / 50); p++) {
    const page = await fetchPage(p);
    if (page.count !== first.count) throw new Error('조회 중 전체 건수 변경');
    allItems.push(...page.rows);
  }
  if (new Set(allItems.map(animalKeyOf)).size !== first.count) throw new Error('페이지 간 중복/누락');

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

// 운영에서 키가 빠졌을 때 데모 데이터로 실제 스냅샷을 덮어쓰지 않는다.
const DEMO = !process.env.API_KEY && process.env.NODE_ENV !== 'production' && !process.env.RENDER;
const animalSync = createAnimalSync({
  snapshotFile:dataPath(DEMO ? 'animals-snapshot.demo.json' : 'animals-snapshot.json'),
  fetchAllAnimalsFromApi:q => DEMO ? filterAnimals(MOCK_ANIMALS, q) : fetchGanghwaAnimalsFromApi(q),
  crawlDetailImages, shareIdOf, shortCodeOf, getResizedImage:(url, w) => getImageVariant(url, w, true)
});
// 스냅샷이 가진 주소만 허용한다. 클라이언트가 외부 URL 또는 파일 경로를 지정할 수 없다.
function qrLocalSource(s) {
  return typeof s==='string' && /^\/(img|uploads)\/(?:[\w.-]+\/)*[\w.-]+\.(?:jpe?g|png|webp|avif|gif)$/i.test(s) && !s.split('/').some(p=>p==='.' || p==='..');
}
function qrPhotoKey(src) {
  if(qrLocalSource(src))return src;
  const u=new URL(sanitizeUrl(src));
  if(u.search && !/\/files\/shelter\//i.test(u.pathname) && !/[?&]f_(?:id|seq)=\d/i.test(u.search)){
    u.searchParams.sort();return u.href;
  }
  return filenameOf(src);
}
function qrPhotoUrls(a) {
  const raw=Array.from({length:8},(_,i)=>a['popfile'+(i+1)]);
  raw.push(...animalSync.getImages(animalKeyOf(a))); // 이미 수집된 T2 주소만, 여기서 크롤하지 않는다.
  const unique=new Map();
  for(const src of raw){
    if(!src || !(qrLocalSource(src) || providerImageUrl(src)))continue;
    const k=qrPhotoKey(src); if(k && !unique.has(k))unique.set(k,src);
  }
  return [...unique.values()];
}
function qrSourceKey(url){return imgKey(url,0).slice(0,16);}
async function qrOriginal(src) {
  if(providerImageUrl(src))return (await getOriginalImage(src)).buf; // 프록시의 폭 0 캐시·원본 함수, 400/1000 변형 아님
  if(!qrLocalSource(src))throw Error('invalid local photo');
  const dir=path.join(PUBLIC_DIR,src.split('/')[1]);
  const file=await fs.promises.realpath(path.join(PUBLIC_DIR,src));
  if(!file.startsWith(dir+path.sep))throw Error('invalid local photo');
  const st=await fs.promises.stat(file);if(!st.isFile() || st.size>20*1024*1024)throw Error('invalid size');
  return fs.promises.readFile(file);
}
registerQrRoutes({app,requireAdmin,dbReady,getRec,keyOf:animalKeyOf,writeFields:writeQrFields,original:qrOriginal,photos:qrPhotoUrls,sourceKey:qrSourceKey,
  today:()=>todayStr().replace(/-/g,''),
  items:async()=>{
    if(!getAllAnimals().length)await animalSync.refreshForRead();
    const items=getAllAnimals();if(!items.length)throw new QrError(503,'LIST','목록을 준비 중입니다. 잠시 후 다시 시도해 주세요.');
    return items;
  },
  adminItem:a=>{
    const rec=getRec(animalKeyOf(a));
    return {...enrichItem(a),qrMade:!!rec?.qrMade,qrSlot:rec?.qrSlot || null,
      qrPhotos:qrPhotoUrls(a).slice(0,8).map(src=>({v:qrSourceKey(src),thumb:qrLocalSource(src)?src:'/api/image-proxy?url='+encodeURIComponent(src)+'&w=160'}))};
  }
});
app.get('/api/animals', async (req, res, next) => {
  try {
    if (!getAllAnimals().length) await animalSync.refreshForRead();
    if (!getAllAnimals().length) return res.status(503).set('Cache-Control','no-store')
      .json({error:'목록을 준비하고 있습니다. 잠시 후 다시 확인해 주세요.', items:[], total:0});
    const items = filterAnimals(getAllAnimals(), req.query).map(enrichItem);
    res.set('Cache-Control','public, max-age=60').json({total:items.length, items, fromCache:true,
      syncedAt:animalSync.getStatus().syncedAt, ...(DEMO ? {mock:true} : {})});
  } catch (e) { next(e); }
});
app.get('/api/admin/sync', requireAdmin, (_req, res) => {
  res.set('Cache-Control','no-store').json(animalSync.getStatus());
});
app.post('/api/admin/sync', requireAdmin, async (_req, res) => {
  const ok = await animalSync.runSync();
  res.set('Cache-Control','no-store').status(ok ? 200 : 503).json({ok, ...animalSync.getStatus(),
    ...(!ok ? {error:'전체 목록을 받지 못해 기존 스냅샷을 유지했습니다.'} : {})});
});
// 기존 주소 호환: 공개 요청으로 스냅샷을 지우거나 외부 동기화를 유발하지 않는다.
app.post('/api/cache/clear', (_req, res) => res.json({ok:true, cleared:false}));

// HTML·공유 페이지·API·서비스워커 경로를 모두 처리한 뒤 정적 파일을 제공한다.
const staticOptions = {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(?:js|css|svg|png|jpe?g|webp|woff2?|ico|webmanifest)$/i.test(filePath)) {
      // 버전 없는 주소(예: JS에서 직접 쓰는 로고)나 지난 배포 주소는 재검증한다.
      res.set('Cache-Control', res.req.query.v === ASSET_V
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    }
  }
};
// 정적 루트가 저장소 자체이므로 공개 폴더와 자산만 마운트한다. services/lib/data는 비공개.
for (const dir of ['css','js','img','uploads']) {
  app.use('/'+dir, express.static(path.join(PUBLIC_DIR, dir), staticOptions));
}
app.get(['/logo.svg','/favicon.ico','/favicon.png','/apple-touch-icon.png','/icon-192.png',
  '/icon-512.png','/manifest.webmanifest'], express.static(PUBLIC_DIR, staticOptions));

animalSync.start(); // 디스크 목록을 먼저 읽고, API 동기화는 listen을 막지 않는다.
sweepImageDisk(); setInterval(sweepImageDisk, DAY_MS).unref();
const httpServer=app.listen(PORT, () => {
  console.log(`🐾 강화군 동물보호센터 서버 포트 ${PORT} 실행중`);
});

// Render 정상 종료 신호: 개인 이벤트가 아닌 누적 카운터를 마지막으로 반영한다.
process.once('SIGTERM', () => {
  dailyCounters.flush();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
});
