'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dataPath = require('../lib/dataPath');

const SYNC_MS = 20 * 60_000;
const CRAWL_MIN_GAP_MS = 12 * 60 * 60_000;
const CRAWL_DELAY_MS = 1500;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const noOf = a => String(a?.desertionNo || a?.desertionNO || '').trim();
const date8 = s => String(s || '').replace(/[^0-9]/g, '').slice(0, 8);
const kstToday = ms => ymd(new Date(ms + 9 * 3600_000));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
function yearRange(ms = Date.now()) {
  const day = new Date(ms + 9 * 3600_000); // Render가 UTC여도 한국 달력 기준
  const from = new Date(day);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  if (from.getUTCMonth() !== day.getUTCMonth()) from.setUTCDate(0); // 2/29 → 작년 2/28
  return { bgnde: ymd(from), endde: ymd(day) };
}
function apiPhotoCount(a) {
  let n = 0;
  for (let i = 1; i <= 8; ++i) if (String(a['popfile' + i] || '').trim()) ++n;
  return n;
}
function needsCrawl(a, today = yearRange().endde) {
  const start = date8(a.noticeSdt), end = date8(a.noticeEdt);
  return !!noOf(a) && end.length === 8 && (start.length === 8 ? start <= today : /공고/.test(String(a.processState || ''))) && today <= end && apiPhotoCount(a) <= 2;
}

// 공개 화면에 쓰이는 동물/기관 필드만 보관. 원시 API 응답(담당자명·개인 연락처 등)은 저장하지 않는다.
const PUBLIC_FIELDS = ('desertionNo noticeNo happenDt happenPlace noticeSdt noticeEdt processState updTm ' +
  'upKindCd upKindNm kindCd kindNm kindFullNm age weight sexCd neuterYn colorCd specialMark ' +
  'careNm careAddr orgNm popfile').split(' ');
function publicItem(raw) {
  const a = { desertionNo: noOf(raw) };
  for (const k of PUBLIC_FIELDS) if (k !== 'desertionNo' && (typeof raw[k] === 'string' || typeof raw[k] === 'number')) a[k] = raw[k];
  for (let i = 1; i <= 8; i++) {
    const url = raw['popfile'+i] || raw['popFile'+i] || raw['POPFILE'+i];
    if (typeof url === 'string' && url.trim()) a['popfile'+i] = url.trim();
  }
  // 입양 문의에 쓰는 기관 대표 유선번호만. 개인 휴대전화·담당자 연락처는 제외.
  if (/^0(?:2|[3-6][1-5])[- .]?\d{3,4}[- .]?\d{4}$/.test(String(raw.careTel || '').trim())) a.careTel = String(raw.careTel).trim();
  return a;
}
// 디스크에는 동물 식별·분류·공고·사진 정보만 남긴다. 연락처와 자유기재 필드는 메모리 전용.
const DISK_FIELDS = ('desertionNo noticeNo happenDt noticeSdt noticeEdt processState updTm ' +
  'upKindCd upKindNm kindCd kindNm kindFullNm age weight sexCd neuterYn colorCd').split(' ');
function cachePhoto(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[<>"'\s\\]/.test(value)) return '';
  if (/^\/(img|uploads)\/[\w/.-]+$/i.test(value) && !value.includes('..')) return value;
  try {
    const u = new URL(value);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.port || u.hash ||
        !(u.hostname==='animal.go.kr'||u.hostname.endsWith('.animal.go.kr')||u.hostname==='apis.data.go.kr') ||
        /;|@|%40/i.test(u.pathname)) return '';
    for (const [k,v] of u.searchParams) {
      if ((k==='pid'&&v==='desertion_shelter') || (k==='cmd'&&v==='fileDownload')) continue;
      if (!/^(f_id|f_seq|fileNo|fileSn|fileId|atchFileId)$/i.test(k) || !/^\d{1,24}$/.test(v)) return '';
    }
    return value;
  } catch (_) {return '';}
}
function persistedItem(item) {
  const out={};
  for (const k of DISK_FIELDS) {
    const v=item[k];
    if (typeof v==='number' || (typeof v==='string' && v.length<=160 && !/[<>@\r\n]/.test(v) &&
        !/\b\d{1,3}(?:\.\d{1,3}){3}\b|(?:^|\D)0\d{1,2}[- ]\d{3,4}[- ]\d{4}(?:$|\D)/.test(v))) out[k]=v;
  }
  for (const k of ['popfile',...Array.from({length:8},(_,i)=>'popfile'+(i+1))]) {const u=cachePhoto(item[k]);if(u)out[k]=u;}
  return out;
}
// 화면의 getFilenameFromUrl과 같은 식별자. API 원본과 이미 저장된 추가 사진을 합칠 때만 사용한다.
function galleryKey(url) {
  if (/f_seq=|f_id=/i.test(url)) {
    const id = (url.match(/f_id=(\d+)/i) || [])[1] || '';
    const seq = (url.match(/f_seq=(\d+)/i) || [])[1] || '';
    return `fid${id}_seq${seq}`;
  }
  const leaf = url.split('/').pop().split('?')[0];
  try { return decodeURIComponent(leaf).toLowerCase(); } catch (_) { return leaf.toLowerCase(); }
}
function filterAnimals(items, q = {}) {
  const from = date8(q.bgnde), to = date8(q.endde), kind = String(q.upkind || '');
  return items.filter(a => {
    const day = date8(a.happenDt);
    if ((from && (!day || day < from)) || (to && (!day || day > to))) return false;
    if (!kind) return true;
    const label = String(a.upKindNm || a.kindFullNm || a.kindNm || '');
    const code = a.upKindCd || (['417000','422400','429900'].includes(String(a.kindCd)) ? a.kindCd :
      (/^(?:\[개\]|개$)/.test(label) ? '417000' : /고양이/.test(label) ? '422400' : '429900'));
    return String(code) === kind;
  });
}

function createAnimalSync({ fetchAllAnimalsFromApi, crawlDetailImages, getResizedImage, shareIdOf, shortCodeOf,
  snapshotFile = dataPath('animals-snapshot.json'), now = Date.now, wait = sleep }) {
  let snap = { items: [], extra: Object.create(null), syncedAt: null, crawlTargets: 0 };
  let diskItems = []; // 목록 갱신 때 한 번만 개인정보 제외 사본을 만들어 크롤링 중 재사용
  let flight = null, warming = null, timer = null, lastDemand = -Infinity, diskOK = true;
  let lastCrawlEnd = -Infinity;
  let byNo = new Map(), byShare = new Map(), byCode = new Map();
  function indexItems() {
    byNo = new Map(); byShare = new Map(); byCode = new Map();
    for (const a of snap.items) {
      if (noOf(a)) byNo.set(noOf(a), a);
      for (const key of [a.noticeNo, noOf(a), shareIdOf(a)]) if (key) byShare.set(String(key).trim().toLowerCase(), a);
      if (shortCodeOf) {const code=shortCodeOf(shareIdOf(a)); if(!byCode.has(code))byCode.set(code,a);}
    }
  }
  function prune(today) {
    const targets = snap.items.filter(a => needsCrawl(a, today));
    const keep = new Set(targets.map(noOf));
    for (const no of Object.keys(snap.extra)) if (!keep.has(no)) delete snap.extra[no];
    snap.crawlTargets = targets.length;
    return targets;
  }
  function loadFromDisk() {
    try {
      const c = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      if (!Array.isArray(c.items) || !c.items.length || !Number.isFinite(Date.parse(c.syncedAt))) return;
      const items = c.items.map(x=>persistedItem(publicItem(x)));
      if(items.some(a=>!noOf(a)&&!a.noticeNo))return;
      const extra = Object.create(null);
      for (const [no, rec] of Object.entries(c.extra || {})) {
        if (!rec || !Array.isArray(rec.images)) continue;
        const row={images:rec.images.map(cachePhoto).filter(Boolean)};
        for (const k of ['crawledAt','attemptedAt']) if (typeof rec[k]==='string' && Number.isFinite(Date.parse(rec[k]))) row[k]=new Date(rec[k]).toISOString();
        for (const k of ['updTm','attemptedUpdTm']) if (typeof rec[k]==='string' && rec[k].length<=64) row[k]=rec[k];
        extra[no]=row;
      }
      snap = { items, syncedAt: c.syncedAt, extra, crawlTargets: 0 };
      diskItems=items; indexItems(); prune(kstToday(now()));
    } catch (err) { if (err.code !== 'ENOENT') console.warn('[sync] 스냅샷을 읽지 못해 다시 동기화합니다.'); }
  }
  async function saveToDisk() {
    try {
      await fs.promises.mkdir(path.dirname(snapshotFile), { recursive: true });
      const tmp = snapshotFile + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify({...snap,items:diskItems}), {mode: 0o600});
      await fs.promises.rename(tmp, snapshotFile);
      diskOK = true;
    } catch (_) {
      if (diskOK) console.warn('[sync] 디스크에 쓸 수 없습니다. 메모리 목록은 유지합니다.');
      diskOK = false;
    }
  }
  function getStatus() {
    return { syncedAt: snap.syncedAt, crawlTargets: snap.crawlTargets, total: snap.items.length,
      running: !!flight, diskOK };
  }
  function getImages(no) {
    const a = byNo.get(String(no));
    return a && needsCrawl(a, kstToday(now())) ? (snap.extra[no]?.images || []) : [];
  }
  // 목록 응답과 독립된 기존 예열 작업 하나에서 두 단계를 순서대로 처리한다.
  async function prewarmThumbnails(list) {
    for (const a of list.slice(0, 24)) {
      const photo=Array.from({length:8}, (_,i)=>a['popfile'+(i+1)]).find(Boolean);
      if (!/^https?:\/\//i.test(photo || '')) continue; // 로컬 정적 파일은 프록시가 필요 없다.
      try { await getResizedImage(photo, 400); } catch (_) { /* 다음 사진 */ }
    }
    // 화면상 두 번째 사진을 선택한다. API 사진이 모자라면 이미 저장된 추가 주소만 읽는다.
    const seen = new Set();
    for (const a of list.slice(0, 8)) {
      const photos = Array.from({ length: 8 }, (_, i) => a['popfile' + (i + 1)])
        .filter(v => typeof v === 'string' && (/^https?:\/\//i.test(v) || v.startsWith('/')));
      if (photos.length < 2 && byNo.get(noOf(a)) === a) {
        const keys = new Set(photos.map(galleryKey));
        for (const extra of getImages(noOf(a))) { // 메모리 조회, 크롤러를 호출하지 않는다.
          const key = galleryKey(extra);
          if (!key || keys.has(key)) continue;
          keys.add(key); photos.push(extra);
          if (photos.length === 2) break;
        }
      }
      const [first, second] = photos;
      if (!second || second === first || !/^https?:\/\//i.test(second) || !cachePhoto(second) || seen.has(second)) continue;
      seen.add(second);
      // 기존 URL+폭 캐시/진행 중 요청을 그대로 재사용. 실패해도 다른 개체는 계속 진행.
      try { await getResizedImage(second, 160); } catch (_) { /* 다음 사진 */ }
    }
  }
  async function publishList() {
    const range = yearRange(now());
    const raw = await fetchAllAnimalsFromApi(range);
    if (!Array.isArray(raw) || !raw.length) throw new Error('empty');
    const unique = new Map();
    for (const row of raw) {
      if (!row || (!noOf(row) && !row.noticeNo)) throw new Error('incomplete');
      unique.set(noOf(row) || String(row.noticeNo), publicItem(row));
    }
    snap.items = [...unique.values()]; snap.syncedAt = new Date(now()).toISOString();
    diskItems=snap.items.map(persistedItem); indexItems(); prune(range.endde); await saveToDisk();
    if (!warming) warming = prewarmThumbnails(snap.items).finally(() => { warming = null; });
    return true;
  }
  async function crawlTargets(cycle) {
    for (const a of snap.items) {
      if (cycle.nextList) break; // 진행 중인 상세 1건만 끝내고 QR 목록 재확인을 우선한다.
      if (!needsCrawl(a, kstToday(now()))) continue;
      const no = noOf(a), prev = snap.extra[no], upd = String(a.updTm || '');
      const stamp = Date.parse(prev?.attemptedAt || prev?.crawledAt);
      if (prev && String(prev.attemptedUpdTm ?? prev.updTm ?? '') === upd && now() - stamp < CRAWL_MIN_GAP_MS) continue;
      const remaining = lastCrawlEnd + CRAWL_DELAY_MS - now();
      if (remaining > 0) await wait(remaining);
      if (cycle.nextList) break;
      if (!needsCrawl(a, kstToday(now()))) continue;
      const at = new Date(now()).toISOString();
      try {
        const images = await crawlDetailImages(no);
        if (!Array.isArray(images)) throw new Error('no response');
        snap.extra[no] = { images:images.map(cachePhoto).filter(Boolean), crawledAt: new Date(now()).toISOString(), updTm: upd };
      } catch (_) {
        // 이전에 성공한 사진은 보존. 장애 중에도 같은 개체를 매 20분마다 재시도하지 않는다.
        snap.extra[no] = { images: [], ...prev, attemptedAt: at, attemptedUpdTm: upd };
      }
      lastCrawlEnd = now();
      await saveToDisk(); // 재시작해도 이미 마친 개체를 다시 요청하지 않는다.
    }
    prune(kstToday(now())); await saveToDisk();
  }
  function publishSafely() {
    return Promise.resolve().then(publishList).catch(() => {
      console.warn('[sync] 전체 목록을 확보하지 못해 이전 스냅샷을 유지합니다.'); return false;
    });
  }
  // 목록·상세·스냅샷 쓰기는 한 작업에서 직렬화한다. 이미 목록을 공개한 뒤 들어온 QR은
  // 끝난 Promise를 재사용하지 않고 다음 목록 1회를 공유한다. 남은 전체 크롤링을 기다리지 않는다.
  async function drive(cycle) {
    try {
      let ok = await cycle.list;
      for (;;) {
        cycle.readingList = false;
        if (ok) await crawlTargets(cycle);
        const next = cycle.nextList;
        if (!next) return ok;
        cycle.nextList = null; cycle.readingList = true;
        cycle.list = publishSafely(); next.resolve(cycle.list);
        ok = await cycle.list;
      }
    } catch (_) { return false; }
    finally {
      if (cycle.nextList) cycle.nextList.resolve(false);
      flight = null;
    }
  }
  function runSync({ listOnly = false } = {}) {
    if (!flight) {
      const cycle = { list:publishSafely(), readingList:true, nextList:null, done:null };
      flight = cycle; cycle.done = drive(cycle);
    }
    return listOnly ? flight.list : flight.done;
  }
  function refreshForShareMiss() {
    if (!flight || flight.readingList) return runSync({listOnly:true});
    if (!flight.nextList) {
      let resolve; const promise = new Promise(r => { resolve=r; });
      flight.nextList = {promise, resolve};
    }
    return flight.nextList.promise;
  }
  function refreshForRead() {
    if (flight) return flight.list;
    // 빈 목록 상태의 연속 요청이 매번 외부 전체 조회를 유발하지 않게 묶는다. IP 저장 없음.
    if (now() - lastDemand < 30_000) return Promise.resolve(false);
    lastDemand = now(); return runSync({ listOnly: true });
  }
  function start() {
    if (timer) return;
    loadFromDisk(); runSync(); timer = setInterval(runSync, SYNC_MS); timer.unref();
  }
  return { start, runSync, refreshForRead, refreshForShareMiss, loadFromDisk, getSnapshot: () => snap, getStatus, getImages,
    findByShareId: id => byShare.get(String(id).trim().toLowerCase()) || null,
    findByShortCode: code => byCode.get(String(code).trim().toLowerCase()) || null };
}
module.exports = { createAnimalSync, needsCrawl, apiPhotoCount, yearRange, filterAnimals, CRAWL_DELAY_MS, cachePhoto, persistedItem };
