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
app.use(express.static(path.join(__dirname, '..')));

// SSL 인증서 무시 에이전트
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const httpAgent = new http.Agent();

const BASE_URL = 'http://apis.data.go.kr/1543061/abandonmentPublicService_v2';

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
    timeout: 15000,
    httpsAgent,
    httpAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  return response.data;
}

// 강화군 코드 조회
async function getGanghwaParams() {
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

    return { upr_cd: '6280000', org_cd: orgCd, care_reg_no: careRegNo };
  } catch (e) {
    return { upr_cd: '6280000', org_cd: '3280000' };
  }
}

// ==============================================================
// 🎯 404 방지: 공공서버의 실제 이미지 경로 후보군 생성 함수
// ==============================================================
function generateCandidateUrls(rawUrl) {
  const cleanUrl = rawUrl.trim();
  const candidates = [];

  // 1. 공공 웹사이트 정적 파일 경로 추출 (/files/shelter/...)
  if (cleanUrl.includes('/files/shelter/')) {
    const filePath = cleanUrl.substring(cleanUrl.indexOf('/files/shelter/'));
    candidates.push(`https://www.animal.go.kr${filePath}`); // 실제 사이트가 쓰는 1순위 경로
    candidates.push(`http://www.animal.go.kr${filePath}`);
    candidates.push(`https://animal.go.kr${filePath}`);
  }

  // 2. openapi 도메인을 www 도메인으로 교체
  if (cleanUrl.includes('openapi.animal.go.kr')) {
    candidates.push(cleanUrl.replace('openapi.animal.go.kr', 'www.animal.go.kr').replace('http://', 'https://'));
    candidates.push(cleanUrl.replace('openapi.animal.go.kr', 'www.animal.go.kr'));
  }

  // 3. 원본 URL (HTTPS / HTTP)
  candidates.push(cleanUrl.replace('http://', 'https://'));
  candidates.push(cleanUrl.replace('https://', 'http://'));

  return [...new Set(candidates)];
}

// ==============================================================
// 🖼️ 404 없는 완벽한 이미지 프록시 라우터
// ==============================================================
app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || imageUrl === 'undefined') return res.status(400).send('URL 오류');

  const candidates = generateCandidateUrls(imageUrl);

  // 후보 경로들을 순차적으로 시도하여 가장 먼저 성공(200)하는 이미지를 반환
  for (const targetUrl of candidates) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        timeout: 6000,
        httpsAgent,
        httpAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://www.animal.go.kr/'
        }
      });

      if (response.status === 200 && response.data && response.data.length > 100) {
        const contentType = response.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(response.data);
      }
    } catch (err) {
      // 다음 후보 경로 시도
      continue;
    }
  }

  console.warn(`⚠️ 모든 후보 경로 실패: ${imageUrl}`);
  res.status(404).send('Image Not Found');
});

// ==============================================================
// 🎯 강화군 유기동물 조회 API
// ==============================================================
app.get('/api/animals', async (req, res) => {
  try {
    const { bgnde, endde, upkind } = req.query;
    const ganghwaParams = await getGanghwaParams();

    const queryParams = {
      ...ganghwaParams,
      numOfRows: '50'
    };

    if (bgnde) queryParams.bgnde = String(bgnde).replace(/[^0-9]/g, '');
    if (endde) queryParams.endde = String(endde).replace(/[^0-9]/g, '');
    if (upkind) queryParams.upkind = upkind;

    let allItems = [];
    let page = 1;
    let totalCount = 0;

    while (page <= 20) {
      const data = await fetchOpenApi('abandonmentPublic_v2', {
        ...queryParams,
        pageNo: String(page)
      });

      const body = data?.response?.body;
      if (!body || !body.items || !body.items.item) break;

      totalCount = parseInt(body.totalCount) || 0;
      const items = Array.isArray(body.items.item) ? body.items.item : [body.items.item];
      if (items.length === 0) break;

      allItems = allItems.concat(items);
      if (allItems.length >= totalCount || items.length < 50) break;

      page++;
      await new Promise(resolve => setTimeout(resolve, 80));
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

    console.log(`✨ [조회 완료] 강화군 동물보호센터 보호중: ${filtered.length}마리`);

    res.json({
      total: filtered.length,
      items: filtered
    });

  } catch (error) {
    console.error('❌ 유기동물 조회 에러:', error.message);
    res.status(500).json({ error: error.message, total: 0, items: [] });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('🐾 =========================================');
  console.log(`🐾  강화군 동물보호센터 서버 실행 완료!`);
  console.log(`🐾  접속 주소: http://localhost:${PORT}`);
  console.log('🐾 =========================================\n');
});
