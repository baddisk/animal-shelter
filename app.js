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
let extraImagesCache = new Map();   // key -> { t: 시각, images: [] }
const EXTRA_IMAGES_TTL = 30 * 60 * 1000; // 30분 (서버 detailImageCache TTL 과 동일)
let currentDetailIndex = -1;
let currentLogs = null;            // 상세 모달의 케어 로그 (null = 로딩중)
const logsCache = new Map();

let pointerStartX = 0;
let pointerStartY = 0;
let pointerDeltaX = 0;
let pointerDeltaY = 0;
let pointerActive = false;
let swipeLocked = null;

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

// 로컬 경로(/img, /uploads)는 프록시 없이, 절대 URL은 이미지 프록시로
function photoSrc(p) {
  const s = String(p || '');
  return s.startsWith('/') ? s : `${API_BASE}/image-proxy?url=${encodeURIComponent(s)}`;
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

  pendingDetailId = parseDetailHash();
  searchAnimals(false);

  document.getElementById('searchBtn').addEventListener('click', () => {
    currentPage = 1;
    searchAnimals(true);
  });
  
  ['upkind', 'bgnde', 'endde'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      currentPage = 1;
      searchAnimals(false);
    });
  });

  setupStatsFilterEvents();
  setupStatusFilterEvents();
  setupInfiniteScroll();
  setupTopButton();

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (isModalOpen && modalImages.length > 1) {
      if (e.key === 'ArrowRight') showModalImageByIndex(modalImageIndex + 1);
      if (e.key === 'ArrowLeft') showModalImageByIndex(modalImageIndex - 1);
    }
  });
  
  window.addEventListener('hashchange', handleHashChange);
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
// 🔗 딥링크
// ==============================================================
function getShareId(animalOrNoticeNo) {
  const raw = typeof animalOrNoticeNo === 'string' ? animalOrNoticeNo : String(animalOrNoticeNo?.noticeNo || '');
  let id = raw.trim().replace(/[가-힣]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = id.match(/(\d{4}-\d+)/);
  if (m) return m[1];
  return id;
}

function getDetailShareUrl(animal) {
  const id = getShareId(animal);
  if (!id) return window.location.origin + window.location.pathname;
  return `${window.location.origin}${window.location.pathname}#detail/${id}`;
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

function openDetailByShareId(shareId) {
  if (!shareId) return false;
  const target = String(shareId).trim().toLowerCase();
  const idx = allAnimals.findIndex(a => {
    const id = getShareId(a).toLowerCase();
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
  showDetail(idx);
  return true;
}

function handleHashChange() {
  const id = parseDetailHash();
  if (id) {
    if (allAnimals.length === 0) pendingDetailId = id;
    else openDetailByShareId(id);
  } else if (isModalOpen) {
    closeModal({ skipHashClear: true });
  }
}

async function searchAnimals(forceRefresh = false) {
  showLoading(true);
  if (forceRefresh) setSearchBtnLoading(true);

  const bgnde = document.getElementById('bgnde').value;
  const endde = document.getElementById('endde').value;
  const upkind = document.getElementById('upkind').value;
  const params = new URLSearchParams({ bgnde, endde, upkind });
  if (forceRefresh) params.append('refresh', '1');

  try {
    const response = await fetch(`${API_BASE}/animals?${params}`, {
      cache: forceRefresh ? 'no-store' : 'default'
    });
    const result = await response.json();
    
    allAnimals = result.items || [];
    currentStatsFilter = 'all';
    currentStatusFilter = 'all';
    currentPage = 1;
    
    updateStatsActiveCard();
    const chips = document.getElementById('statusFilter');
    if (chips) chips.querySelectorAll('.status-chip').forEach((c) => c.classList.toggle('active', c.dataset.status === 'all'));
    renderPage(false);
    updateStats();
    updateStatusChips();
    
    if (pendingDetailId) {
      openDetailByShareId(pendingDetailId);
      pendingDetailId = null;
    }
    if (forceRefresh) extraImagesCache.clear();
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
    
    let proxied = null;
    if (/^https?:\/\//i.test(cleanUrl)) {
      proxied = `${API_BASE}/image-proxy?url=${encodeURIComponent(cleanUrl)}`;
    } else if (cleanUrl.startsWith('/')) {
      proxied = cleanUrl; // 데모/로컬 업로드 이미지
    }
    if (!proxied) return;
    
    list.push({
      key,
      url: proxied,
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
    merged.push({
      num: merged.length + 1,
      key: `crawl${idx + 1}`,
      url: photoSrc(clean),
      rawUrl: clean,
      filename: fn,
      isExtra: true,
      listLabel: `크롤링${crawlNo}`
    });
  });

  return merged.slice(0, MAX_GALLERY_IMAGES).map((img, i) => ({ ...img, num: i + 1 }));
}

async function fetchExtraImages(desertionNo, forceRefresh = false) {
  if (!desertionNo) return [];
  const key = String(desertionNo);

  // ✅ 수정 1: extraImagesCache 가 "쓰기만 있고 읽기가 없어" 죽은 캐시였다.
  //    → 상세 모달을 열 때마다 매번 서버 크롤링을 새로 일으켰다.
  //    (서버에서 개체당 HTML 3~4회 + f_seq 프로브 최대 12회 = 약 16 아웃바운드 요청)
  if (!forceRefresh) {
    const cached = extraImagesCache.get(key);
    if (cached && Date.now() - cached.t < EXTRA_IMAGES_TTL) return cached.images;
  }

  // ✅ 수정 2: refresh=1 을 "항상" 붙이지 않는다.
  //    서버의 30분 크롤링 캐시를 살려야 같은 개체를 다시 열 때 즉시 표시된다.
  //    사용자가 명시적으로 재시도할 때만 forceRefresh=true 로 호출한다.
  const q = new URLSearchParams({ desertionNo: key });
  if (forceRefresh) q.append('refresh', '1');

  try {
    const response = await fetch(`${API_BASE}/detail-images?${q}`, { cache: 'no-store' });
    const result = await response.json();
    const images = Array.isArray(result.images) ? result.images : [];
    extraImagesCache.set(key, { t: Date.now(), images });
    return images;
  } catch (err) {
    return [];
  }
}

function getThumbnailUrl(animal) {
  const images = extractAllImages(animal);
  return images.length > 0 ? images[0].url : PLACEHOLDER_SVG;
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
    const imgSrc = getThumbnailUrl(animal);
    const badge = badgeFor(animal);
    const logCount = animal.logCount || 0;
    const mngSuffix = getDesertionNo(animal).slice(-5); // 관리번호 뒷자리 5자리

    return `
      <div class="animal-card" onclick="showDetail(${realIndex})">
        <div class="card-image">
          <img src="${imgSrc}" alt="${kindText}" loading="lazy" onerror="handleImgError(this)">
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
  if (modalImages.length <= 1) { mainBox.classList.remove('has-multiple'); mainBox.style.touchAction = ''; return; }

  mainBox.classList.add('has-multiple');
  mainBox.style.touchAction = 'none';

  const fresh = mainBox.cloneNode(true);
  mainBox.parentNode.replaceChild(fresh, mainBox);
  const imgEl = fresh.querySelector('img'); if (imgEl) imgEl.id = 'modalMainImg';
  const badgeEl = fresh.querySelector('.modal-img-badge'); if (badgeEl) badgeEl.id = 'modalImgBadge';

  fresh.addEventListener('click', (e) => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && Math.abs(pointerDeltaX) <= 10) {
      e.preventDefault(); showModalImageByIndex(modalImageIndex + 1);
    }
  });

  fresh.addEventListener('pointerdown', onGalleryPointerDown);
  fresh.addEventListener('pointermove', onGalleryPointerMove);
  fresh.addEventListener('pointerup', onGalleryPointerUp);
  fresh.addEventListener('pointercancel', onGalleryPointerUp);
}

function onGalleryPointerDown(e) {
  if (modalImages.length <= 1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pointerActive = true; swipeLocked = null; pointerStartX = e.clientX; pointerStartY = e.clientY; pointerDeltaX = 0; pointerDeltaY = 0;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  e.currentTarget.classList.add('is-swiping');
}

function onGalleryPointerMove(e) {
  if (!pointerActive) return;
  pointerDeltaX = e.clientX - pointerStartX; pointerDeltaY = e.clientY - pointerStartY;
  if (!swipeLocked && (Math.abs(pointerDeltaX) > 8 || Math.abs(pointerDeltaY) > 8)) swipeLocked = Math.abs(pointerDeltaX) > Math.abs(pointerDeltaY) ? 'h' : 'v';
  
  if (swipeLocked === 'h') {
    e.preventDefault();
    const img = document.getElementById('modalMainImg');
    if (img) { img.style.transition = 'none'; img.style.transform = `translateX(${pointerDeltaX * 0.35}px)`; }
  }
}

function onGalleryPointerUp(e) {
  if (!pointerActive) return;
  pointerActive = false;
  e.currentTarget.classList.remove('is-swiping');
  
  const img = document.getElementById('modalMainImg');
  if (img) { img.style.transition = 'transform 0.2s ease'; img.style.transform = ''; }

  const horizontal = swipeLocked === 'h' || Math.abs(pointerDeltaX) > Math.abs(pointerDeltaY);
  if (horizontal && Math.abs(pointerDeltaX) >= 40) {
    if (pointerDeltaX < 0) showModalImageByIndex(modalImageIndex + 1);
    else showModalImageByIndex(modalImageIndex - 1);
  }
  setTimeout(() => { pointerDeltaX = 0; pointerDeltaY = 0; swipeLocked = null; }, 50);
  try { if (e.pointerId != null) e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
}

function showModalImageByIndex(index) {
  if (!modalImages.length) return;
  modalImageIndex = ((index % modalImages.length) + modalImages.length) % modalImages.length;
  const imgData = modalImages[modalImageIndex];
  const mainImg = document.getElementById('modalMainImg');
  const badge = document.getElementById('modalImgBadge');

  if (mainImg) { mainImg.dataset.fallback = ''; mainImg.style.transition = 'none'; mainImg.style.transform = ''; mainImg.onerror = function () { handleImgError(mainImg); }; mainImg.src = imgData.url; }
  if (badge) badge.textContent = `${modalImageIndex + 1} / ${modalImages.length} (${imgData.listLabel || imgData.key})`;

  document.querySelectorAll('.modal-thumb-btn').forEach((btn, i) => btn.classList.toggle('active', i === modalImageIndex));
  const activeThumb = document.querySelector('.modal-thumb-btn.active');
  if (activeThumb && activeThumb.scrollIntoView) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
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
// ==============================================================
async function showDetail(index) {
  const animal = allAnimals[index];
  if (!animal) return;

  currentDetailIndex = index;

  const stateText = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
  const baseImages = extractAllImages(animal);
  const kindTitle = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
  const shareId = getShareId(animal);
  const desertionNo = getDesertionNo(animal);

  modalImages = mergeAllImagesSmart(baseImages, []);
  modalImageIndex = 0; pointerActive = false; swipeLocked = null; pointerDeltaX = 0;
  currentLogs = null;

  const noticePeriod = (animal.noticeSdt && animal.noticeEdt) ? `${formatDate(animal.noticeSdt)} ~ ${formatDate(animal.noticeEdt)}` : '정보 없음';

  renderModalContent(animal, index, kindTitle, stateText, noticePeriod);
  document.getElementById('modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  isModalOpen = true;
  if (shareId) setDetailHash(shareId);

  if (desertionNo) {
    const [extraUrls, logs] = await Promise.all([
      fetchExtraImages(desertionNo),
      fetchAnimalLogs(desertionNo)
    ]);

    if (!isModalOpen || currentDetailIndex !== index) return;

    const merged = mergeAllImagesSmart(baseImages, extraUrls);

    modalImages = merged;
    modalImageIndex = 0;
    currentLogs = logs;

    renderModalContent(animal, index, kindTitle, stateText, noticePeriod);
  }
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
          <img id="modalMainImg" src="${cur.url}" alt="대표 사진" onerror="handleImgError(this)" draggable="false">
          <span id="modalImgBadge" class="modal-img-badge">${safeIndex + 1} / ${images.length} (${cur.listLabel || cur.key})</span>
          ${images.length > 1 ? `
            <div class="modal-nav-hint modal-nav-hint-pc"><i class="fas fa-hand-pointer"></i> 클릭 시 다음 사진</div>
            <div class="modal-nav-hint modal-nav-hint-mobile"><i class="fas fa-arrows-alt-h"></i> 밀어서 사진 넘기기</div>
          ` : ''}
        </div>
        ${images.length > 1 ? `
          <div class="modal-thumb-strip">
            ${images.map((img, i) => `
              <button type="button"
                class="modal-thumb-btn ${i === safeIndex ? 'active' : ''} ${img.isExtra ? 'is-extra' : 'is-origin'}"
                onclick="event.stopPropagation(); selectModalImage(${i})"
                title="${img.listLabel || img.key}">
                <img src="${img.url}" alt="${i + 1}" onerror="handleImgError(this)" draggable="false">
                <span class="thumb-num">${i + 1}</span>
                ${img.isExtra ? '<span class="thumb-extra-badge">C</span>' : '<span class="thumb-origin-badge">J</span>'}
              </button>
            `).join('')}
          </div>
        ` : ''}
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
        <button type="button" class="btn-share-link" onclick="copyDetailLink(${index})"><i class="fas fa-link"></i> 링크 복사</button>
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
    if (btn) { const prev = btn.innerHTML; btn.classList.add('copied'); btn.innerHTML = '<i class="fas fa-check"></i> 복사됨!'; setTimeout(() => { btn.innerHTML = prev; }, 1800); }
  } catch (_) { alert('링크: ' + url); }
};

function closeModal(options = {}) {
  document.getElementById('modal').style.display = 'none';
  document.body.style.overflow = '';
  isModalOpen = false;
  currentDetailIndex = -1;
  modalImages = [];
  modalImageIndex = 0;
  pointerActive = false;
  currentLogs = null;
  if (!options.skipHashClear) setDetailHash('');
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
