const API_BASE = '/api';
const ITEMS_PER_PAGE = 20;

let allAnimals = [];
let currentStatsFilter = 'all';
let currentPage = 1;
let totalPages = 1;
let pendingDetailId = null;
let isModalOpen = false;

// 🎯 HTML 속성에 안전하게 넣도록 encodeURIComponent 사용 (따옴표 깨짐 방지)
const PLACEHOLDER_SVG = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
    <rect width="400" height="300" fill="#e2e8f0"/>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" font-size="36">🐾</text>
    <text x="50%" y="65%" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-size="14" font-weight="bold" font-family="sans-serif">사진 준비중</text>
  </svg>`
);

const SHELTER_LOGO_SRC = 'logo.svg';

// 🎯 onerror 를 HTML 인라인에 SVG를 넣지 않고 JS로 처리 (텍스트 누수 방지)
window.handleImgError = function (img) {
  if (!img || img.dataset.fallback === '1') return;
  img.dataset.fallback = '1';
  img.onerror = null;
  img.src = PLACEHOLDER_SVG;
};

document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  const endStr = formatDateToYMD(now);
  const oneYearBefore = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const bgnStr = formatDateToYMD(oneYearBefore);

  document.getElementById('endde').value = endStr;
  document.getElementById('bgnde').value = bgnStr;

  pendingDetailId = parseDetailHash();

  searchAnimals();

  document.getElementById('searchBtn').addEventListener('click', () => {
    currentPage = 1;
    searchAnimals();
  });
  document.getElementById('upkind').addEventListener('change', () => {
    currentPage = 1;
    searchAnimals();
  });
  document.getElementById('bgnde').addEventListener('change', () => {
    currentPage = 1;
    searchAnimals();
  });
  document.getElementById('endde').addEventListener('change', () => {
    currentPage = 1;
    searchAnimals();
  });

  setupStatsFilterEvents();

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  window.addEventListener('hashchange', handleHashChange);
});

function formatDateToYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ==============================================================
// 🔗 딥링크 / 공유 URL
// ==============================================================
function getShareId(animalOrNoticeNo) {
  const raw = typeof animalOrNoticeNo === 'string'
    ? animalOrNoticeNo
    : String(animalOrNoticeNo?.noticeNo || '');

  let id = raw.trim();
  if (!id) return '';

  id = id.replace(/[가-힣]+/g, '');
  id = id.replace(/-+/g, '-').replace(/^-|-$/g, '');

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
  const hash = window.location.hash || '';
  const m = hash.match(/^#detail\/([^/?#]+)/i);
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

  if (next) {
    history.replaceState(null, '', next);
  } else {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function findAnimalIndexByShareId(shareId) {
  if (!shareId) return -1;
  const target = String(shareId).trim().toLowerCase();
  return allAnimals.findIndex(a => {
    const id = getShareId(a).toLowerCase();
    if (!id) return false;
    return id === target || id.endsWith(target) || target.endsWith(id);
  });
}

function openDetailByShareId(shareId) {
  if (!shareId) return false;
  const idx = findAnimalIndexByShareId(shareId);
  if (idx < 0) return false;

  const filtered = getFilteredAnimals();
  const animal = allAnimals[idx];
  const filteredIndex = filtered.indexOf(animal);
  if (filteredIndex >= 0) {
    currentPage = Math.floor(filteredIndex / ITEMS_PER_PAGE) + 1;
    renderPage();
    renderPagination();
  }

  showDetail(idx, { fromHash: true });
  return true;
}

function handleHashChange() {
  const id = parseDetailHash();
  if (id) {
    if (allAnimals.length === 0) {
      pendingDetailId = id;
      return;
    }
    const opened = openDetailByShareId(id);
    if (!opened) console.warn('딥링크 공고를 찾을 수 없습니다:', id);
  } else if (isModalOpen) {
    closeModal({ skipHashClear: true });
  }
}

function tryOpenPendingDetail() {
  if (!pendingDetailId) return;
  const id = pendingDetailId;
  pendingDetailId = null;
  const opened = openDetailByShareId(id);
  if (!opened) console.warn('공유 링크 동물을 목록에서 찾지 못했습니다:', id);
}

async function searchAnimals() {
  showLoading(true);

  const bgnde = document.getElementById('bgnde').value;
  const endde = document.getElementById('endde').value;
  const upkind = document.getElementById('upkind').value;

  const params = new URLSearchParams();
  if (bgnde) params.append('bgnde', bgnde);
  if (endde) params.append('endde', endde);
  if (upkind) params.append('upkind', upkind);

  try {
    const response = await fetch(`${API_BASE}/animals?${params}`);
    const result = await response.json();

    allAnimals = result.items || [];
    currentStatsFilter = 'all';
    updateStatsActiveCard();

    renderPage();
    renderPagination();
    updateStats();

    tryOpenPendingDetail();
  } catch (error) {
    console.error('데이터 조회 실패:', error);
    allAnimals = [];
    renderPage();
  }

  showLoading(false);
}

function getFilteredAnimals() {
  if (currentStatsFilter === 'all') return allAnimals;
  return allAnimals.filter(animal => {
    const kind = animal.kindFullNm || animal.kindNm || animal.kindCd || '';
    if (currentStatsFilter === 'dog') return kind.includes('개');
    if (currentStatsFilter === 'cat') return kind.includes('고양이');
    if (currentStatsFilter === 'etc') return !kind.includes('개') && !kind.includes('고양이');
    return true;
  });
}

function setupStatsFilterEvents() {
  const totalCard = document.querySelector('.stat-card.total');
  const dogCard = document.querySelector('.stat-card.dog');
  const catCard = document.querySelector('.stat-card.cat');
  const etcCard = document.querySelector('.stat-card.etc');

  if (totalCard) totalCard.addEventListener('click', () => handleStatsFilterChange('all'));
  if (dogCard) dogCard.addEventListener('click', () => handleStatsFilterChange('dog'));
  if (catCard) catCard.addEventListener('click', () => handleStatsFilterChange('cat'));
  if (etcCard) etcCard.addEventListener('click', () => handleStatsFilterChange('etc'));
}

function handleStatsFilterChange(filterType) {
  currentStatsFilter = filterType;
  currentPage = 1;
  updateStatsActiveCard();
  renderPage();
  renderPagination();
}

function updateStatsActiveCard() {
  document.querySelectorAll('.stat-card').forEach(card => card.classList.remove('active'));

  let targetSelector = '.stat-card.total';
  if (currentStatsFilter === 'dog') targetSelector = '.stat-card.dog';
  else if (currentStatsFilter === 'cat') targetSelector = '.stat-card.cat';
  else if (currentStatsFilter === 'etc') targetSelector = '.stat-card.etc';

  const activeCard = document.querySelector(targetSelector);
  if (activeCard) activeCard.classList.add('active');
}

function extractAllImages(animal) {
  if (!animal) return [];

  const list = [];
  const seen = new Set();

  for (let i = 1; i <= 10; i++) {
    const key = `popfile${i}`;
    const val = animal[key] || animal[`popFile${i}`];
    if (val && typeof val === 'string' && val.trim().startsWith('http')) {
      const cleanUrl = val.trim();
      if (!seen.has(cleanUrl)) {
        seen.add(cleanUrl);
        list.push({
          num: i,
          key: key,
          url: `${API_BASE}/image-proxy?url=${encodeURIComponent(cleanUrl)}`,
          rawUrl: cleanUrl
        });
      }
    }
  }

  const generalKeys = ['popfile', 'popFile', 'filename', 'fileName'];
  for (const gk of generalKeys) {
    const val = animal[gk];
    if (val && typeof val === 'string' && val.trim().startsWith('http')) {
      const cleanUrl = val.trim();
      if (!seen.has(cleanUrl)) {
        seen.add(cleanUrl);
        list.push({
          num: list.length + 1,
          key: gk,
          url: `${API_BASE}/image-proxy?url=${encodeURIComponent(cleanUrl)}`,
          rawUrl: cleanUrl
        });
      }
    }
  }

  return list;
}

function getThumbnailUrl(animal) {
  const images = extractAllImages(animal);
  return images.length > 0 ? images[0].url : PLACEHOLDER_SVG;
}

function renderPage() {
  const grid = document.getElementById('animalGrid');
  const noData = document.getElementById('noData');

  const filtered = getFilteredAnimals();

  if (filtered.length === 0) {
    grid.innerHTML = '';
    noData.style.display = 'block';
    return;
  }

  noData.style.display = 'none';

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  grid.innerHTML = pageItems.map((animal) => {
    const realIndex = allAnimals.indexOf(animal);
    const kindText = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
    const sexNeuter = `${getSexIcon(animal.sexCd)} / ${animal.neuterYn === 'Y' ? '중성화O' : '중성화X'}`;
    const happenDt = formatDate(animal.happenDt);
    const imgSrc = getThumbnailUrl(animal);
    const stateText = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
    const stateClass = (animal.processState || '').includes('공고') ? 'badge-notice' : 'badge-protect';
    const imgCount = extractAllImages(animal).length;

    return `
      <div class="animal-card" onclick="showDetail(${realIndex})">
        <div class="card-image">
          <img src="${imgSrc}" 
               alt="${kindText}" 
               loading="lazy"
               onerror="handleImgError(this)">
          <span class="card-badge ${stateClass}">${stateText}</span>
          <span class="card-kind">${kindText}</span>
          ${imgCount > 1 ? `<span class="photo-count-badge"><i class="fas fa-camera"></i> ${imgCount}장</span>` : ''}
        </div>
        <div class="card-body">
          <h3>${animal.noticeNo || '공고번호 미상'}</h3>
          <div class="card-info">
            <div class="card-info-item">
              <i class="fas fa-map-marker-alt"></i>
              <span>${animal.happenPlace || '강화군 일대'}</span>
            </div>
            <div class="card-info-item">
              <i class="fas fa-palette"></i>
              <span>${animal.colorCd || '색상미상'} · ${animal.age || '나이미상'}</span>
            </div>
            <div class="card-info-item">
              <i class="fas fa-venus-mars"></i>
              <span>${sexNeuter}</span>
            </div>
          </div>
        </div>
        <div class="card-footer">
          <span class="card-date"><i class="far fa-calendar-alt"></i> ${happenDt}</span>
          <button class="btn-detail">상세보기</button>
        </div>
      </div>
    `;
  }).join('');
}

function showDetail(index, options = {}) {
  const animal = allAnimals[index];
  if (!animal) return;

  const stateText = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
  const images = extractAllImages(animal);
  const kindTitle = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
  const shareId = getShareId(animal);

  const noticePeriod = (animal.noticeSdt && animal.noticeEdt)
    ? `${formatDate(animal.noticeSdt)} ~ ${formatDate(animal.noticeEdt)}`
    : '정보 없음';

  let galleryHtml = '';
  if (images.length > 0) {
    galleryHtml = `
      <div class="modal-gallery-wrapper">
        <div class="modal-main-image-box">
          <img id="modalMainImg" 
               src="${images[0].url}" 
               alt="대표 사진" 
               onerror="handleImgError(this)">
          <span id="modalImgBadge" class="modal-img-badge">1 / ${images.length} (popfile1)</span>
        </div>

        ${images.length > 1 ? `
          <div class="modal-thumb-strip">
            ${images.map((img, i) => `
              <button type="button" 
                      class="modal-thumb-btn ${i === 0 ? 'active' : ''}" 
                      onclick="selectModalImage('${img.url}', '${i + 1} / ${images.length} (${img.key})', this)">
                <img src="${img.url}" alt="사진 ${i + 1}" onerror="handleImgError(this)">
                <span class="thumb-num">${i + 1}</span>
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  } else {
    galleryHtml = `
      <div class="modal-gallery-wrapper">
        <div class="modal-main-image-box">
          <img src="${PLACEHOLDER_SVG}" alt="사진 미등록">
        </div>
      </div>
    `;
  }

  const rawJsonString = JSON.stringify(animal, null, 2);

  document.getElementById('modalBody').innerHTML = `
    ${galleryHtml}

    <div class="modal-detail">
      <div class="modal-title-row">
        <h2>${animal.noticeNo || '공고'} (${kindTitle})</h2>
        <button type="button" class="btn-share-link" onclick="copyDetailLink(${index})" title="상세 링크 복사">
          <i class="fas fa-link"></i> 링크 복사
        </button>
      </div>

      <div class="detail-grid">
        <div class="detail-item">
          <span class="label">보호 상태</span>
          <span class="value" style="font-weight:bold; color:#10B981;">${stateText}</span>
        </div>
        <div class="detail-item">
          <span class="label">성별 / 중성화</span>
          <span class="value">${getSexIcon(animal.sexCd)} / ${animal.neuterYn === 'Y' ? '중성화 완료' : '중성화 안됨'}</span>
        </div>
        <div class="detail-item">
          <span class="label">나이 / 체중</span>
          <span class="value">${animal.age || '미상'} / ${animal.weight || '미상'}</span>
        </div>
        <div class="detail-item">
          <span class="label">털색</span>
          <span class="value">${animal.colorCd || '미상'}</span>
        </div>
        <div class="detail-item full">
          <span class="label">발견 장소</span>
          <span class="value">${animal.happenPlace || '정보 없음'}</span>
        </div>
        <div class="detail-item">
          <span class="label">접수일자</span>
          <span class="value">${formatDate(animal.happenDt)}</span>
        </div>
        <div class="detail-item">
          <span class="label">공고 기간</span>
          <span class="value">${noticePeriod}</span>
        </div>
        <div class="detail-item full">
          <span class="label">특징 및 건강상태</span>
          <span class="value" style="background:#F0FDF4; padding:8px 10px; border-radius:6px; line-height:1.4;">${animal.specialMark || '특이사항 없음'}</span>
        </div>
      </div>

      <div class="shelter-info">
        <h3 class="shelter-title"><i class="fas fa-home"></i> 입양 문의처</h3>

        <div class="detail-grid shelter-grid">
          <div class="detail-item full">
            <span class="label">보호센터명</span>
            <span class="value" style="font-weight:bold;">${animal.careNm || '강화군 동물보호센터'}</span>
          </div>
          <div class="detail-item full">
            <span class="label">보호소 주소</span>
            <span class="value">${animal.careAddr || '인천광역시 강화군'}</span>
          </div>
          <div class="detail-item">
            <span class="label">전화번호</span>
            <span class="value">
              ${animal.careTel ? `<a href="tel:${animal.careTel}" style="color:#FF6B35; font-weight:bold; font-size:1.05rem;">📞 ${animal.careTel}</a>` : '정보 없음'}
            </span>
          </div>
          <div class="detail-item">
            <span class="label">관할 부서</span>
            <span class="value">${animal.orgNm || '강화군'} (${animal.officetel || animal.chargeNm || '문의'})</span>
          </div>
        </div>

        <a href="https://www.instagram.com/ganghwa_animal_care/" target="_blank" rel="noopener noreferrer" class="insta-brand-link" title="인스타그램으로 이동">
          <span class="insta-logo-icon" aria-hidden="true">
            <img src="${SHELTER_LOGO_SRC}" alt="강화군유기동물보호센터 로고" width="72" height="72">
          </span>
          <span class="insta-brand-text">
            <span class="insta-brand-top">
              <i class="fab fa-instagram"></i> 인스타그램 방문하기
            </span>
            <strong class="insta-brand-id">ganghwa_animal_care</strong>
            <span class="insta-brand-name">강화유기동물보호센터</span>
          </span>
          <i class="fas fa-chevron-right insta-arrow"></i>
        </a>
      </div>

      <div class="raw-data-section">
        <button type="button" class="btn-toggle-raw" onclick="toggleRawData()">
          <i class="fas fa-code"></i> 공공데이터 원본 데이터(JSON) 확인 ▾
        </button>
        <div id="rawJsonBox" class="raw-json-box" style="display:none;">
          <pre><code>${escapeHtml(rawJsonString)}</code></pre>
        </div>
      </div>

    </div>
  `;

  document.getElementById('modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  isModalOpen = true;

  if (shareId) setDetailHash(shareId);
}

window.copyDetailLink = async function (index) {
  const animal = allAnimals[index];
  if (!animal) return;

  const url = getDetailShareUrl(animal);
  const btn = document.querySelector('.btn-share-link');

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    if (btn) {
      const prev = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = '<i class="fas fa-check"></i> 복사됨!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = prev;
      }, 1800);
    }
  } catch (err) {
    console.error('링크 복사 실패:', err);
    prompt('아래 링크를 복사하세요:', url);
  }
};

window.selectModalImage = function (imgUrl, badgeText, btnElement) {
  const mainImg = document.getElementById('modalMainImg');
  const badge = document.getElementById('modalImgBadge');
  if (mainImg) {
    mainImg.dataset.fallback = '';
    mainImg.onerror = function () { handleImgError(mainImg); };
    mainImg.src = imgUrl;
  }
  if (badge) badge.textContent = badgeText;

  document.querySelectorAll('.modal-thumb-btn').forEach(b => b.classList.remove('active'));
  if (btnElement) btnElement.classList.add('active');
};

window.toggleRawData = function () {
  const box = document.getElementById('rawJsonBox');
  if (box) {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function closeModal(options = {}) {
  document.getElementById('modal').style.display = 'none';
  document.body.style.overflow = '';
  isModalOpen = false;

  if (!options.skipHashClear) {
    setDetailHash('');
  }
}

function renderPagination() {
  const pagination = document.getElementById('pagination');
  const filtered = getFilteredAnimals();
  totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE) || 1;

  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }

  let html = '';
  if (currentPage > 1) {
    html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
  }

  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (currentPage < totalPages) {
    html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
  }

  pagination.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  renderPage();
  renderPagination();
  window.scrollTo({ top: 180, behavior: 'smooth' });
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
  if (show) {
    document.getElementById('animalGrid').innerHTML = '';
    document.getElementById('noData').style.display = 'none';
  }
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
