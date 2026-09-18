const API_BASE = '/api';
const ITEMS_PER_PAGE = 20;
const MAX_GALLERY_IMAGES = 16;

let allAnimals = [];
let currentStatsFilter = 'all';
let currentStatusFilter = 'all';   // all | foster | adopting | news
let currentPage = 1;
let pendingDetailId = null;
let isModalOpen = false;

let modalImages = [];
let modalImageIndex = 0;
let extraImagesCache = new Map();
let currentDetailIndex = -1;
let currentLogs = null;            // 상세 모달의 케어 로그 (null = 로딩중)
const logsCache = new Map();

let pointerStartX = 0;
let pointerStartY = 0;
let pointerDeltaX = 0;
let pointerDeltaY = 0;
let pointerStartAt = 0;
let pointerActive = false;
let pointerId = null;
let pointerType = '';
let swipeLocked = null;

// 갤러리 전환 상태. 선택 즉시 작은 미리보기를 표시하고, 큰 이미지는
// 백그라운드에서 디코딩한 뒤 같은 <img>에 교체한다.
let modalImageLoadToken = 0;
let isModalGalleryLoading = false;
const modalFullImageLoads = new Map(); // url → Promise (브라우저 중복 다운로드 방지)
const extraImagesInflight = new Map();

const PLACEHOLDER_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
    <rect width="400" height="300" fill="#e2e8f0"/>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" font-size="36">🐾</text>
    <text x="50%" y="65%" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-size="14" font-weight="bold" font-family="sans-serif">사진 준비중</text>
  </svg>`
);

const SHELTER_LOGO_SRC = 'logo.svg';

// ==============================================================
// 🆕 상태 오버레이 + 케어 타임라인
// ==============================================================
const CUSTOM_STATUS = {
  foster:   { label: '🏡 임시보호중', cls: 'badge-foster',   color: '#8B5CF6' },
  adopting: { label: '🤝 입양진행중', cls: 'badge-adopting', color: '#EC4899' }
};

const LOG_TYPES = {
  notice:   { label: '공고',      icon: '📢', color: '#F59E0B' },
  intake:   { label: '입소',      icon: '📍', color: '#0EA5E9' },
  medical:  { label: '치료',      icon: '💉', color: '#EF4444' },
  surgery:  { label: '수술',      icon: '🏥', color: '#8B5CF6' },
  vaccine:  { label: '접종·예방', icon: '🛡️', color: '#10B981' },
  care:     { label: '케어·일상', icon: '🐾', color: '#64748B' },
  foster:   { label: '임시보호',  icon: '🏡', color: '#F97316' },
  adopting: { label: '입양 진행', icon: '🤝', color: '#EC4899' },
  note:     { label: '소식',      icon: '📝', color: '#14B8A6' }
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==============================================================
// 📊 이용 집계 (P1-1) — 개인정보 없이 집계값만 전송
//    sendBeacon 은 페이지를 닫아도 전송을 보장한다.
// ==============================================================
const TRACK_ENDPOINT = `${API_BASE}/track`;
function track(event, id, meta = {}) {
  try {
    const payload = JSON.stringify({ event, id: id || null, meta });
    if (navigator.sendBeacon &&
        navigator.sendBeacon(TRACK_ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;
    fetch(TRACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  } catch (_) { /* 집계가 화면 동작을 방해하지 않도록 */ }
}

// 머문 시간 — 페이지를 떠날 때(숨김/닫기) 지금까지의 체류 초를 보낸다
let dwellSentAt = Date.now();
function flushDwell() {
  const now = Date.now();
  const sec = Math.round((now - dwellSentAt) / 1000);
  if (sec < 1) return;
  dwellSentAt = now;
  const id = currentDetailIndex >= 0 && allAnimals[currentDetailIndex]
    ? getDesertionNo(allAnimals[currentDetailIndex]) : null;
  track('dwell_time', id, { seconds: sec });
}

// 로컬 경로(/img, /uploads)는 프록시 없이, 절대 URL은 이미지 프록시로.
// w 를 주면 서버가 해당 폭으로 축소·WebP 변환해 내려준다 (P0-4)
function photoSrc(p, w) {
  const s = String(p || '');
  if (!s) return '';
  if (s.startsWith('/')) return s;
  const base = `${API_BASE}/image-proxy?url=${encodeURIComponent(s)}`;
  return w ? `${base}&w=${w}` : base;
}

// 지금 걸려 있는 필터 요약(없으면 null) — filter_used 집계용
let defaultFilterDates = null;
function activeFilterSummary() {
  const f = {};
  const upkind = document.getElementById('upkind')?.value;
  if (upkind) f.upkind = upkind;
  const bgnde = document.getElementById('bgnde')?.value;
  const endde = document.getElementById('endde')?.value;
  if (defaultFilterDates && (bgnde !== defaultFilterDates.bgnde || endde !== defaultFilterDates.endde)) {
    f.bgnde = bgnde; f.endde = endde;
  }
  if (currentStatsFilter !== 'all') f.stats = currentStatsFilter;
  if (currentStatusFilter !== 'all') f.status = currentStatusFilter;
  return Object.keys(f).length ? f : null;
}

// 카드/상세 뱃지: 보호소가 지정한 상태(foster/adopting)가 API 상태보다 우선
function badgeFor(animal) {
  if (animal.customStatus && CUSTOM_STATUS[animal.customStatus]) {
    const m = CUSTOM_STATUS[animal.customStatus];
    return { text: m.label, cls: m.cls, color: m.color };
  }
  return (animal.processState || '').includes('공고')
    ? { text: '📢 공고중', cls: 'badge-notice', color: '#F59E0B' }
    : { text: '🏠 보호중', cls: 'badge-protect', color: '#10B981' };
}

window.handleImgError = function (img) {
  if (!img || img.dataset.fallback === '1') return;
  img.dataset.fallback = '1';
  img.onerror = null;
  img.src = PLACEHOLDER_SVG;
};

document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  document.getElementById('endde').value = formatDateToYMD(now);
  document.getElementById('bgnde').value = formatDateToYMD(
    new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  );
  defaultFilterDates = {
    bgnde: document.getElementById('bgnde').value,
    endde: document.getElementById('endde').value
  };

  // 딥링크: /a/:id 로 진입한 경우 서버가 심어준 __CARELINK_BOOT__ 사용(P0-2),
  //          기존 #detail/... 해시 링크도 그대로 동작한다(호환 유지)
  const bootId = window.__CARELINK_BOOT__ || null;
  pendingDetailId = bootId || parseDetailHash();
  pendingDetailSource = bootId ? 'link' : 'hash';
  searchAnimals(false);

  document.getElementById('searchBtn').addEventListener('click', () => {
    currentPage = 1;
    searchAnimals(true);
  });
  
  // 축종 목록은 서버에서 전체를 받아 브라우저에서 즉시 필터링한다.
  // 그래야 보호중 개체수는 항상 전체값을 유지하면서 선택 축종 카드만 강조할 수 있다.
  document.getElementById('upkind').addEventListener('change', () => {
    currentStatsFilter = statsFilterFromUpkind(document.getElementById('upkind').value);
    currentPage = 1;
    updateStatsActiveCard();
    renderPage(false);
  });

  ['bgnde', 'endde'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      currentPage = 1;
      searchAnimals(false);
    });
  });

  setupStatsFilterEvents();
  setupStatusFilterEvents();
  setupInfiniteScroll();
  setupTopButton();

  // 모달 닫기 — X·배경 클릭·ESC 모두 같은 경로(requestCloseModal)를 지난다.
  // pushState 로 쌓은 히스토리는 뒤로가기로 정리되고, 브라우저/안드로이드
  // 하드웨어 뒤로가기(popstate)도 같은 코드로 닫힌다 (P0-3)
  document.getElementById('modalClose').addEventListener('click', requestCloseModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) requestCloseModal();
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') requestCloseModal();
    if (isModalOpen && modalImages.length > 1) {
      if (e.key === 'ArrowRight') showModalImageByIndex(modalImageIndex + 1);
      if (e.key === 'ArrowLeft') showModalImageByIndex(modalImageIndex - 1);
    }
  });

  // 뒤로가기/앞으로가기 — 상세가 열려 있으면 닫고, 히스토리 안에서
  // 다른 개체 상세로 이동했으면 그 개체를 보여준다 (P0-3)
  window.addEventListener('popstate', handlePopState);

  // 입양 문의(전화 걸기) 집계 — 위임 처리 (P1-1)
  document.getElementById('modalBody').addEventListener('click', (e) => {
    const tel = e.target && e.target.closest ? e.target.closest('a[href^="tel:"]') : null;
    if (tel && currentDetailIndex >= 0 && allAnimals[currentDetailIndex]) {
      track('adopt_inquiry', getDesertionNo(allAnimals[currentDetailIndex]));
    }
  });

  // 머문 시간 집계 — 페이지 숨김/닫힘 시점에 확정 전송 (P1-1)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDwell();
  });
  window.addEventListener('pagehide', flushDwell);
});

function formatDateToYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setSearchBtnLoading(isLoading) {
  const btn = document.getElementById('searchBtn');
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    btn.dataset.prevHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> 새로고침 중...';
  } else {
    btn.disabled = false;
    if (btn.dataset.prevHtml) btn.innerHTML = btn.dataset.prevHtml;
  }
}

// ==============================================================
// 🔗 딥링크 · 히스토리 (P0-2 공유 주소 + P0-3 뒤로가기)
// ==============================================================
let pendingDetailSource = null; // 'link' | 'hash'
let modalHistoryPushed = false; // 상세 열람 항목을 pushState 로 쌓았는가

function getShareId(animalOrNoticeNo) {
  const raw = typeof animalOrNoticeNo === 'string' ? animalOrNoticeNo : String(animalOrNoticeNo?.noticeNo || '');
  let id = raw.trim().replace(/[가-힣]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = id.match(/(\d{4}-\d+)/);
  if (m) return m[1];
  return id;
}

// 링크 복사용 주소 — 우선순위: 짧은 주소 /s/코드 → 경로형 /a/아이디 (P1-3, P0-2)
function getDetailShareUrl(animal) {
  const origin = window.location.origin;
  if (animal?.shortCode) return `${origin}/s/${animal.shortCode}`;
  const id = animal?.shareId || getShareId(animal);
  if (!id) return origin + window.location.pathname;
  return `${origin}/a/${id}`;
}

// 공유 시트·공유용 주소 — 미리보기(OG)가 확실한 경로형 주소 (P0-2)
function getDetailSharePageUrl(animal) {
  const origin = window.location.origin;
  const id = animal?.shareId || getShareId(animal);
  if (!id) return origin + window.location.pathname;
  return `${origin}/a/${id}`;
}

function parseDetailHash() {
  const m = (window.location.hash || '').match(/^#detail\/([^/?#]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

function setDetailHash(shareId) {
  const next = shareId ? `#detail/${shareId}` : '';
  if ((window.location.hash || '') === next) return;
  if (next) history.replaceState(null, '', next);
  else history.replaceState(null, '', window.location.pathname + window.location.search);
}

function openDetailByShareId(shareId, opts = {}) {
  if (!shareId) return false;
  const target = String(shareId).trim().toLowerCase();
  const idx = allAnimals.findIndex(a => {
    const id = (a.shareId || getShareId(a)).toLowerCase();
    return id && (id === target || id.endsWith(target) || target.endsWith(id));
  });
  if (idx < 0) return false;

  const filtered = getFilteredAnimals();
  const filteredIndex = filtered.indexOf(allAnimals[idx]);
  if (filteredIndex >= 0) {
    const neededPage = Math.floor(filteredIndex / ITEMS_PER_PAGE) + 1;
    while (currentPage < neededPage) {
      currentPage++;
      renderPage(true);
    }
  }
  showDetail(idx, opts);
  return true;
}

// 뒤로가기(popstate) — 상세 모달이 열려 있으면 닫고(히스토리는 이미 이동했으므로
// URL 정리 불필요), 다른 상세 해시로 이동했으면 그 개체를 다시 띄운다.
// 안드로이드 하드웨어 뒤로가기도 popstate 를 발생시키므로 함께 해결된다. (P0-3)
function handlePopState() {
  const id = parseDetailHash();
  if (id) {
    if (allAnimals.length === 0) {
      pendingDetailId = id;
      pendingDetailSource = 'history';
    } else {
      openDetailByShareId(id, { pushHistory: false, source: 'history' });
    }
  } else if (isModalOpen) {
    closeModal({ skipHashClear: true });
  }
}

function statsFilterFromUpkind(upkind) {
  return ({ '417000': 'dog', '422400': 'cat', '429900': 'etc' })[String(upkind || '')] || 'all';
}

function upkindFromStatsFilter(statsFilter) {
  return ({ dog: '417000', cat: '422400', etc: '429900' })[statsFilter] || '';
}

async function searchAnimals(forceRefresh = false) {
  showLoading(true);
  if (forceRefresh) setSearchBtnLoading(true);

  const bgnde = document.getElementById('bgnde').value;
  const endde = document.getElementById('endde').value;

  // upkind를 API 요청에서 제외한다. 전체 목록을 보유해야 통계의 "보호중
  // 개체수"가 축종 필터에 따라 줄어들지 않고, 축종별 숫자도 정확히 유지된다.
  const params = new URLSearchParams({ bgnde, endde });
  if (forceRefresh) params.append('refresh', '1');

  try {
    const response = await fetch(`${API_BASE}/animals?${params}`, {
      cache: forceRefresh ? 'no-store' : 'default'
    });
    const result = await response.json();
    
    allAnimals = result.items || [];
    // 요청 도중 축종 선택이 바뀌어도 응답 시점의 최신 선택을 강조한다.
    currentStatsFilter = statsFilterFromUpkind(document.getElementById('upkind').value);
    currentStatusFilter = 'all';
    currentPage = 1;
    
    updateStatsActiveCard();
    const chips = document.getElementById('statusFilter');
    if (chips) chips.querySelectorAll('.status-chip').forEach((c) => c.classList.toggle('active', c.dataset.status === 'all'));
    renderPage(false);
    updateStats();
    updateStatusChips();
    
    if (pendingDetailId) {
      // 최초 진입 딥링크 — 히스토리를 새로 쌓지 않고 현재 주소 위에서 연다
      openDetailByShareId(pendingDetailId, { pushHistory: false, source: pendingDetailSource || 'link' });
      pendingDetailId = null;
      pendingDetailSource = null;
    }
    // 목록 강제 새로고침과 상세 사진(서버 30분 TTL)은 별도 캐시다.
    // 상세 Map을 여기서 지우면 방금 본 카드를 다시 열 때 불필요한 요청이 생긴다.
  } catch (error) {
    console.error('데이터 조회 실패:', error);
    allAnimals = [];
    renderPage(false);
  }

  showLoading(false);
  if (forceRefresh) setSearchBtnLoading(false);
}

function getFilteredAnimals() {
  let list = allAnimals;
  if (currentStatsFilter === 'dog') list = list.filter(a => (a.kindFullNm || a.kindNm || a.kindCd || '').includes('개'));
  else if (currentStatsFilter === 'cat') list = list.filter(a => (a.kindFullNm || a.kindNm || a.kindCd || '').includes('고양이'));
  else if (currentStatsFilter === 'etc') list = list.filter(a => {
    const kind = a.kindFullNm || a.kindNm || a.kindCd || '';
    return !kind.includes('개') && !kind.includes('고양이');
  });
  if (currentStatusFilter === 'foster' || currentStatusFilter === 'adopting') {
    list = list.filter(a => a.customStatus === currentStatusFilter);
  } else if (currentStatusFilter === 'news') {
    list = list.filter(a => (a.logCount || 0) > 0);
  }
  return list;
}

function setupStatsFilterEvents() {
  ['total', 'dog', 'cat', 'etc'].forEach(type => {
    const el = document.querySelector(`.stat-card.${type}`);
    if (el) {
      el.addEventListener('click', () => {
        currentStatsFilter = type === 'total' ? 'all' : type;
        currentPage = 1;
        const upkind = document.getElementById('upkind');
        if (upkind) upkind.value = upkindFromStatsFilter(currentStatsFilter);
        updateStatsActiveCard();
        renderPage(false);
      });
    }
  });
}

function setupStatusFilterEvents() {
  const wrap = document.getElementById('statusFilter');
  if (!wrap) return;
  wrap.querySelectorAll('.status-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      currentStatusFilter = chip.dataset.status || 'all';
      currentPage = 1;
      wrap.querySelectorAll('.status-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderPage(false);
    });
  });
}

function updateStatusChips() {
  const counts = { all: allAnimals.length, foster: 0, adopting: 0, news: 0 };
  allAnimals.forEach((a) => {
    if (a.customStatus === 'foster') counts.foster++;
    if (a.customStatus === 'adopting') counts.adopting++;
    if ((a.logCount || 0) > 0) counts.news++;
  });
  const map = { all: 'cntAll', foster: 'cntFoster', adopting: 'cntAdopting', news: 'cntNews' };
  Object.entries(map).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = counts[key];
  });
}

function updateStatsActiveCard() {
  document.querySelectorAll('.stat-card').forEach(card => card.classList.remove('active'));
  const sel = currentStatsFilter === 'all' ? '.stat-card.total' : `.stat-card.${currentStatsFilter}`;
  const activeCard = document.querySelector(sel);
  if (activeCard) activeCard.classList.add('active');
}

// ==============================================================
// 🖼️ 이미지 중복 제거 및 수집
// ==============================================================
function getFilenameFromUrl(url) {
  if (!url) return '';
  const s = String(url);
  if (/f_seq=/i.test(s) || /f_id=/i.test(s)) {
    const id = (s.match(/f_id=(\d+)/i) || [])[1] || '';
    const seq = (s.match(/f_seq=(\d+)/i) || [])[1] || '';
    return `fid${id}_seq${seq}`.toLowerCase();
  }
  try {
    return decodeURIComponent(s.split('/').pop().split('?')[0]).toLowerCase();
  } catch {
    return (s.split('/').pop() || '').toLowerCase();
  }
}

function getDesertionNo(animal) {
  if (!animal) return '';
  return String(
    animal.desertionNo || animal.desertionNO || animal.DesertionNo || animal.desertionno || ''
  ).trim();
}

function extractAllImages(animal) {
  if (!animal) return [];
  const list = [];

  const push = (raw, key) => {
    if (!raw || typeof raw !== 'string') return;
    const cleanUrl = raw.trim();

    let url = null;
    if (/^https?:\/\//i.test(cleanUrl)) {
      // 용도별 폭으로 서버에 요청 (P0-4): 상세 큰 사진 1000, 썸네일 160
      url = photoSrc(cleanUrl, 1000);
    } else if (cleanUrl.startsWith('/')) {
      url = cleanUrl; // 데모/로컬 업로드 이미지
    }
    if (!url) return;

    list.push({
      key,
      url,
      // 첫 장은 카드에서 이미 받은 400px 변형을 즉시 재사용하고,
      // 썸네일 선택 시에는 160px 이미지를 먼저 보여 준다.
      previewUrl: /^https?:\/\//i.test(cleanUrl) ? photoSrc(cleanUrl, 400) : url,
      thumbUrl: /^https?:\/\//i.test(cleanUrl) ? photoSrc(cleanUrl, 160) : url,
      rawUrl: cleanUrl,
      filename: getFilenameFromUrl(cleanUrl),
      isExtra: false,
      listLabel: `원본${list.length + 1}`
    });
  };

  for (let i = 1; i <= 10; i++) {
    for (const k of [`popfile${i}`, `popFile${i}`, `POPFILE${i}`]) {
      if (animal[k]) {
        push(animal[k], `popfile${i}`);
        break;
      }
    }
  }

  return list.map((img, i) => ({ ...img, num: i + 1, listLabel: `원본${i + 1}` }));
}

function mergeAllImagesSmart(baseImages, extraRawUrls) {
  const merged = [];
  const seenFilenames = new Set();

  (baseImages || []).forEach((img, idx) => {
    const fn = img.filename || getFilenameFromUrl(img.rawUrl);
    if (fn) seenFilenames.add(fn);
    merged.push({ ...img, num: merged.length + 1, isExtra: false, listLabel: `원본${idx + 1}` });
  });

  let crawlNo = 0;
  (Array.isArray(extraRawUrls) ? extraRawUrls : []).forEach((rawUrl, idx) => {
    let clean = String(rawUrl || '').trim();
    if (!clean) return;

    const fn = getFilenameFromUrl(clean);
    if (fn && seenFilenames.has(fn)) return; // 원본 중복 무시
    if (fn) seenFilenames.add(fn);

    crawlNo++;
    const local = clean.startsWith('/');
    merged.push({
      num: merged.length + 1,
      key: `crawl${idx + 1}`,
      url: local ? clean : photoSrc(clean, 1000),
      previewUrl: local ? clean : photoSrc(clean, 400),
      thumbUrl: local ? clean : photoSrc(clean, 160),
      rawUrl: clean,
      filename: fn,
      isExtra: true,
      listLabel: `크롤링${crawlNo}`
    });
  });

  return merged.slice(0, MAX_GALLERY_IMAGES).map((img, i) => ({ ...img, num: i + 1 }));
}

async function fetchExtraImages(desertionNo) {
  if (!desertionNo) return [];
  const key = String(desertionNo);

  // 빈 배열도 정상 캐시값이다. 기존 코드는 Map에 저장만 하고 읽지 않아 같은
  // 카드를 다시 열 때마다 detail-images 요청을 반복했다.
  if (extraImagesCache.has(key)) return extraImagesCache.get(key);
  if (extraImagesInflight.has(key)) return extraImagesInflight.get(key);

  // refresh 를 강제하지 않는다 — 서버의 크롤링 캐시를 사용한다.
  const q = new URLSearchParams({ desertionNo: key });
  const job = (async () => {
    try {
      const response = await fetch(`${API_BASE}/detail-images?${q}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`detail-images ${response.status}`);
      const result = await response.json();
      const images = Array.isArray(result.images) ? result.images : [];
      extraImagesCache.set(key, images);
      return images;
    } catch (_) {
      return [];
    } finally {
      extraImagesInflight.delete(key);
    }
  })();

  extraImagesInflight.set(key, job);
  return job;
}

// 카드 대표 이미지 — w=400(기본) / 800(고해상도) (P0-4)
function getThumbnailUrl(animal, w = 400) {
  const images = extractAllImages(animal);
  if (images.length === 0) return PLACEHOLDER_SVG;
  const raw = images[0].rawUrl;
  if (!/^https?:\/\//i.test(raw)) return images[0].url; // 로컬 데모 이미지
  return photoSrc(raw, w);
}

function setupInfiniteScroll() {
  const target = document.createElement('div');
  target.id = 'scrollAnchor';
  document.getElementById('animalGrid').insertAdjacentElement('afterend', target);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreAnimals();
  }, { rootMargin: '100px' }).observe(target);
}

function loadMoreAnimals() {
  if (currentPage * ITEMS_PER_PAGE < getFilteredAnimals().length) {
    currentPage++; renderPage(true);
  }
}

function setupTopButton() {
  const btn = document.createElement('button');
  btn.id = 'topBtn'; btn.className = 'btn-top hidden'; btn.innerHTML = '<i class="fas fa-arrow-up"></i>';
  document.body.appendChild(btn);
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => {
    btn.classList.toggle('hidden', window.scrollY <= 300);
  });
}

function renderPage(isAppend = false) {
  const grid = document.getElementById('animalGrid');
  const noData = document.getElementById('noData');
  const filtered = getFilteredAnimals();

  if (filtered.length === 0) {
    grid.innerHTML = ''; noData.style.display = 'block'; return;
  }
  noData.style.display = 'none';

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const html = pageItems.map((animal) => {
    const realIndex = allAnimals.indexOf(animal);
    const kindText = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
    const sexNeuter = `${getSexIcon(animal.sexCd)} / ${animal.neuterYn === 'Y' ? '중성화O' : '중성화X'}`;
    const happenDt = formatDate(animal.happenDt);
    const imgSrc = getThumbnailUrl(animal, 400);
    const imgSrc2x = imgSrc.startsWith(`${API_BASE}/image-proxy`)
      ? getThumbnailUrl(animal, 800) : ''; // 고해상도 화면용(필요할 때만 내려받음)
    const badge = badgeFor(animal);
    const logCount = animal.logCount || 0;
    const mngSuffix = getDesertionNo(animal).slice(-5); // 관리번호 뒷자리 5자리

    return `
      <div class="animal-card" onclick="showDetail(${realIndex})">
        <div class="card-image">
          <img src="${imgSrc}"${imgSrc2x ? ` srcset="${imgSrc} 1x, ${imgSrc2x} 2x"` : ''} alt="${kindText}" loading="lazy" decoding="async" onerror="handleImgError(this)">
          <span class="card-badge ${badge.cls}" title="${escapeHtml(animal.processState || '')}">${badge.text}</span>
          <span class="card-kind">${kindText}</span>
          ${logCount > 0 ? `<span class="card-news-pill" title="케어 기록 ${logCount}건"><i class="far fa-newspaper"></i> ${logCount}</span>` : ''}
        </div>
        <div class="card-body">
          <div class="card-title-row">
            <h3>${animal.noticeNo || '공고번호 미상'}</h3>
            ${mngSuffix ? `<span class="card-mng-no" title="관리번호 ${escapeHtml(getDesertionNo(animal))}">#${mngSuffix}</span>` : ''}
          </div>
          <div class="card-info">
            <div class="card-info-item"><i class="fas fa-map-marker-alt"></i><span>${animal.happenPlace || '일대'}</span></div>
            <div class="card-info-item"><i class="fas fa-palette"></i><span>${animal.colorCd || '미상'} · ${animal.age || '미상'}</span></div>
            <div class="card-info-item"><i class="fas fa-venus-mars"></i><span>${sexNeuter}</span></div>
            ${animal.lastLog ? `<div class="card-info-item card-lastlog"><i class="fas fa-pen"></i><span>최근: ${escapeHtml(animal.lastLog.title)}</span></div>` : ''}
          </div>
        </div>
        <div class="card-footer">
          <span class="card-date"><i class="far fa-calendar-alt"></i> ${happenDt}</span>
          <button class="btn-detail">상세보기</button>
        </div>
      </div>
    `;
  }).join('');

  if (isAppend) grid.insertAdjacentHTML('beforeend', html);
  else grid.innerHTML = html;
}

function setupModalImageNavigation() {
  const mainBox = document.querySelector('.modal-main-image-box');
  if (!mainBox) return;

  const multiple = modalImages.length > 1;
  mainBox.classList.toggle('has-multiple', multiple);

  // addEventListener를 매 렌더마다 누적하지 않고 프로퍼티를 교체한다. 기존의
  // cloneNode 방식은 메인 이미지를 다시 만들며 디코딩/페인트를 지연시켰다.
  mainBox.onpointerdown = multiple ? onGalleryPointerDown : null;
  mainBox.onpointermove = multiple ? onGalleryPointerMove : null;
  mainBox.onpointerup = multiple ? onGalleryPointerUp : null;
  mainBox.onpointercancel = multiple ? onGalleryPointerCancel : null;

  upgradeModalMainImage(modalImageIndex);
}

function resetGalleryPointer(target) {
  pointerActive = false;
  pointerId = null;
  pointerType = '';
  swipeLocked = null;
  pointerDeltaX = 0;
  pointerDeltaY = 0;
  if (target) target.classList.remove('is-swiping');
  const img = document.getElementById('modalMainImg');
  if (img) {
    img.style.transition = 'transform 100ms ease-out';
    img.style.transform = '';
  }
}

function onGalleryPointerDown(e) {
  if (modalImages.length <= 1 || pointerActive || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pointerActive = true;
  pointerId = e.pointerId;
  pointerType = e.pointerType || 'mouse';
  pointerStartAt = performance.now();
  swipeLocked = null;
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  pointerDeltaX = 0;
  pointerDeltaY = 0;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  e.currentTarget.classList.add('is-swiping');
}

function onGalleryPointerMove(e) {
  if (!pointerActive || e.pointerId !== pointerId) return;
  pointerDeltaX = e.clientX - pointerStartX;
  pointerDeltaY = e.clientY - pointerStartY;

  if (!swipeLocked && Math.hypot(pointerDeltaX, pointerDeltaY) >= 6) {
    // 대각선에서 세로 스크롤이 사진 넘김으로 오인되지 않도록 약간의 축 편향을 둔다.
    swipeLocked = Math.abs(pointerDeltaX) > Math.abs(pointerDeltaY) * 1.08 ? 'h' : 'v';
  }

  if (swipeLocked === 'h') {
    e.preventDefault();
    const img = document.getElementById('modalMainImg');
    if (img) {
      img.style.transition = 'none';
      img.style.transform = `translate3d(${pointerDeltaX * 0.32}px, 0, 0)`;
    }
  }
}

function onGalleryPointerUp(e) {
  if (!pointerActive || e.pointerId !== pointerId) return;

  const dx = pointerDeltaX;
  const dy = pointerDeltaY;
  const elapsed = Math.max(1, performance.now() - pointerStartAt);
  const releasedType = pointerType;
  const horizontal = swipeLocked === 'h' || (Math.abs(dx) > Math.abs(dy) * 1.08);
  const fastSwipe = Math.abs(dx) >= 16 && Math.abs(dx) / elapsed >= 0.25;
  const distanceSwipe = Math.abs(dx) >= 28;
  const mouseClick = releasedType === 'mouse' && Math.hypot(dx, dy) <= 8 && elapsed < 800;

  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
  resetGalleryPointer(e.currentTarget);

  if (horizontal && (distanceSwipe || fastSwipe)) {
    e.preventDefault();
    showModalImageByIndex(modalImageIndex + (dx < 0 ? 1 : -1));
  } else if (mouseClick) {
    // click 이벤트까지 기다리지 않고 pointerup에서 처리해 PC 반응을 즉시 보이게 한다.
    e.preventDefault();
    showModalImageByIndex(modalImageIndex + 1);
  }
}

function onGalleryPointerCancel(e) {
  if (!pointerActive || e.pointerId !== pointerId) return;
  // 브라우저가 세로 스크롤을 가져간 pointercancel은 사진 이동으로 처리하지 않는다.
  resetGalleryPointer(e.currentTarget);
}

function loadModalFullImage(url, priority = 'auto') {
  if (!url) return Promise.reject(new Error('empty image url'));
  if (modalFullImageLoads.has(url)) return modalFullImageLoads.get(url);

  const job = new Promise((resolve, reject) => {
    const loader = new Image();
    loader.decoding = 'async';
    if ('fetchPriority' in loader) loader.fetchPriority = priority;
    loader.onload = async () => {
      try { if (loader.decode) await loader.decode(); } catch (_) {}
      resolve(url);
    };
    loader.onerror = () => reject(new Error('image load failed'));
    loader.src = url;
  }).catch((error) => {
    modalFullImageLoads.delete(url); // 일시 오류라면 다음 선택 때 재시도
    throw error;
  });

  modalFullImageLoads.set(url, job);
  return job;
}

function preloadAdjacentModalImage(index) {
  if (modalImages.length <= 1) return;
  const next = modalImages[(index + 1) % modalImages.length];
  const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  schedule(() => { if (isModalOpen && next?.url) loadModalFullImage(next.url, 'low').catch(() => {}); }, { timeout: 1200 });
}

async function upgradeModalMainImage(index) {
  const imgData = modalImages[index];
  const mainImg = document.getElementById('modalMainImg');
  if (!imgData || !mainImg) return;

  const token = ++modalImageLoadToken;
  mainImg.dataset.fullSrc = imgData.url;
  try {
    await loadModalFullImage(imgData.url, 'high');
    if (token !== modalImageLoadToken || modalImageIndex !== index || !isModalOpen) return;
    const liveImg = document.getElementById('modalMainImg');
    if (!liveImg || liveImg.dataset.fullSrc !== imgData.url) return;
    liveImg.dataset.fallback = '';
    liveImg.onerror = function () { handleImgError(liveImg); };
    liveImg.src = imgData.url;
    liveImg.classList.remove('is-preview');
    preloadAdjacentModalImage(index);
  } catch (_) {
    // 160/400px 미리보기는 유지한다. 큰 이미지 오류 때문에 화면을 비우지 않는다.
  }
}

function keepActiveThumbnailVisible(activeThumb) {
  const strip = activeThumb?.closest('.modal-thumb-strip');
  if (!strip) return;
  const left = activeThumb.offsetLeft;
  const right = left + activeThumb.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 8);
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
}

function showModalImageByIndex(index) {
  if (!modalImages.length) return;
  modalImageIndex = ((index % modalImages.length) + modalImages.length) % modalImages.length;
  const imgData = modalImages[modalImageIndex];
  const mainImg = document.getElementById('modalMainImg');
  const badge = document.getElementById('modalImgBadge');

  // 선택 테두리보다 메인 이미지 요청이 늦게 보이던 문제를 없애기 위해, 이미
  // 로드된 160px 썸네일을 메인 영역에 먼저 즉시 표시한다.
  if (mainImg) {
    modalImageLoadToken++;
    mainImg.dataset.fallback = '';
    mainImg.dataset.fullSrc = imgData.url;
    mainImg.style.transition = 'none';
    mainImg.style.transform = '';
    mainImg.onerror = function () { handleImgError(mainImg); };
    const thumbImg = document.querySelectorAll('.modal-thumb-btn')[modalImageIndex]?.querySelector('img');
    const readyThumb = thumbImg?.complete && thumbImg.naturalWidth > 0 ? thumbImg.currentSrc || thumbImg.src : '';
    mainImg.src = readyThumb || imgData.thumbUrl || imgData.previewUrl || imgData.url;
    mainImg.classList.toggle('is-preview', mainImg.getAttribute('src') !== imgData.url);
  }
  if (badge) badge.textContent = `${modalImageIndex + 1} / ${modalImages.length} (${imgData.listLabel || imgData.key})`;

  let activeThumb = null;
  document.querySelectorAll('.modal-thumb-btn').forEach((btn, i) => {
    const active = i === modalImageIndex;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    if (active) activeThumb = btn;
  });
  keepActiveThumbnailVisible(activeThumb);
  upgradeModalMainImage(modalImageIndex);

  // 페인트를 막지 않도록 집계 전송은 다음 프레임 뒤로 미룬다.
  if (modalImages.length > 1 && currentDetailIndex >= 0 && allAnimals[currentDetailIndex]) {
    const animalId = getDesertionNo(allAnimals[currentDetailIndex]);
    const photo = modalImageIndex + 1;
    setTimeout(() => track('photo_swipe', animalId, { photo }), 0);
  }
}

// ==============================================================
// 🆕 케어 타임라인
// ==============================================================
async function fetchAnimalLogs(desertionNo) {
  if (!desertionNo) return [];
  const key = String(desertionNo);
  const cached = logsCache.get(key);
  if (cached && Date.now() - cached.t < 30 * 1000) return cached.logs;
  try {
    const response = await fetch(`${API_BASE}/animals/${encodeURIComponent(key)}/logs`, { cache: 'no-store' });
    const data = await response.json();
    const logs = Array.isArray(data.logs) ? data.logs : [];
    logsCache.set(key, { t: Date.now(), logs });
    return logs;
  } catch (_) {
    return [];
  }
}

// API 기본정보(입소·공고)로 자동 항목을 만들고, 관리자 로그와 합쳐 최신순 정렬
function buildTimelineEntries(animal, logs) {
  const entries = [];
  const hasManualIntake = (logs || []).some((l) => l.type === 'intake');

  if (!hasManualIntake && animal.happenDt) {
    entries.push({
      id: 'auto-intake',
      auto: true,
      date: String(animal.happenDt),
      type: 'intake',
      title: '보호소 입소',
      content: [
        animal.happenPlace ? `발견 장소: ${animal.happenPlace}` : '',
        animal.specialMark ? `입소 시 특징: ${animal.specialMark}` : ''
      ].filter(Boolean).join('\n')
    });
  }
  if (animal.noticeSdt) {
    entries.push({
      id: 'auto-notice',
      auto: true,
      date: String(animal.noticeSdt),
      type: 'notice',
      title: '공고 시작',
      content: `공고 기간 ${formatDate(animal.noticeSdt)} ~ ${formatDate(animal.noticeEdt || '')}`
    });
  }
  const manual = (logs || []).map((l) => ({ ...l, manual: true }));
  return [...entries, ...manual].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function timelineHtml(animal, logs) {
  const loading = logs === null;
  const count = animal.logCount || 0;

  let bodyHtml;
  if (loading) {
    bodyHtml = `<div class="timeline-loading"><i class="fas fa-circle-notch fa-spin"></i> 케어 기록을 불러오는 중...</div>`;
  } else {
    const entries = buildTimelineEntries(animal, logs);
    if (!entries.length) {
      bodyHtml = `<div class="timeline-empty">아직 기록이 없습니다.</div>`;
    } else {
      bodyHtml = `<div class="timeline">${entries.map((e, i) => {
        const meta = LOG_TYPES[e.type] || LOG_TYPES.note;
        return `
          <div class="timeline-item ${e.auto ? 'is-auto' : ''}">
            <div class="tl-marker" style="background:${meta.color}">${meta.icon}</div>
            <div class="tl-body">
              <div class="tl-head">
                <span class="tl-date">${formatDate(e.date)}</span>
                <span class="tl-type" style="color:${meta.color}; border-color:${meta.color}55">${meta.label}</span>
                ${(!e.auto && i === 0) ? '<span class="tl-latest">최근</span>' : ''}
                ${e.auto ? '<span class="tl-auto-tag">시스템 자동</span>' : ''}
              </div>
              <div class="tl-title">${escapeHtml(e.title || '')}</div>
              ${e.content ? `<div class="tl-content">${escapeHtml(e.content).replace(/\n/g, '<br>')}</div>` : ''}
            </div>
          </div>`;
      }).join('')}</div>`;
    }
  }

  return `
    <div class="timeline-section">
      <h3 class="timeline-title"><i class="fas fa-book-open"></i> 입소 후 케어 기록${!loading && count ? ` <span class="tl-count-badge">${count}</span>` : ''}</h3>
      ${bodyHtml}
    </div>`;
}

// ==============================================================
// 🎯 상세 모달
//    opts.pushHistory: 히스토리에 쌓을지(기본 true). popstate/딥링크 경로는 false.
//    opts.source: 'list' | 'link' | 'hash' | 'history' — 유입 경로 집계용
// ==============================================================
async function showDetail(index, opts = {}) {
  const animal = allAnimals[index];
  if (!animal) return;

  currentDetailIndex = index;

  const stateText = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
  const baseImages = extractAllImages(animal);
  const kindTitle = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
  const shareId = animal.shareId || getShareId(animal);
  const desertionNo = getDesertionNo(animal);

  modalImages = mergeAllImagesSmart(baseImages, []);
  modalImageIndex = 0; pointerActive = false; swipeLocked = null; pointerDeltaX = 0;
  currentLogs = null;
  isModalGalleryLoading = !!desertionNo && !extraImagesCache.has(desertionNo);

  const noticePeriod = (animal.noticeSdt && animal.noticeEdt) ? `${formatDate(animal.noticeSdt)} ~ ${formatDate(animal.noticeEdt)}` : '정보 없음';

  renderModalContent(animal, index, kindTitle, stateText, noticePeriod);
  document.getElementById('modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  isModalOpen = true;

  // 히스토리에 상세 열람 항목을 쌓는다 — 뒤로가기가 "사이트 밖"이 아니라
  // "상세 열기 이전"으로 돌아가게 된다 (P0-3)
  if (shareId && opts.pushHistory !== false) {
    history.pushState({ carelink: 'detail', id: shareId }, '', `#detail/${shareId}`);
    modalHistoryPushed = true;
  } else if (shareId) {
    setDetailHash(shareId); // 딥링크/팝스테이트 경로 — 주소 동기화만
  }

  // 📊 집계 (P1-1): 개체 열람 + 유입 경로 + 필터로 찾아낸 개체
  const source = opts.source || 'list';
  track('page_view', desertionNo);
  track('link_open', desertionNo, { path: source === 'list' ? 'list' : 'link' });
  const filters = activeFilterSummary();
  if (filters) track('filter_used', desertionNo, filters);

  if (desertionNo) {
    // 사진과 로그를 독립 반영한다. 느린 크롤링이 로그 표시를 막거나, 완료 시점에
    // 모달 전체를 재렌더해 사용자가 선택한 사진을 1번으로 되돌리지 않는다.
    fetchExtraImages(desertionNo).then((extraUrls) => {
      if (!isModalOpen || currentDetailIndex !== index) return;

      const hadImages = modalImages.length > 0;
      const selectedRawUrl = modalImages[modalImageIndex]?.rawUrl;
      modalImages = mergeAllImagesSmart(baseImages, extraUrls);
      const preservedIndex = modalImages.findIndex((img) => img.rawUrl === selectedRawUrl);
      modalImageIndex = preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(modalImageIndex, modalImages.length - 1));
      isModalGalleryLoading = false;
      // API 기본 사진이 전혀 없고 크롤링 사진만 발견된 경우에만 전체 구조를 한 번 만든다.
      if (!hadImages && modalImages.length) renderModalContent(animal, index, kindTitle, stateText, noticePeriod);
      else refreshModalGalleryControls();
    });

    fetchAnimalLogs(desertionNo).then((logs) => {
      if (!isModalOpen || currentDetailIndex !== index) return;
      currentLogs = logs;
      const timeline = document.querySelector('.timeline-section');
      if (timeline) timeline.outerHTML = timelineHtml(animal, currentLogs);
    });
  }
}

function modalThumbStripHtml(images, safeIndex) {
  if (images.length <= 1) return '';
  return `
    <div class="modal-thumb-strip" role="tablist" aria-label="사진 목록">
      ${images.map((img, i) => `
        <button type="button"
          class="modal-thumb-btn ${i === safeIndex ? 'active' : ''} ${img.isExtra ? 'is-extra' : 'is-origin'}"
          onclick="event.stopPropagation(); selectModalImage(${i})"
          title="${img.listLabel || img.key}"
          role="tab"
          aria-selected="${i === safeIndex ? 'true' : 'false'}"
          tabindex="${i === safeIndex ? '0' : '-1'}"
          aria-label="${i + 1}번째 사진 보기">
          <img src="${i === 0 && !img.isExtra ? (img.previewUrl || img.thumbUrl || img.url) : (img.thumbUrl || img.previewUrl || img.url)}" alt="" loading="${i < 8 ? 'eager' : 'lazy'}" decoding="async" fetchpriority="low" onerror="handleImgError(this)" draggable="false">
          <span class="thumb-num">${i + 1}</span>
          ${img.isExtra ? '<span class="thumb-extra-badge">C</span>' : '<span class="thumb-origin-badge">J</span>'}
        </button>
      `).join('')}
    </div>`;
}

function modalGalleryLoadingHtml() {
  return isModalGalleryLoading
    ? '<div class="modal-gallery-loading" aria-live="polite"><span></span> 추가 사진 확인 중...</div>'
    : '';
}

function modalNavigationHintsHtml() {
  return `
    <div class="modal-nav-hint modal-nav-hint-pc"><i class="fas fa-hand-pointer"></i> 클릭 시 다음 사진</div>
    <div class="modal-nav-hint modal-nav-hint-mobile"><i class="fas fa-arrows-alt-h"></i> 밀어서 사진 넘기기</div>`;
}

function refreshModalGalleryControls() {
  const wrapper = document.querySelector('.modal-gallery-wrapper');
  const mainBox = wrapper?.querySelector('.modal-main-image-box');
  if (!wrapper || !mainBox) return;

  const multiple = modalImages.length > 1;
  mainBox.classList.toggle('has-multiple', multiple);
  mainBox.querySelectorAll('.modal-nav-hint').forEach((hint) => hint.remove());
  if (multiple) mainBox.insertAdjacentHTML('beforeend', modalNavigationHintsHtml());

  const badge = document.getElementById('modalImgBadge');
  const current = modalImages[modalImageIndex];
  if (badge && current) badge.textContent = `${modalImageIndex + 1} / ${modalImages.length} (${current.listLabel || current.key})`;

  wrapper.querySelector('.modal-thumb-strip')?.remove();
  wrapper.querySelector('.modal-gallery-loading')?.remove();
  wrapper.insertAdjacentHTML('beforeend', modalThumbStripHtml(modalImages, modalImageIndex) + modalGalleryLoadingHtml());
  setupModalImageNavigation();
}

function renderModalContent(animal, index, kindTitle, stateText, noticePeriod) {
  const images = modalImages;
  const safeIndex = Math.min(modalImageIndex, Math.max(0, images.length - 1));
  modalImageIndex = safeIndex;

  let galleryHtml = '';
  if (images.length > 0) {
    const cur = images[safeIndex];
    galleryHtml = `
      <div class="modal-gallery-wrapper">
        <div class="modal-main-image-box${images.length > 1 ? ' has-multiple' : ''}">
          <img id="modalMainImg" class="is-preview" src="${cur.previewUrl || cur.thumbUrl || cur.url}" data-full-src="${cur.url}" alt="대표 사진" decoding="async" fetchpriority="high" onerror="handleImgError(this)" draggable="false">
          <span id="modalImgBadge" class="modal-img-badge">${safeIndex + 1} / ${images.length} (${cur.listLabel || cur.key})</span>
          ${images.length > 1 ? modalNavigationHintsHtml() : ''}
        </div>
        ${modalThumbStripHtml(images, safeIndex)}
        ${modalGalleryLoadingHtml()}
      </div>
    `;
  } else {
    galleryHtml = `<div class="modal-gallery-wrapper"><div class="modal-main-image-box"><img src="${PLACEHOLDER_SVG}" alt="사진 미등록"></div></div>`;
  }

  const badge = badgeFor(animal);
  const stateValue = animal.customStatus
    ? `<span style="font-weight:bold; color:${badge.color};">${badge.text}</span> <span class="state-api-sub">(시스템: ${escapeHtml(stateText)})</span>`
    : `<span style="font-weight:bold; color:${badge.color};">${stateText}</span>`;

  document.getElementById('modalBody').innerHTML = `
    ${galleryHtml}
    <div class="modal-detail">
      <div class="modal-title-row">
        <h2>${animal.noticeNo || '공고'} (${kindTitle})</h2>
        <div class="modal-title-actions">
          <button type="button" class="btn-share-link" onclick="copyDetailLink(${index})"><i class="fas fa-link"></i> 링크 복사</button>
          <button type="button" class="btn-share-link btn-share-sheet" onclick="shareDetail(${index})" aria-label="공유하기"><i class="fas fa-share-alt"></i> 공유</button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-item"><span class="label">보호 상태</span><span class="value">${stateValue}</span></div>
        <div class="detail-item"><span class="label">성별 / 중성화</span><span class="value">${getSexIcon(animal.sexCd)} / ${animal.neuterYn === 'Y' ? '중성화 완료' : '중성화 안됨'}</span></div>
        <div class="detail-item"><span class="label">나이 / 체중</span><span class="value">${animal.age || '미상'} / ${animal.weight || '미상'}</span></div>
        <div class="detail-item"><span class="label">털색</span><span class="value">${animal.colorCd || '미상'}</span></div>
        <div class="detail-item full"><span class="label">발견 장소</span><span class="value">${animal.happenPlace || '정보 없음'}</span></div>
        <div class="detail-item"><span class="label">접수일자</span><span class="value">${formatDate(animal.happenDt)}</span></div>
        <div class="detail-item"><span class="label">공고 기간</span><span class="value">${noticePeriod}</span></div>
        <div class="detail-item full"><span class="label">특징 및 건강상태</span><span class="value" style="background:#F0FDF4; padding:8px 10px; border-radius:6px; line-height:1.4;">${animal.specialMark || '특이사항 없음'}</span></div>
      </div>

      ${timelineHtml(animal, currentLogs)}

      <div class="shelter-info">
        <h3 class="shelter-title"><i class="fas fa-home"></i> 입양 문의처</h3>
        <div class="detail-grid shelter-grid">
          <div class="detail-item full"><span class="label">보호센터명</span><span class="value" style="font-weight:bold;">${animal.careNm || '강화군 동물보호센터'}</span></div>
          <div class="detail-item full"><span class="label">보호소 주소</span><span class="value">${animal.careAddr || '인천광역시 강화군'}</span></div>
          <div class="detail-item"><span class="label">전화번호</span><span class="value">${animal.careTel ? `<a href="tel:${animal.careTel}" style="color:#FF6B35; font-weight:bold; font-size:1.05rem;">📞 ${animal.careTel}</a>` : '정보 없음'}</span></div>
          <div class="detail-item"><span class="label">관할 부서</span><span class="value">${animal.orgNm || '강화군'} (${animal.officetel || animal.chargeNm || '문의'})</span></div>
        </div>

        <a href="https://www.instagram.com/ganghwa_animal_care/" target="_blank" rel="noopener noreferrer" class="insta-brand-link" title="인스타그램으로 이동">
          <span class="insta-logo-icon" aria-hidden="true"><img src="${SHELTER_LOGO_SRC}" alt="로고"></span>
          <span class="insta-brand-text">
            <span class="insta-brand-top"><i class="fab fa-instagram"></i> 인스타그램 방문하기</span>
            <strong class="insta-brand-id">ganghwa_animal_care</strong>
            <span class="insta-brand-name">강화유기동물보호센터</span>
          </span>
          <i class="fas fa-chevron-right insta-arrow"></i>
        </a>
      </div>
    </div>
  `;
  setupModalImageNavigation();
}

window.selectModalImage = function (idx) {
  if (typeof idx === 'number' && idx >= 0 && idx < modalImages.length) showModalImageByIndex(idx);
};

window.copyDetailLink = async function (index) {
  const animal = allAnimals[index];
  if (!animal) return;
  const url = getDetailShareUrl(animal);
  const btn = document.querySelector('.btn-share-link');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
    else {
      const ta = document.createElement('textarea'); ta.value = url; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    track('link_copy', getDesertionNo(animal));
    if (btn) { const prev = btn.innerHTML; btn.classList.add('copied'); btn.innerHTML = '<i class="fas fa-check"></i> 복사됨!'; setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('copied'); }, 1800); }
  } catch (_) { alert('링크: ' + url); }
};

// 모바일 공유 시트 (P1-4) — "카카오톡으로 보내기 / 문자로 보내기"가 바로 뜬다.
// 미지원 브라우저에서는 링크 복사로 동작한다.
window.shareDetail = async function (index) {
  const animal = allAnimals[index];
  if (!animal) return;
  const url = getDetailSharePageUrl(animal);
  const title = `${formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd)} 아이의 정보입니다`;

  if (navigator.share) {
    try {
      await navigator.share({ title: '보호중인 아이 정보입니다', text: title, url });
      track('link_share', getDesertionNo(animal));
    } catch (_) { /* 사용자가 공유를 취소한 경우 */ }
  } else {
    window.copyDetailLink(index); // 폴백: 클립보드 복사(링크_copy 로 집계)
  }
};

// 사용자가 직접 닫기(X·배경·ESC) — pushState 로 쌓은 항목은 뒤로가기로 정리한다.
// 그러면 popstate → closeModal 로 이어져 히스토리가 남지 않는다. (P0-3)
function requestCloseModal() {
  if (!isModalOpen) return;
  if (modalHistoryPushed) history.back();
  else closeModal();
}

function closeModal(options = {}) {
  document.getElementById('modal').style.display = 'none';
  document.body.style.overflow = '';
  isModalOpen = false;
  modalHistoryPushed = false;
  currentDetailIndex = -1;
  modalImages = [];
  modalImageIndex = 0;
  modalImageLoadToken++;
  pointerActive = false;
  pointerId = null;
  isModalGalleryLoading = false;
  currentLogs = null;
  if (!options.skipHashClear) {
    // /a/:id 로 들어와 자동으로 열렸던 경우: 닫으면 목록 주소로 돌아간다
    if (/^\/(a|p|s)(\/|$)/.test(window.location.pathname)) {
      history.replaceState(null, '', '/');
    } else {
      setDetailHash('');
    }
  }
}

function updateStats() {
  let dogs = 0, cats = 0, etc = 0;
  allAnimals.forEach(a => {
    const kind = a.kindFullNm || a.kindNm || a.kindCd || '';
    if (kind.includes('개')) dogs++;
    else if (kind.includes('고양이')) cats++;
    else etc++;
  });
  document.getElementById('totalCount').textContent = allAnimals.length;
  document.getElementById('dogCount').textContent = dogs;
  document.getElementById('catCount').textContent = cats;
  document.getElementById('etcCount').textContent = etc;
}

function showLoading(show) {
  document.getElementById('loading').style.display = show ? 'block' : 'none';
  if (show) { document.getElementById('animalGrid').innerHTML = ''; document.getElementById('noData').style.display = 'none'; }
}

function formatDate(d) {
  if (!d) return '미상';
  const s = String(d);
  return s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}` : s;
}

function formatKind(k) {
  if (!k) return '기타';
  return k.replace('[개]', '🐶 ').replace('[고양이]', '🐱 ').replace('[기타축종]', '🐾 ');
}

function getSexIcon(sex) {
  if (sex === 'M') return '♂ 수컷';
  if (sex === 'F') return '♀ 암컷';
  return '미상';
}
