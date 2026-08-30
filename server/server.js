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
app.use(express.static(path.join(__dirname, '..')));

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });
const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

const animalCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10분
const detailImageCache = new Map();
const DETAIL_CACHE_TTL = 30 * 60 * 1000; // 30분
let cachedGanghwaParams = null;

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
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchOpenApi('abandonmentPublic_v2', { ...baseParams, pageNo: String(p) }));
    }
    const pagesResults = await Promise.allSettled(pagePromises);
    pagesResults.forEach((res) => {
      if (res.status === 'fulfilled' && res.value?.response?.body?.items?.item) {
        const items = res.value.response.body.items.item;
        allItems = allItems.concat(Array.isArray(items) ? items : [items]);
      }
    });
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

    const cacheKey = JSON.stringify(queryParams);
    const forceRefresh = refresh === '1' || refresh === 'true';
    if (forceRefresh) {
      animalCache.delete(cacheKey);
      detailImageCache.clear();
      console.log('🗑️ 캐시 초기화');
    }

    const cachedData = animalCache.get(cacheKey);
    if (!forceRefresh && cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
      return res.json({ total: cachedData.items.length, items: cachedData.items, fromCache: true });
    }

    const items = await fetchGanghwaAnimalsFromApi(queryParams);
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
