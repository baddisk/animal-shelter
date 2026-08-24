/* ==============================================================
   🐾 강화군 동물보호센터 – 서버 (완전 수정판)
   - 서버 시작 시 강화군 코드 1회 자동 조회 & 영구 캐싱
   - 0건 데이터 캐시 방지
   - numOfRows 100으로 API 호출 횟수 최소화 (초고속)
   - 이미지 프록시 병렬 시도 & 캐시
   - Express 5 호환 라우팅
   ============================================================== */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, '..')));

// SSL 인증서 무시 에이전트
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const httpAgent  = new http.Agent();

const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

// 강화군 기본 코드 (실제 인천 강화군 코드: 3570000)
let ganghwaParams = {
  upr_cd: '6280000',
  org_cd: '3570000',
  care_reg_no: ''
};

// 캐시
const dataCache  = new Map();
const imageCache = new Map();
const CACHE_TTL     = 10 * 60 * 1000; // 데이터 10분
const IMG_CACHE_TTL = 24 * 60 * 60 * 1000; // 이미지 24시간
const MAX_IMG_CACHE = 800;

// ==============================================================
// 공통 API 요청 함수
// ==============================================================
async function fetchOpenApi(endpoint, params = {}) {
  const serviceKey = process.env.API_KEY;
  if (!serviceKey) throw new Error('.env 파일에 API_KEY가 설정되지 않았습니다.');

  const qp = new URLSearchParams({
    serviceKey: decodeURIComponent(serviceKey),
    _type: 'json',
    ...params
  });

  const url = `${BASE_URL}/${endpoint}?${qp.toString()}`;

  const resp = await axios.get(url, {
    timeout: 15000,
    httpsAgent,
    httpAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  return resp.data;
}

// ==============================================================
// 🚀 서버 시작 시 강화군 코드 1회 자동 감지 (이후 0초 소요)
// ==============================================================
async function initGanghwaCodes() {
  try {
    console.log('🔍 [초기화] 강화군 기관/보호소 코드 확인 중...');
    
    // 1. 시군구 조회
    const sigunguData = await fetchOpenApi('sigungu_v2', { upr_cd: '6280000' });
    const sItems = sigunguData?.response?.body?.items?.item || [];
    const sList = Array.isArray(sItems) ? sItems : [sItems];
    const ganghwa = sList.find(i => (i.orgdownNm || '').includes('강화'));
    
    if (ganghwa && ganghwa.orgCd) {
      ganghwaParams.org_cd = ganghwa.orgCd;
    }

    // 2. 보호소 조회
    const shelterData = await fetchOpenApi('shelter_v2', { upr_cd: '6280000', org_cd: ganghwaParams.org_cd });
    const shItems = shelterData?.response?.body?.items?.item || [];
    const shList = Array.isArray(shItems) ? shItems : [shItems];
    const shelter = shList.find(i => (i.careNm || '').includes('강화'));
    
    if (shelter && shelter.careRegNo) {
      ganghwaParams.care_reg_no = shelter.careRegNo;
      console.log(`✅ [초기화 완료] 강화군 코드 감지 성공: 시군구(${ganghwaParams.org_cd}), 보호소(${shelter.careNm})`);
    } else {
      console.log(`✅ [초기화 완료] 강화군 시군구(${ganghwaParams.org_cd})로 전체 조회 설정`);
    }
  } catch (err) {
    console.warn(`⚠️ [초기화 안내] 코드 자동조회 실패, 기본값(인천:6280000, 강화:3570000) 사용:`, err.message);
  }
}

// ==============================================================
// 유기동물 데이터 수집 (100개씩 대량 호출)
// ==============================================================
async function fetchAllAnimals(queryParams) {
  let allItems = [];

  // 1페이지 호출 (100마리 단위)
  const first = await fetchOpenApi('abandonmentPublic_v2', {
    ...queryParams,
    pageNo: '1',
    numOfRows: '100'
  });

  const body = first?.response?.body;
  if (!body || !body.items || !body.items.item) {
    // 만약 care_reg_no나 org_cd 때문에 0건이면, 인천 전체에서 검색 시도
    if (queryParams.org_cd) {
      console.log('🔄 강화군 필터 없이 인천 전체에서 강화군 개체 재검색 중...');
      const fallback = await fetchOpenApi('abandonmentPublic_v2', {
        upr_cd: '6280000',
        bgnde: queryParams.bgnde,
        endde: queryParams.endde,
        upkind: queryParams.upkind,
        pageNo: '1',
        numOfRows: '100'
      });
      const fbBody = fallback?.response?.body;
      const fbItems = fbBody?.items?.item;
      if (fbItems) {
        return Array.isArray(fbItems) ? fbItems : [fbItems];
      }
    }
    return [];
  }

  const totalCount = parseInt(body.totalCount) || 0;
  const firstItems = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
  allItems = [...firstItems];

  // 100마리 초과 시 나머지 페이지 병렬 호출
  if (totalCount > 100) {
    const totalPages = Math.min(Math.ceil(totalCount / 100), 10);
    const promises = [];

    for (let p = 2; p <= totalPages; p++) {
      promises.push(
        fetchOpenApi('abandonmentPublic_v2', {
          ...queryParams,
          pageNo: String(p),
          numOfRows: '100'
        }).catch(() => null)
      );
    }

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const items = r.value?.response?.body?.items?.item;
        if (items) {
          allItems = allItems.concat(Array.isArray(items) ? items : [items]);
        }
      }
    }
  }

  return allItems;
}

// ==============================================================
// 강화군 및 보호/공고중 필터링
// ==============================================================
function filterGanghwa(items) {
  // 1. 강화군 관련 필터
  let filtered = items.filter(a => {
    const c = a.careNm || '';
    const o = a.orgNm || '';
    const h = a.happenPlace || '';
    return c.includes('강화') || o.includes('강화') || h.includes('강화');
  });

  // 필터 후 0개인데 원본이 있다면 원본 유지
  if (filtered.length === 0 && items.length > 0) filtered = items;

  // 2. 안락사/자연사/입양완료 등 종료 개체 제외 (보호중, 공고중만)
  filtered = filtered.filter(a => {
    const st = String(a.processState || '');
    if (st.includes('종료') || st.includes('입양') || st.includes('자연사') ||
        st.includes('안락사') || st.includes('반환') || st.includes('기증')) return false;
    return st.includes('보호') || st.includes('공고');
  });

  // 3. 최신 발생일순 정렬
  filtered.sort((a, b) => {
    const da = String(a.happenDt || '').replace(/\D/g, '');
    const db = String(b.happenDt || '').replace(/\D/g, '');
    return db.localeCompare(da);
  });

  return filtered;
}

// ==============================================================
// 🎯 동물 목록 조회 API
// ==============================================================
app.get('/api/animals', async (req, res) => {
  try {
    const { bgnde, endde, upkind } = req.query;
    const cacheKey = `${bgnde || ''}_${endde || ''}_${upkind || ''}`;

    // 캐시 확인
    if (dataCache.has(cacheKey)) {
      const cached = dataCache.get(cacheKey);
      if (Date.now() - cached.ts < CACHE_TTL && cached.items.length > 0) {
        console.log(`⚡ 캐시 히트! ${cached.items.length}마리 즉시 응답`);
        return res.json({ total: cached.items.length, items: cached.items });
      }
      dataCache.delete(cacheKey);
    }

    const queryParams = {
      upr_cd: ganghwaParams.upr_cd,
      org_cd: ganghwaParams.org_cd
    };
    if (ganghwaParams.care_reg_no) queryParams.care_reg_no = ganghwaParams.care_reg_no;
    if (bgnde)  queryParams.bgnde = String(bgnde).replace(/\D/g, '');
    if (endde)  queryParams.endde = String(endde).replace(/\D/g, '');
    if (upkind) queryParams.upkind = upkind;

    const allItems = await fetchAllAnimals(queryParams);
    const filtered = filterGanghwa(allItems);

    // 💡 0마리가 아닐 때만 캐시에 저장
    if (filtered.length > 0) {
      dataCache.set(cacheKey, { items: filtered, ts: Date.now() });
    }

    console.log(`✨ [조회 완료] 강화군 보호중: ${filtered.length}마리 (원본 공공데이터: ${allItems.length}마리)`);
    res.json({ total: filtered.length, items: filtered });

  } catch (err) {
    console.error('❌ 유기동물 조회 에러:', err.message);
    res.status(500).json({ error: err.message, total: 0, items: [] });
  }
});

// ==============================================================
// 🔗 단건 조회 API (공유 링크 접속 시)
// ==============================================================
app.get('/api/animal/:noticeNo', async (req, res) => {
  try {
    const noticeNo = decodeURIComponent(req.params.noticeNo);

    for (const [, cached] of dataCache) {
      const found = cached.items.find(a => a.noticeNo === noticeNo || a.desertionNo === noticeNo);
      if (found) return res.json(found);
    }

    const now = new Date();
    const endde = now.toISOString().slice(0,10).replace(/-/g, '');
    const bgnde = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
                    .toISOString().slice(0,10).replace(/-/g, '');

    const allItems = await fetchAllAnimals({
      upr_cd: ganghwaParams.upr_cd,
      org_cd: ganghwaParams.org_cd,
      bgnde, endde
    });

    const target = allItems.find(a => a.noticeNo === noticeNo || a.desertionNo === noticeNo);
    if (target) return res.json(target);

    res.status(404).json({ error: '해당 공고를 찾을 수 없습니다.' });
  } catch (err) {
    console.error('❌ 단건 조회 에러:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================
// 🖼️ 이미지 프록시 (병렬 시도 + 캐싱)
// ==============================================================
function generateCandidateUrls(rawUrl) {
  const clean = rawUrl.trim();
  const candidates = [];

  if (clean.includes('/files/shelter/')) {
    const fp = clean.substring(clean.indexOf('/files/shelter/'));
    candidates.push(`https://www.animal.go.kr${fp}`);
    candidates.push(`http://www.animal.go.kr${fp}`);
  }

  if (clean.includes('openapi.animal.go.kr')) {
    candidates.push(clean.replace('openapi.animal.go.kr', 'www.animal.go.kr').replace('http://', 'https://'));
    candidates.push(clean.replace('openapi.animal.go.kr', 'www.animal.go.kr'));
  }

  candidates.push(clean.replace('http://', 'https://'));
  candidates.push(clean.replace('https://', 'http://'));

  return [...new Set(candidates)];
}

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  if (imageCache.has(imageUrl)) {
    const cached = imageCache.get(imageUrl);
    if (Date.now() - cached.ts < IMG_CACHE_TTL) {
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=604800');
      return res.send(cached.data);
    }
    imageCache.delete(imageUrl);
  }

  const candidates = generateCandidateUrls(imageUrl);

  try {
    const result = await Promise.any(
      candidates.map(url =>
        axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 4500,
          httpsAgent,
          httpAgent,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.animal.go.kr/'
          }
        }).then(resp => {
          if (resp.status === 200 && resp.data && resp.data.length > 200) return resp;
          throw new Error('invalid');
        })
      )
    );

    const contentType = result.headers['content-type'] || 'image/jpeg';

    if (imageCache.size >= MAX_IMG_CACHE) {
      const oldest = imageCache.keys().next().value;
      imageCache.delete(oldest);
    }
    imageCache.set(imageUrl, { data: result.data, contentType, ts: Date.now() });

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=604800');
    return res.send(result.data);

  } catch (err) {
    res.status(404).send('Image Not Found');
  }
});

// ==============================================================
// SPA 라우팅 (Express 5 호환)
// ==============================================================
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ==============================================================
// 서버 시작
// ==============================================================
app.listen(PORT, async () => {
  console.log('');
  console.log('🐾 =========================================');
  console.log(`🐾  강화군 동물보호센터 서버 구동 완료!`);
  console.log(`🐾  접속 주소: http://localhost:${PORT}`);
  console.log('🐾 =========================================\n');
  
  // 서버 켜질 때 코드 감지 실행
  await initGanghwaCodes();
});
