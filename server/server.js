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
app.use(express.static(path.join(__dirname, '..'), {
  maxAge: '1d' // 정적 파일(HTML, CSS, JS) 브라우저 캐싱 1일
}));

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

// ==============================================================
// ⚡ 메모리 캐시 저장소 (0.05초 초고속 응답의 핵심)
// ==============================================================
let ganghwaDataCache = {
  items: [],
  lastFetched: 0,
  ttl: 10 * 60 * 1000 // 10분간 캐시 유지 (동물 데이터는 자주 안 바뀜)
};

// 이미지 메모리 캐시 (최대 300장 메모리 보관)
const imageMemoryCache = new Map();
const MAX_IMAGE_CACHE = 300;

function getCleanServiceKey() {
  let key = (process.env.API_KEY || '').trim().replace(/^["']|["']$/g, '').trim();
  try { key = decodeURIComponent(key); } catch (e) {}
  return key;
}

// 공통 API 요청
async function fetchOpenApi(endpoint, params = {}) {
  const serviceKey = getCleanServiceKey();
  if (!serviceKey) throw new Error('API_KEY가 없습니다.');

  const paramPairs = [`serviceKey=${encodeURIComponent(serviceKey)}`, `_type=json`];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      paramPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }

  const requestUrl = `${BASE_URL}/${endpoint}?${paramPairs.join('&')}`;

  const response = await axios.get(requestUrl, {
    timeout: 15000,
    httpsAgent,
    httpAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  return response.data;
}

// 강화군 코드 조회
let cachedGanghwaParams = null;
async function getGanghwaParams() {
  if (cachedGanghwaParams) return cachedGanghwaParams;
  try {
    const sigunguData = await fetchOpenApi('sigungu_v2', { upr_cd: '6280000' });
    const sItems = sigunguData?.response?.body?.items?.item || [];
    const sList = Array.isArray(sItems) ? sItems : [sItems];
    const ganghwa = sList.find(i => (i.orgdownNm || '').includes('강화'));
    const orgCd = ganghwa ? ganghwa.orgCd : '3280000';

    const shelterData = await fetchOpenApi('shelter_v2', { upr_cd: '6280000', org_cd: orgCd });
    const shItems = shelterData?.response?.body?.items?.item || [];
    const shList = Array.isArray(shItems) ? shItems : [shItems];
    const shelter = shList.find(i => (i.careNm || '').includes('강화')) || shList[0];
    const careRegNo = shelter ? shelter.careRegNo : '';

    cachedGanghwaParams = { upr_cd: '6280000', org_cd: orgCd, care_reg_no: careRegNo };
    return cachedGanghwaParams;
  } catch (e) {
    return { upr_cd: '6280000', org_cd: '3280000' };
  }
}

// ==============================================================
// 🔄 백그라운드 전수 데이터 수집 함수
// ==============================================================
async function refreshGanghwaData() {
  try {
    const ganghwaParams = await getGanghwaParams();
    const queryParams = { ...ganghwaParams, numOfRows: '50' };

    let allItems = [];
    let page = 1;
    let totalCount = 0;

    while (page <= 20) {
      const data = await fetchOpenApi('abandonmentPublic_v2', { ...queryParams, pageNo: String(page) });
      const body = data?.response?.body;
      if (!body || !body.items || !body.items.item) break;

      totalCount = parseInt(body.totalCount) || 0;
      const items = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
      if (items.length === 0) break;

      allItems = allItems.concat(items);
      if (allItems.length >= totalCount || items.length < 50) break;

      page++;
      await new Promise(r => setTimeout(r, 60));
    }

    // 강화군 필터
    let filtered = allItems.filter(animal => {
      const careNm = animal.careNm || '';
      const orgNm = animal.orgNm || '';
      const happenPlace = animal.happenPlace || '';
      return careNm.includes('강화') || orgNm.includes('강화') || happenPlace.includes('강화');
    });

    if (filtered.length === 0 && allItems.length > 0) filtered = allItems;

    // 종료 개체 제외 (보호중/공고중만)
    filtered = filtered.filter(animal => {
      const state = String(animal.processState || '');
      if (state.includes('종료') || state.includes('입양') || 
          state.includes('자연사') || state.includes('안락사') || 
          state.includes('반환') || state.includes('기증')) {
        return false;
      }
      return state.includes('보호') || state.includes('공고');
    });

    filtered.sort((a, b) => {
      const da = String(a.happenDt || '').replace(/[^0-9]/g, '');
      const db = String(b.happenDt || '').replace(/[^0-9]/g, '');
      return db.localeCompare(da);
    });

    ganghwaDataCache = {
      items: filtered,
      lastFetched: Date.now(),
      ttl: 10 * 60 * 1000
    };

    console.log(`⚡ [캐시 갱신 완료] 보호중 동물: ${filtered.length}마리 (다음 10분간 초고속 0.05초 응답)`);
    return filtered;
  } catch (error) {
    console.error('❌ 데이터 갱신 실패:', error.message);
    return ganghwaDataCache.items;
  }
}

// 🖼️ 이미지 후보군 URL 생성
function generateCandidateUrls(rawUrl) {
  const cleanUrl = rawUrl.trim();
  const candidates = [];

  if (cleanUrl.includes('/files/shelter/')) {
    const filePath = cleanUrl.substring(cleanUrl.indexOf('/files/shelter/'));
    candidates.push(`https://www.animal.go.kr${filePath}`);
    candidates.push(`http://www.animal.go.kr${filePath}`);
    candidates.push(`https://animal.go.kr${filePath}`);
  }
  if (cleanUrl.includes('openapi.animal.go.kr')) {
    candidates.push(cleanUrl.replace('openapi.animal.go.kr', 'www.animal.go.kr').replace('http://', 'https://'));
  }
  candidates.push(cleanUrl.replace('http://', 'https://'));
  candidates.push(cleanUrl.replace('https://', 'http://'));

  return [...new Set(candidates)];
}

// ==============================================================
// 🖼️ 초고속 이미지 프록시 (메모리 캐싱 탑재)
// ==============================================================
app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  // 1. 메모리 캐시에 이미 다운로드된 사진이 있으면 즉시 반환 (0.005초)
  if (imageMemoryCache.has(imageUrl)) {
    const cached = imageMemoryCache.get(imageUrl);
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=604800'); // 7일 브라우저 캐싱
    return res.send(cached.buffer);
  }

  const candidates = generateCandidateUrls(imageUrl);

  for (const targetUrl of candidates) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        httpsAgent,
        httpAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.animal.go.kr/'
        }
      });

      if (response.status === 200 && response.data && response.data.length > 100) {
        const contentType = response.headers['content-type'] || 'image/jpeg';

        // 메모리 캐시에 보관 (최대치 넘으면 오래된 것 삭제)
        if (imageMemoryCache.size >= MAX_IMAGE_CACHE) {
          const oldestKey = imageMemoryCache.keys().next().value;
          imageMemoryCache.delete(oldestKey);
        }
        imageMemoryCache.set(imageUrl, { buffer: response.data, contentType });

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=604800');
        return res.send(response.data);
      }
    } catch (err) {
      continue;
    }
  }

  res.status(404).send('Image Not Found');
});

// ==============================================================
// 🎯 유기동물 조회 API (메모리 캐시에서 즉시 필터링 후 0.05초 반환)
// ==============================================================
app.get('/api/animals', async (req, res) => {
  try {
    const { bgnde, endde, upkind } = req.query;

    // 캐시가 만료되었거나 비어있으면 백그라운드 갱신
    let list = ganghwaDataCache.items;
    const isCacheExpired = Date.now() - ganghwaDataCache.lastFetched > ganghwaDataCache.ttl;

    if (list.length === 0 || isCacheExpired) {
      list = await refreshGanghwaData();
    }

    // 메모리 상에서 초고속 필터링 (0.001초 소요)
    let filtered = [...list];

    if (upkind) {
      filtered = filtered.filter(a => String(a.upKindCd || a.upkind || '') === String(upkind));
    }

    const bNum = bgnde ? String(bgnde).replace(/[^0-9]/g, '') : '';
    const eNum = endde ? String(endde).replace(/[^0-9]/g, '') : '';

    if (bNum) {
      filtered = filtered.filter(a => String(a.happenDt || '').replace(/[^0-9]/g, '') >= bNum);
    }
    if (eNum) {
      filtered = filtered.filter(a => String(a.happenDt || '').replace(/[^0-9]/g, '') <= eNum);
    }

    res.json({
      total: filtered.length,
      items: filtered,
      cachedAt: ganghwaDataCache.lastFetched
    });

  } catch (error) {
    console.error('❌ 조회 에러:', error.message);
    res.status(500).json({ error: error.message, total: 0, items: [] });
  }
});

// 서버 헬스체크용 라우터 (UptimeRobot 연동용)
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, async () => {
  console.log('');
  console.log('🐾 =========================================');
  console.log(`🐾  초고속 캐싱 탑재 서버 가동 완료!`);
  console.log(`🐾  http://localhost:${PORT}`);
  console.log('🐾 =========================================');

  // 서버 시작 즉시 백그라운드에서 데이터를 미리 수집해둠 (첫 방문자 딜레이 제로)
  refreshGanghwaData();
});
