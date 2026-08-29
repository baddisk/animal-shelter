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
app.use(express.static(path.join(__dirname, '..')));

// SSL 인증서 무시 및 커넥션 재사용 에이전트
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

// ==============================================================
// ⚡ 캐시 시스템 (API 응답 10분, 코드 정보 영구)
// ==============================================================
const animalCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10분

let cachedGanghwaParams = null;

// 공통 API 요청 함수
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

// 🎯 강화군 코드 조회 (서버 실행 후 최초 1회만 실행 및 캐싱)
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
    console.log('✅ [캐시 완료] 강화군 코드 정보 등록 성공');
    return cachedGanghwaParams;
  } catch (e) {
    console.warn('⚠️ 강화군 코드 조회 실패, 기본값 사용');
    return { upr_cd: '6280000', org_cd: '3280000' };
  }
}

// ==============================================================
// 🎯 이미지 경로 후보 생성
// ==============================================================
function generateCandidateUrls(rawUrl) {
  const cleanUrl = rawUrl.trim();
  const candidates = [];

  if (cleanUrl.includes('/files/shelter/')) {
    const filePath = cleanUrl.substring(cleanUrl.indexOf('/files/shelter/'));
    candidates.push(`https://www.animal.go.kr${filePath}`);
    candidates.push(`http://www.animal.go.kr${filePath}`);
  }

  if (cleanUrl.includes('openapi.animal.go.kr')) {
    candidates.push(cleanUrl.replace('openapi.animal.go.kr', 'www.animal.go.kr').replace('http://', 'https://'));
  }

  candidates.push(cleanUrl.replace('http://', 'https://'));
  candidates.push(cleanUrl);

  return [...new Set(candidates)];
}

// ==============================================================
// 🖼️ 이미지 프록시 라우터
// ==============================================================
app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  const candidates = generateCandidateUrls(imageUrl);

  for (const targetUrl of candidates) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 4000,
        httpsAgent,
        httpAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://www.animal.go.kr/'
        }
      });

      if (response.status === 200 && response.data && response.data.length > 100) {
        const contentType = response.headers['content-type'] || 'image/jpeg';
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
// ⚡ 강화군 유기동물 데이터 병렬 수집 함수
// ==============================================================
async function fetchGanghwaAnimalsFromApi(queryParams) {
  const ganghwaParams = await getGanghwaParams();
  const baseParams = { ...ganghwaParams, ...queryParams, numOfRows: '50' };

  // 1페이지 호출하여 전체 개수 파악
  const firstPageData = await fetchOpenApi('abandonmentPublic_v2', { ...baseParams, pageNo: '1' });
  const body = firstPageData?.response?.body;
  if (!body || !body.items || !body.items.item) return [];

  const totalCount = parseInt(body.totalCount) || 0;
  let allItems = Array.isArray(body.items.item) ? body.items.item : [body.items.item];

  const totalPages = Math.min(Math.ceil(totalCount / 50), 20); // 최대 20페이지 안전 수집

  // 2페이지 이상은 병렬 호출
  if (totalPages > 1) {
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchOpenApi('abandonmentPublic_v2', { ...baseParams, pageNo: String(p) }));
    }

    const pagesResults = await Promise.allSettled(pagePromises);
    pagesResults.forEach(res => {
      if (res.status === 'fulfilled') {
        const items = res.value?.response?.body?.items?.item;
        if (items) {
          const list = Array.isArray(items) ? items : [items];
          allItems = allItems.concat(list);
        }
      }
    });
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

  // 최신순 정렬
  filtered.sort((a, b) => {
    const da = String(a.happenDt || '').replace(/[^0-9]/g, '');
    const db = String(b.happenDt || '').replace(/[^0-9]/g, '');
    return db.localeCompare(da);
  });

  return filtered;
}

// ==============================================================
// ⚡ 강화군 유기동물 조회 API
// ?refresh=1 : 캐시 삭제 후 공공서버에서 실시간 재조회
// ==============================================================
app.get('/api/animals', async (req, res) => {
  try {
    const { bgnde, endde, upkind, refresh } = req.query;

    const queryParams = {};
    if (bgnde) queryParams.bgnde = String(bgnde).replace(/[^0-9]/g, '');
    if (endde) queryParams.endde = String(endde).replace(/[^0-9]/g, '');
    if (upkind) queryParams.upkind = upkind;

    const cacheKey = JSON.stringify(queryParams);
    const forceRefresh = refresh === '1' || refresh === 'true';

    // 🔄 검색하기(refresh) 요청이면 해당 조건 캐시 삭제
    if (forceRefresh) {
      animalCache.delete(cacheKey);
      console.log('🗑️ [캐시 삭제] 검색하기 요청으로 캐시 초기화:', cacheKey);
    }

    const cachedData = animalCache.get(cacheKey);

    // 캐시 히트 (refresh 아닐 때만)
    if (!forceRefresh && cachedData && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
      console.log(`⚡ [캐시 적중] 메모리에서 즉시 반환 (${cachedData.items.length}마리)`);
      return res.json({
        total: cachedData.items.length,
        items: cachedData.items,
        fromCache: true
      });
    }

    console.log('🔄 [공공 API 요청] 최신 데이터를 공공서버에서 가져옵니다...', forceRefresh ? '(강제 새로고침)' : '');
    const filteredItems = await fetchGanghwaAnimalsFromApi(queryParams);

    animalCache.set(cacheKey, {
      timestamp: Date.now(),
      items: filteredItems
    });

    console.log(`✨ [조회 완료] 강화군 보호중: ${filteredItems.length}마리`);

    res.json({
      total: filteredItems.length,
      items: filteredItems,
      fromCache: false
    });

  } catch (error) {
    console.error('❌ 유기동물 조회 에러:', error.message);

    const { bgnde, endde, upkind } = req.query;
    const fallbackKey = JSON.stringify({
      ...(bgnde ? { bgnde: String(bgnde).replace(/[^0-9]/g, '') } : {}),
      ...(endde ? { endde: String(endde).replace(/[^0-9]/g, '') } : {}),
      ...(upkind ? { upkind } : {})
    });
    const cachedData = animalCache.get(fallbackKey);
    if (cachedData) {
      return res.json({
        total: cachedData.items.length,
        items: cachedData.items,
        fromCache: true,
        stale: true
      });
    }

    res.status(500).json({ error: error.message, total: 0, items: [] });
  }
});

// ==============================================================
// 🗑️ 캐시 전체 비우기 관리용 엔드포인트
// POST /api/cache/clear
// ==============================================================
app.post('/api/cache/clear', (req, res) => {
  const count = animalCache.size;
  animalCache.clear();
  console.log(`🗑️ [캐시 전체 삭제] 총 ${count}개 항목 삭제됨`);
  res.json({ ok: true, message: `${count}개의 캐시가 삭제되었습니다.` });
});

// ==============================================================
// 🚀 서버 시작 및 백그라운드 데이터 예열
// ==============================================================
app.listen(PORT, async () => {
  console.log('');
  console.log('🐾 =========================================');
  console.log(`🐾  강화군 동물보호센터 서버 실행 완료!`);
  console.log(`🐾  접속 주소: http://localhost:${PORT}`);
  console.log('🐾 =========================================\n');

  try {
    await getGanghwaParams();
    fetchGanghwaAnimalsFromApi({}).then(items => {
      animalCache.set(JSON.stringify({}), { timestamp: Date.now(), items });
      console.log(`🚀 [서버 예열 완료] 백그라운드 데이터 미리 로드 완료 (${items.length}마리)`);
    });
  } catch (e) {
    console.warn('예열 실패:', e.message);
  }
});
