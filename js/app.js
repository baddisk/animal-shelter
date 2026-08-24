/* ==============================================================
   🐾 강화군 동물보호센터 – 프론트엔드 (태그 깨짐 해결판)
   ============================================================== */

const API_BASE = '/api';
const ITEMS_PER_PAGE = 20;

let allAnimals = [];
let currentPage = 1;
let totalPages = 1;

// 💡 큰따옴표 충돌 없는 안전한 Base64 SVG 이미지
const PLACEHOLDER_SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMzAwIiB2aWV3Qm94PSIwIDAgNDAwIDMwMCI+PHJlY3Qgd2lkdGg9IjQwMCIgaGVpZ2h0PSIzMDAiIGZpbGw9IiNGMUY1RjkiLz48dGV4dCB4PSI1MCUiIHk9IjQ1JSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIzNiI+8J+QvTwvdGV4dD48dGV4dCB4PSI1MCUiIHk9IjY1JSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzY0NzQ4QiIgZm9udC1zaXplPSIxNCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIj7sgqzsp4Qg7KSA67mE7KSRPC90ZXh0Pjwvc3ZnPg==';

// ==============================================================
// 초기화
// ==============================================================
document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  document.getElementById('endde').value = formatDateInput(now);
  document.getElementById('bgnde').value = formatDateInput(
    new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  );

  // 이벤트 연결
  document.getElementById('searchBtn').addEventListener('click', () => { currentPage = 1; searchAnimals(); });
  document.getElementById('upkind').addEventListener('change',   () => { currentPage = 1; searchAnimals(); });
  document.getElementById('bgnde').addEventListener('change',    () => { currentPage = 1; searchAnimals(); });
  document.getElementById('endde').addEventListener('change',    () => { currentPage = 1; searchAnimals(); });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  window.addEventListener('hashchange', handleHash);

  searchAnimals();
});

// ==============================================================
// 유틸 함수
// ==============================================================
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDate(d) {
  if (!d) return '미상';
  const s = String(d);
  return s.length === 8 ? `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6,8)}` : s;
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

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==============================================================
// 이미지 URL 추출
// ==============================================================
function extractAllImages(animal) {
  if (!animal) return [];
  const list = [];
  const seen = new Set();

  for (let i = 1; i <= 10; i++) {
    const val = animal[`popfile${i}`] || animal[`popFile${i}`];
    if (val && typeof val === 'string' && val.trim().startsWith('http')) {
      const raw = val.trim();
      if (!seen.has(raw)) {
        seen.add(raw);
        list.push({
          num: i,
          key: `popfile${i}`,
          url: `${API_BASE}/image-proxy?url=${encodeURIComponent(raw)}`,
          rawUrl: raw
        });
      }
    }
  }

  for (const gk of ['popfile', 'popFile', 'filename', 'fileName']) {
    const val = animal[gk];
    if (val && typeof val === 'string' && val.trim().startsWith('http')) {
      const raw = val.trim();
      if (!seen.has(raw)) {
        seen.add(raw);
        list.push({
          num: list.length + 1,
          key: gk,
          url: `${API_BASE}/image-proxy?url=${encodeURIComponent(raw)}`,
          rawUrl: raw
        });
      }
    }
  }

  return list;
}

function getThumbnailUrl(animal) {
  const imgs = extractAllImages(animal);
  return imgs.length > 0 ? imgs[0].url : PLACEHOLDER_SVG;
}

// ==============================================================
// 데이터 조회
// ==============================================================
async function searchAnimals() {
  showLoading(true);

  const params = new URLSearchParams();
  const bgnde = document.getElementById('bgnde').value;
  const endde = document.getElementById('endde').value;
  const upkind = document.getElementById('upkind').value;
  if (bgnde)  params.append('bgnde', bgnde);
  if (endde)  params.append('endde', endde);
  if (upkind) params.append('upkind', upkind);

  try {
    const resp = await fetch(`${API_BASE}/animals?${params}`);
    const result = await resp.json();

    allAnimals = result.items || [];
    totalPages = Math.ceil(allAnimals.length / ITEMS_PER_PAGE) || 1;

    renderPage();
    renderPagination();
    updateStats();

    handleHash();
  } catch (err) {
    console.error('데이터 조회 실패:', err);
    allAnimals = [];
    renderPage();
  }

  showLoading(false);
}

// ==============================================================
// URL 해시 라우팅 (#detail/공고번호)
// ==============================================================
function handleHash() {
  const hash = window.location.hash;
  if (!hash.startsWith('#detail/')) return;

  const noticeNo = decodeURIComponent(hash.replace('#detail/', ''));
  if (!noticeNo) return;

  const idx = allAnimals.findIndex(a => a.noticeNo === noticeNo || a.desertionNo === noticeNo);
  if (idx !== -1) {
    showDetail(idx);
  } else {
    fetchSingleAnimal(noticeNo);
  }
}

async function fetchSingleAnimal(noticeNo) {
  try {
    const resp = await fetch(`${API_BASE}/animal/${encodeURIComponent(noticeNo)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && (data.noticeNo || data.desertionNo)) {
      allAnimals.push(data);
      showDetail(allAnimals.length - 1);
    }
  } catch (e) {
    console.warn('단건 조회 실패:', e);
  }
}

function setDetailHash(noticeNo) {
  history.pushState(null, '', `#detail/${encodeURIComponent(noticeNo || '')}`);
}

function clearDetailHash() {
  history.pushState(null, '', window.location.pathname + window.location.search);
}

// ==============================================================
// 카드 목록 렌더링
// ==============================================================
function renderPage() {
  const grid = document.getElementById('animalGrid');
  const noData = document.getElementById('noData');

  if (allAnimals.length === 0) {
    grid.innerHTML = '';
    noData.style.display = 'block';
    return;
  }
  noData.style.display = 'none';

  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = allAnimals.slice(start, start + ITEMS_PER_PAGE);

  grid.innerHTML = pageItems.map((animal, i) => {
    const idx = start + i;
    const kindText = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);
    const sexNeuter = `${getSexIcon(animal.sexCd)} / ${animal.neuterYn === 'Y' ? '중성화O' : '중성화X'}`;
    const happenDt = formatDate(animal.happenDt);
    const thumbUrl = getThumbnailUrl(animal);
    const stateText  = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
    const stateClass = (animal.processState || '').includes('공고') ? 'badge-notice' : 'badge-protect';
    const imgCount = extractAllImages(animal).length;

    return `
      <div class="animal-card" onclick="showDetail(${idx})">
        <div class="card-image">
          <img class="lazy-img"
               src="${PLACEHOLDER_SVG}"
               data-src="${thumbUrl}"
               alt="${escapeHtml(kindText)}"
               onerror="this.onerror=null; this.src='${PLACEHOLDER_SVG}';">
          <span class="card-badge ${stateClass}">${stateText}</span>
          <span class="card-kind">${escapeHtml(kindText)}</span>
          ${imgCount > 1 ? `<span class="photo-count-badge"><i class="fas fa-camera"></i> ${imgCount}장</span>` : ''}
        </div>
        <div class="card-body">
          <h3>${escapeHtml(animal.noticeNo || '공고번호 미상')}</h3>
          <div class="card-info">
            <div class="card-info-item"><i class="fas fa-map-marker-alt"></i><span>${escapeHtml(animal.happenPlace || '강화군 일대')}</span></div>
            <div class="card-info-item"><i class="fas fa-palette"></i><span>${escapeHtml(animal.colorCd || '색상미상')} · ${escapeHtml(animal.age || '나이미상')}</span></div>
            <div class="card-info-item"><i class="fas fa-venus-mars"></i><span>${sexNeuter}</span></div>
          </div>
        </div>
        <div class="card-footer">
          <span class="card-date"><i class="far fa-calendar-alt"></i> ${happenDt}</span>
          <button class="btn-detail">상세보기</button>
        </div>
      </div>`;
  }).join('');

  observeLazyImages();
}

// ==============================================================
// Intersection Observer – 이미지 지연 로딩
// ==============================================================
let lazyObserver = null;

function observeLazyImages() {
  if (lazyObserver) lazyObserver.disconnect();

  lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        lazyObserver.unobserve(img);
      }
    });
  }, { rootMargin: '150px' });

  document.querySelectorAll('.lazy-img[data-src]').forEach(img => lazyObserver.observe(img));
}

// ==============================================================
// 🎯 상세 모달 (갤러리 + 공유 기능)
// ==============================================================
function showDetail(index) {
  const animal = allAnimals[index];
  if (!animal) return;

  const noticeNo = animal.noticeNo || animal.desertionNo || '';
  setDetailHash(noticeNo);

  const stateText = (animal.processState || '').includes('공고') ? '📢 공고중' : '🏠 보호중';
  const images = extractAllImages(animal);
  const kindTitle = formatKind(animal.kindFullNm || animal.kindNm || animal.kindCd);

  const noticePeriod = (animal.noticeSdt && animal.noticeEdt)
    ? `${formatDate(animal.noticeSdt)} ~ ${formatDate(animal.noticeEdt)}`
    : '정보 없음';

  const shareUrl = `${window.location.origin}${window.location.pathname}#detail/${encodeURIComponent(noticeNo)}`;

  let galleryHtml = '';
  if (images.length > 0) {
    galleryHtml = `
      <div class="modal-gallery-wrapper">
        <div class="modal-main-image-box">
          <img id="modalMainImg"
               src="${images[0].url}"
               alt="대표 사진"
               onerror="this.onerror=null; this.src='${PLACEHOLDER_SVG}';">
          <span id="modalImgBadge" class="modal-img-badge">1 / ${images.length} (popfile1)</span>
        </div>
        ${images.length > 1 ? `
          <div class="modal-thumb-strip">
            ${images.map((img, i) => `
              <button type="button"
                      class="modal-thumb-btn ${i === 0 ? 'active' : ''}"
                      onclick="selectModalImage('${img.url}', '${i + 1} / ${images.length} (${img.key})', this)">
                <img src="${img.url}" alt="사진${i+1}" onerror="this.onerror=null; this.src='${PLACEHOLDER_SVG}';">
                <span class="thumb-num">${i + 1}</span>
              </button>
            `).join('')}
          </div>` : ''}
      </div>`;
  } else {
    galleryHtml = `<div class="modal-main-image-box"><img src="${PLACEHOLDER_SVG}" alt="사진 미등록"></div>`;
  }

  const rawJson = JSON.stringify(animal, null, 2);

  document.getElementById('modalBody').innerHTML = `
    ${galleryHtml}

    <div class="modal-detail">
      <h2>${escapeHtml(noticeNo || '공고')} (${escapeHtml(kindTitle)})</h2>

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
          <span class="value">${escapeHtml(animal.age || '미상')} / ${escapeHtml(animal.weight || '미상')}</span>
        </div>
        <div class="detail-item">
          <span class="label">털색</span>
          <span class="value">${escapeHtml(animal.colorCd || '미상')}</span>
        </div>
        <div class="detail-item full">
          <span class="label">발견 장소</span>
          <span class="value">${escapeHtml(animal.happenPlace || '정보 없음')}</span>
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
          <span class="value" style="background:#F0FDF4; padding:8px 10px; border-radius:6px; line-height:1.4;">${escapeHtml(animal.specialMark || '특이사항 없음')}</span>
        </div>
      </div>

      <div class="shelter-info">
        <h3><i class="fas fa-home"></i> 입양 문의처</h3>
        <div class="detail-grid">
          <div class="detail-item full">
            <span class="label">보호센터명</span>
            <span class="value" style="font-weight:bold;">${escapeHtml(animal.careNm || '강화군 동물보호센터')}</span>
          </div>
          <div class="detail-item full">
            <span class="label">보호소 주소</span>
            <span class="value">${escapeHtml(animal.careAddr || '인천광역시 강화군')}</span>
          </div>
          <div class="detail-item">
            <span class="label">전화번호</span>
            <span class="value">
              ${animal.careTel ? `<a href="tel:${animal.careTel}" style="color:#FF6B35; font-weight:bold; font-size:1.05rem;">📞 ${escapeHtml(animal.careTel)}</a>` : '정보 없음'}
            </span>
          </div>
          <div class="detail-item">
            <span class="label">관할 부서</span>
            <span class="value">${escapeHtml(animal.orgNm || '강화군')} (${escapeHtml(animal.officetel || animal.chargeNm || '문의')})</span>
          </div>
        </div>
      </div>

      <!-- 🔗 공유 버튼 -->
      <div class="share-bar">
        <button class="btn-share link-copy" onclick="copyShareLink('${shareUrl}')">
          <i class="fas fa-link"></i> 링크 복사
        </button>
        <button class="btn-share twitter" onclick="shareTwitter('${shareUrl}', '${escapeHtml(kindTitle)}')">
          <i class="fab fa-twitter"></i> 트위터 공유
        </button>
        <button class="btn-share" onclick="shareKakao('${shareUrl}', '${escapeHtml(kindTitle)}')">
          <i class="fas fa-comment"></i> 카카오톡 공유
        </button>
      </div>

      <!-- JSON 원본 토글 -->
      <div class="raw-data-section">
        <button type="button" class="btn-toggle-raw" onclick="toggleRawData()">
          <i class="fas fa-code"></i> 공공데이터 원본 데이터(JSON) 확인 ▾
        </button>
        <div id="rawJsonBox" class="raw-json-box" style="display:none;">
          <pre><code>${escapeHtml(rawJson)}</code></pre>
        </div>
      </div>
    </div>`;

  document.getElementById('modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

// ==============================================================
// 공유 기능
// ==============================================================
window.copyShareLink = function(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 링크가 복사되었습니다!');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('📋 링크가 복사되었습니다!');
  });
};

window.shareTwitter = function(url, title) {
  const text = `🐾 ${title} - 강화군 동물보호센터에서 가족을 기다리고 있어요!`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
};

window.shareKakao = function(url, title) {
  const text = `🐾 ${title} - 강화군 동물보호센터에서 가족을 기다리고 있어요!\n${url}`;
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) {
    window.location.href = `kakaotalk://msg/text/send?text=${encodeURIComponent(text)}`;
    setTimeout(() => { copyShareLink(url); }, 1500);
  } else {
    copyShareLink(url);
    showToast('💬 PC에서는 링크가 복사되었습니다. 카카오톡에 붙여넣어 공유하세요!');
  }
};

function showToast(msg) {
  let toast = document.querySelector('.share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'share-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ==============================================================
// 모달 유틸
// ==============================================================
window.selectModalImage = function(imgUrl, badgeText, btn) {
  const mainImg = document.getElementById('modalMainImg');
  const badge   = document.getElementById('modalImgBadge');
  if (mainImg) mainImg.src = imgUrl;
  if (badge)   badge.textContent = badgeText;
  document.querySelectorAll('.modal-thumb-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
};

window.toggleRawData = function() {
  const box = document.getElementById('rawJsonBox');
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
};

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  document.body.style.overflow = '';
  clearDetailHash();
}

// ==============================================================
// 페이지네이션
// ==============================================================
function renderPagination() {
  const el = document.getElementById('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 1) {
    html += `<button class="page-btn" onclick="goToPage(1)" title="처음"><i class="fas fa-angle-double-left"></i></button>`;
    html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
  }

  const start = Math.max(1, currentPage - 2);
  const end   = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (currentPage < totalPages) {
    html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
    html += `<button class="page-btn" onclick="goToPage(${totalPages})" title="마지막"><i class="fas fa-angle-double-right"></i></button>`;
  }

  el.innerHTML = html;
}

window.goToPage = function(page) {
  currentPage = page;
  renderPage();
  renderPagination();
  window.scrollTo({ top: 180, behavior: 'smooth' });
};

// ==============================================================
// 통계
// ==============================================================
function updateStats() {
  let dogs = 0, cats = 0, etc = 0;
  allAnimals.forEach(a => {
    const k = a.kindFullNm || a.kindNm || a.kindCd || '';
    if (k.includes('개'))        dogs++;
    else if (k.includes('고양이')) cats++;
    else                         etc++;
  });
  document.getElementById('totalCount').textContent = allAnimals.length;
  document.getElementById('dogCount').textContent   = dogs;
  document.getElementById('catCount').textContent   = cats;
  document.getElementById('etcCount').textContent   = etc;
}

// ==============================================================
// 로딩 UI
// ==============================================================
function showLoading(show) {
  document.getElementById('loading').style.display = show ? 'block' : 'none';
  if (show) {
    document.getElementById('animalGrid').innerHTML = '';
    document.getElementById('noData').style.display = 'none';
  }
}
