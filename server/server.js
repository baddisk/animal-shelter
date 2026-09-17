require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// data/ 폴더(db.json 등)는 정적 서빙에서 제외
app.use((req, res, next) => {
  if (req.path.startsWith('/data/')) return res.status(403).send('Forbidden');
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
(async () => {
  if (!process.env.MONGODB_URI) return;
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    mongoColl = client.db(process.env.MONGODB_DB || 'shelter').collection('animals');
    const docs = await mongoColl.find({}).toArray();
    for (const d of docs) {
      const { _id, ...rest } = d;
      db.animals[String(_id)] = rest;
    }
    console.log(`☁️ MongoDB 연결 완료 (기록 ${docs.length}개체 로드)`);
  } catch (e) {
    console.error('⚠️ MongoDB 연결 실패 → 로컬 파일 모드로 동작:', e.message);
    mongoColl = null;
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
    lastLog: last ? { date: last.date, type: last.type, title: last.title } : null
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

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

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

      let contentType = String(response.headers['content-type'] || '');
      const b0 = buf[0];
      const b1 = buf[1];
      if (!contentType.startsWith('image/')) {
        if (b0 === 0xff && b1 === 0xd8) contentType = 'image/jpeg';
        else if (b0 === 0x89 && b1 === 0x50) contentType = 'image/png';
        else if (b0 === 0x47 && b1 === 0x49) contentType = 'image/gif';
        else continue;
      }
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=604800');
      return res.send(Buffer.from(buf));
    } catch {
      continue;
    }
  }
  res.status(404).send('Image Not Found');
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
      detailImageCache.clear();
      console.log('🗑️ 캐시 초기화');
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
  } catch (e) {}
});
