// ==============================================================
// 🔐 관리자 페이지 — 보호소 상태 4단계 지정 + 케어 로그 CRUD
//    텍스트 전용: 사진 업로드 없음
// ==============================================================
const TOKEN_KEY = 'shelter_admin_token';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let animals = [];
let selected = null;      // 선택된 개체(API 데이터 + customStatus)
let record = null;        // { status, logs }
let recordRequest = 0;    // 이전 개체의 늦은 응답이 현재 선택을 되돌리지 않게 한다.
let editingLogId = null;  // 수정 중인 로그 id

// 표시 순서이기도 하다. none은 서버의 null, 기존 adopting은 상담중 그대로 호환.
const STATUS_LABEL = {
  none: '🏠 보호중', foster: '🏡 임시보호중', adopting: '🤝 입양상담중', confirmed: '✅ 입양확정'
};
const LOG_TYPES = {
  intake: '📍 입소', medical: '💉 치료', surgery: '🏥 수술', vaccine: '🛡️ 접종·예방',
  care: '🐾 케어·일상', foster: '🏡 임시보호', adopting: '🤝 입양 진행', confirmed: '✅ 입양확정', note: '📝 소식'
};

// ---------- 공통 ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {})
    }
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401) { token = ''; sessionStorage.removeItem(TOKEN_KEY); showLogin(); }
    throw new Error(data.error || '요청 실패');
  }
  return data;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function todayStr() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function getKey(a) {
  return String(a.desertionNo || a.desertionNO || a.noticeNo || '').trim();
}

function thumbUrl(a) {
  const p = a.popfile1 || a.popfile2 || a.popfile || '';
  if (!p) return '';
  // 관리자 목록 썸네일은 56px — w=160 으로 축소해 받으면 목록이 훨씬 빨라진다 (P0-4)
  return p.startsWith('/') ? p : `/api/image-proxy?url=${encodeURIComponent(p)}&w=160`;
}

function formatDate8(d) {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}` : s;
}

// ---------- 로그인/로그아웃 ----------
function showLogin() {
  document.getElementById('loginView').style.display = 'block';
  document.getElementById('adminView').style.display = 'none';
}

function showAdmin() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('adminView').style.display = 'block';
  loadAnimals();
  loadSyncStatus();
}

async function adminLogin() {
  const pw = document.getElementById('pw').value;
  const err = document.getElementById('loginErr');
  err.style.display = 'none';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인 실패');
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    showAdmin();
  } catch (e) {
    err.textContent = e.message;
    err.style.display = 'block';
  }
}

async function adminLogout() {
  try { await fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch (_) {}
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  showLogin();
}

// ---------- 개체 목록 ----------
function showSyncStatus(s) {
  const clock = s.syncedAt ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(s.syncedAt)) : '아직 없음';
  document.getElementById('syncInfo').textContent = `마지막 동기화 ${clock} · 크롤링 대상 ${s.crawlTargets ?? 0}마리` +
    (s.running ? ' · 동기화 중' : '') + (s.diskOK === false ? ' · 디스크 저장 실패' : '');
}
let syncingNow = false;
async function loadSyncStatus() {
  if (!token || syncingNow) return;
  try { showSyncStatus(await api('/api/admin/sync', {cache:'no-store'})); }
  catch (_) { document.getElementById('syncInfo').textContent = '동기화 상태를 확인할 수 없습니다.'; }
}
async function syncNow() {
  if (syncingNow) return;
  syncingNow = true;
  const btn = document.getElementById('syncNow');
  btn.disabled = true; btn.textContent = '동기화 중…';
  try {
    const result = await api('/api/admin/sync', {method:'POST', cache:'no-store'});
    showSyncStatus(result); await loadAnimals();
    toast(result.diskOK ? '동기화가 끝났습니다.' : '목록은 갱신됐지만 디스크에 저장하지 못했습니다.');
  } catch (e) { toast(e.message || '동기화하지 못했습니다.'); }
  finally { syncingNow = false; btn.disabled = false; btn.textContent = '지금 동기화'; loadSyncStatus(); }
}
setInterval(() => { if (!document.hidden && token) loadSyncStatus(); }, 60_000);
let adminListRequest = 0;
async function loadAnimals() {
  const request = ++adminListRequest;
  const listEl = document.getElementById('adminList');
  // 보호 상태·케어 기록 저장 직후에도 60초 된 HTTP 캐시 대신 최신 메모리 목록을 받는다.
  try {
    const data = await api('/api/admin/animals', {cache:'no-store'}); // QR 생성/자리 기록은 인증한 관리자에게만 제공
    if (request !== adminListRequest) return;
    animals = data.items || [];
  } catch (_) {
    if (request !== adminListRequest) return;
    if (!animals.length) listEl.textContent = '목록을 준비 중입니다. 잠시 후 다시 확인해 주세요.';
    return;
  }

  const headerHtml = `
    <div class="admin-list-header">
      <span><i class="fas fa-list"></i> 보호중 개체 <b>${animals.length}</b>마리</span>
      <button type="button" class="icon-btn edit" title="저장된 목록 다시 읽기" onclick="loadAnimals()"><i class="fas fa-sync-alt"></i></button>
    </div><div class="qr-batch-bar">
      <button type="button" id="qrBatch" class="btn-ghost" onclick="adminQr.batch()">공고 중 QR 미적용 일괄 받기 (ZIP)</button>
      <small>이 도구의 생성 기록 기준 · 한 번에 최대 20마리</small><small id="qrBatchStatus" role="status"></small>
    </div>`;

  if (!animals.length) {
    listEl.innerHTML = headerHtml + '<div class="admin-list-empty">API에서 보호중인 개체를 찾지 못했습니다.<br>우측 상단 새로고침 버튼을 눌러보세요.</div>';
    return;
  }

  listEl.innerHTML = headerHtml + animals.map((a) => {
    const st = Object.prototype.hasOwnProperty.call(STATUS_LABEL, a.customStatus) ? a.customStatus : 'none';
    return `
      <div class="admin-animal-item ${selected && getKey(selected) === getKey(a) ? 'selected' : ''}" data-key="${getKey(a)}" onclick="selectAnimalBy('${getKey(a)}')">
        <img src="${thumbUrl(a)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="admin-animal-meta">
          <div class="nm">${a.noticeNo || getKey(a)}</div>
          <div class="sub">${(a.kindFullNm || a.kindNm || '')} · ${a.happenPlace || ''}</div>
          <div class="sub">기록 ${a.logCount || 0}건</div>
        </div>
        ${a.qrMade ? `<span class="qr-tick" title="QR 사진 생성됨${a.qrSlot ? ` · KAWIS ${Number(a.qrSlot)}번` : ' · 업로드 자리 미입력'}">QR ✓</span>` : ''}
        <span class="status-dot ${st}">${STATUS_LABEL[st]}</span>
      </div>`;
  }).join('');
  window.adminQr?.refresh();
}

function selectAnimalBy(key) {
  const a = animals.find((x) => getKey(x) === key);
  if (a) selectAnimal(a);
}

async function selectAnimal(a) {
  selected = a;
  record = null;
  editingLogId = null;
  document.querySelectorAll('.admin-animal-item').forEach((el) =>
    el.classList.toggle('selected', el.dataset.key === getKey(a))
  );
  renderPanel({ loading: true });
  try {
    await refreshRecord();
  } catch (e) {
    if (selected !== a) return;
    record = { status: a.customStatus, logs: [] };
    toast('기록 조회 실패: ' + e.message);
    renderPanel();
  }
}

// ---------- 편집 패널 ----------
function renderPanel(opt = {}) {
  const panel = document.getElementById('adminPanel');
  if (!selected) {
    panel.innerHTML = '<p style="color:#94A3B8; font-size:0.9rem;">왼쪽에서 개체를 선택하세요.</p>';
    return;
  }
  const a = selected;
  // 최신 기록의 null(보호중)은 유효한 값. 예전 목록의 임보/상담 상태로 덮지 않는다.
  const statusKey = (record ? record.status : a.customStatus) || 'none';
  const logs = opt.loading ? null : (record?.logs || []);

  panel.innerHTML = `
    <h2>${a.noticeNo || getKey(a)} <small style="color:#94A3B8; font-weight:400;">${a.kindFullNm || ''} ${a.colorCd || ''} ${a.age || ''}</small></h2>

    <h3 id="statusHeading">① 현재 상태 지정</h3>
    <div class="radio-row" id="statusRadios" role="radiogroup" aria-labelledby="statusHeading" aria-describedby="statusHint">
      ${Object.entries(STATUS_LABEL).map(([key, label]) => `
        <label class="radio-pill ${key}">
          <input type="radio" name="customStatus" value="${key}" ${statusKey === key ? 'checked' : ''} ${opt.loading ? 'disabled' : ''}>
          <span>${label}</span>
        </label>`).join('')}
    </div>
    <p class="admin-hint" id="statusHint">상태가 바뀔 때만 케어 기록에 한 줄 남습니다. 입양확정을 선택해도 공공데이터의 공고 상태는 바뀌지 않습니다.</p>
    <div style="margin-top:10px;">
      <button type="button" class="btn-primary" onclick="saveStatus(this)" ${opt.loading ? 'disabled' : ''}><i class="fas fa-save"></i> 상태 저장</button>
    </div>

    <h3>② 케어 기록 ${opt.loading ? '<i class="fas fa-circle-notch fa-spin" style="font-size:0.8rem;"></i>' : `(${(logs || []).length}건)`}</h3>
    <div id="adminLogList">
      ${opt.loading ? '<p class="admin-hint">불러오는 중...</p>' : renderLogList(logs || [])}
    </div>

    <h3>${editingLogId ? '✏️ 기록 수정 중' : '③ 새 기록 추가'}</h3>
    <p class="admin-hint">케어 기록은 공개됩니다. 담당자·신청자의 이름이나 연락처 등 개인정보는 입력하지 마세요.</p>
    <div class="admin-field">
      <label>날짜 *</label>
      <input type="date" id="logDate" value="${todayStr()}">
    </div>
    <div class="admin-field">
      <label>종류</label>
      <select id="logType">
        ${Object.entries(LOG_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
    </div>
    <div class="admin-field">
      <label>제목 *</label>
      <input type="text" id="logTitle" maxlength="120" placeholder="예) 피부병 재검 — 호전">
    </div>
    <div class="admin-field">
      <label>상세 내용</label>
      <textarea id="logContent" maxlength="2000" placeholder="치료 내용, 경과, 임보 소식 등을 자유롭게 적어주세요."></textarea>
    </div>
    <div style="display:flex; gap:8px;">
      <button class="btn-primary" onclick="submitLog()">${editingLogId ? '수정 저장' : '<i class="fas fa-plus"></i> 기록 추가'}</button>
      ${editingLogId ? '<button class="btn-ghost" onclick="cancelEdit()">수정 취소</button>' : ''}
    </div>
    <section id="qrSection" aria-labelledby="qrHeading"></section>
  `;
  window.adminQr?.refresh();
}

function renderLogList(logs) {
  if (!logs.length) return '<p class="admin-hint">아직 등록된 기록이 없습니다. 아래에서 첫 기록을 추가해 보세요.</p>';
  return logs.map((l) => `
    <div class="admin-log-item">
      <div class="meta">
        <div class="d">${formatDate8(l.date)} · ${LOG_TYPES[l.type] || l.type}</div>
        <div class="t">${l.title}</div>
        ${l.content ? `<div class="c">${l.content}</div>` : ''}
      </div>
      <div class="admin-log-actions">
        <button class="icon-btn edit" title="수정" onclick="startEditLog('${l.id}')"><i class="fas fa-pen"></i></button>
        <button class="icon-btn" title="삭제" onclick="deleteLog('${l.id}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

// ---------- 상태 저장 ----------
async function saveStatus(button) {
  const animal = selected, input = document.querySelector('#statusRadios input:checked');
  if (!animal || !input || input.disabled || button.disabled) return;
  const val = input.value;
  const status = val === 'none' ? null : val;
  button.disabled = true;
  try {
    await api(`/api/admin/animals/${encodeURIComponent(getKey(animal))}/status`, {
      method: 'PUT', body: JSON.stringify({ status })
    });
    toast(`상태 저장: ${STATUS_LABEL[val]}`);
    logsCacheBust();
    await Promise.all([loadAnimals(), selected === animal && refreshRecord()]);
  } catch (e) {
    toast('실패: ' + e.message);
  } finally { button.disabled = false; }
}

// ---------- 로그 추가/수정/삭제 ----------
async function submitLog() {
  const date = document.getElementById('logDate').value.replace(/-/g, '');
  const type = document.getElementById('logType').value;
  const title = document.getElementById('logTitle').value.trim();
  const content = document.getElementById('logContent').value.trim();

  if (!date || !title) { toast('날짜와 제목은 필수입니다.'); return; }

  const body = JSON.stringify({ date, type, title, content });
  try {
    if (editingLogId) {
      await api(`/api/admin/animals/${encodeURIComponent(getKey(selected))}/logs/${editingLogId}`, { method: 'PUT', body });
      toast('기록이 수정되었습니다.');
    } else {
      await api(`/api/admin/animals/${encodeURIComponent(getKey(selected))}/logs`, { method: 'POST', body });
      toast('기록이 추가되었습니다.');
    }
    editingLogId = null;
    logsCacheBust();
    await Promise.all([loadAnimals(), refreshRecord()]);
  } catch (e) {
    toast('실패: ' + e.message);
  }
}

function startEditLog(logId) {
  const l = (record?.logs || []).find((x) => x.id === logId);
  if (!l) { toast('기록을 찾을 수 없습니다.'); return; }
  editingLogId = l.id;
  renderPanel();
  document.getElementById('logDate').value = String(l.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  document.getElementById('logType').value = LOG_TYPES[l.type] ? l.type : 'note';
  document.getElementById('logTitle').value = l.title || '';
  document.getElementById('logContent').value = l.content || '';
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function cancelEdit() {
  editingLogId = null;
  renderPanel();
}

async function deleteLog(logId) {
  if (!confirm('이 기록을 삭제할까요?')) return;
  try {
    await api(`/api/admin/animals/${encodeURIComponent(getKey(selected))}/logs/${logId}`, { method: 'DELETE' });
    toast('삭제되었습니다.');
    logsCacheBust();
    await Promise.all([loadAnimals(), refreshRecord()]);
  } catch (e) {
    toast('실패: ' + e.message);
  }
}

// ---------- 새로고침 헬퍼 ----------
function logsCacheBust() {
  try { sessionStorage.setItem('shelter_logs_bust', String(Date.now())); } catch (_) {}
}

async function refreshRecord() {
  if (!selected) return;
  const n = ++recordRequest;
  try {
    const next = await api(`/api/animals/${encodeURIComponent(getKey(selected))}/logs`, { cache: 'no-store' });
    if (n !== recordRequest) return;
    record = next;
    renderPanel();
  } catch (e) { if (n === recordRequest) throw e; }
}

// ==============================================================
// 📈 이용 통계 탭 — /api/admin/stats 집계를 표·그래프로 보여준다
//    외부 차트 라이브러리 없이 CSS/SVG 로만 그린다(오프라인·내부망 대비).
// ==============================================================
let statsDays = 7;
let statsData = null;
let statsLoaded = false;

function switchTab(name) {
  const care = name === 'care';
  document.getElementById('tabCare').style.display = care ? 'grid' : 'none';
  document.getElementById('tabStats').style.display = care ? 'none' : 'block';
  document.getElementById('tabBtnCare').classList.toggle('active', care);
  document.getElementById('tabBtnStats').classList.toggle('active', !care);
  document.getElementById('adminTitle').textContent =
    care ? '🐕 개체 상태 · 케어 기록 관리' : '📈 이용 통계';
  try { sessionStorage.setItem('shelter_admin_tab', name); } catch (_) {}
  if (!care && !statsLoaded) loadStats();
}

function setStatsDays(days) {
  statsDays = days;
  document.querySelectorAll('#statsRange .range-pill').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.days) === days)
  );
  loadStats();
}

async function loadStats(force = false) {
  const body = document.getElementById('statsBody');
  body.innerHTML = '<div class="admin-list-empty"><i class="fas fa-circle-notch fa-spin"></i> 통계를 불러오는 중...</div>';
  try {
    const qs = new URLSearchParams({ days: String(statsDays) });
    if (force) qs.set('refresh', '1');
    statsData = await api(`/api/admin/stats?${qs}`);
    statsLoaded = true;
    renderStats(statsData);
  } catch (e) {
    body.innerHTML = `<div class="admin-list-empty">통계를 불러오지 못했습니다.<br><b>${escapeHtml(e.message)}</b></div>`;
  }
}

function downloadStatsCsv() {
  // 인증 헤더가 필요하므로 fetch 로 받아 Blob 으로 저장한다
  fetch(`/api/admin/stats/export.csv?days=${statsDays}`, { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => { if (!r.ok) throw new Error('다운로드 실패'); return r.blob(); })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `carelink-stats-${statsDays}d.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('CSV를 내려받았습니다.');
    })
    .catch((e) => toast('실패: ' + e.message));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}

function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${String(s % 60).padStart(2, '0')}초`;
}

function statThumb(t) {
  if (!t) return '';
  return t.startsWith('/') ? t : `/api/image-proxy?url=${encodeURIComponent(t)}&w=160`;
}

function renderStats(s) {
  const t = s.totals;
  document.getElementById('statsMeta').textContent =
    `${s.range.from} ~ ${s.range.to} · ${s.storage === 'mongodb' ? 'DB' : '파일'} 집계`;

  const cards = [
    { icon: '👀', label: '상세 열람', value: fmtNum(t.detail_open), sub: `개체 ${fmtNum(t.animals_viewed)}마리 노출` },
    { icon: '🔗', label: '링크 유입', value: fmtNum(s.source.link), sub: `목록 탐색 ${fmtNum(s.source.list)}건` },
    { icon: '🤝', label: '입양 문의', value: fmtNum(t.adopt_inquiry), sub: `열람 대비 ${pctOf(t.adopt_inquiry, t.detail_open)}%` },
    { icon: '📤', label: '공유 · 복사', value: fmtNum(t.share), sub: `사진 탐색 ${fmtNum(t.photo_swipe)}회` },
    { icon: '⏱️', label: '평균 체류', value: fmtDuration(t.avg_dwell_sec), sub: `누적 ${fmtDuration(t.total_dwell_sec)}` },
    { icon: '📄', label: '페이지 조회', value: fmtNum(t.page_view), sub: `전체 이벤트 ${fmtNum(t.events)}건` }
  ];

  document.getElementById('statsBody').innerHTML = `
    <div class="stat-cards">
      ${cards.map((c) => `
        <div class="stat-card">
          <div class="stat-ico">${c.icon}</div>
          <div class="stat-label">${c.label}</div>
          <div class="stat-value">${c.value}</div>
          <div class="stat-sub">${c.sub}</div>
        </div>`).join('')}
    </div>

    <div class="stats-grid">
      <div class="stats-box">
        <h3><i class="fas fa-chart-column"></i> 일별 추이</h3>
        ${renderTrend(s.series)}
        <div class="chart-legend">
          <span><i class="dot a"></i> 상세 열람</span>
          <span><i class="dot b"></i> 입양 문의</span>
          <span><i class="dot c"></i> 공유·복사</span>
        </div>
      </div>

      <div class="stats-box">
        <h3><i class="fas fa-filter"></i> 전환 퍼널</h3>
        ${renderFunnel(s.funnel)}
        ${s.shareMetric ? `<p class="admin-hint">공유·복사 ${fmtNum(s.shareMetric.value)}건 — 열람 100건당 ${s.shareMetric.per100}건 (중복 발생 가능해 퍼널에서 제외)</p>` : ''}
        <h3 style="margin-top:18px;"><i class="fas fa-route"></i> 유입 경로</h3>
        ${renderSource(s.source)}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stats-box">
        <h3><i class="fas fa-fire"></i> 관심 많은 개체 TOP</h3>
        ${renderTopAnimals(s.topAnimals)}
      </div>
      <div class="stats-box">
        <h3><i class="fas fa-snowflake"></i> 노출이 적은 개체 (홍보 필요)</h3>
        ${renderColdAnimals(s.coldAnimals)}
        <h3 style="margin-top:18px;"><i class="fas fa-sliders"></i> 많이 쓰인 필터</h3>
        ${renderFilters(s.topFilters)}
      </div>
    </div>

    <p class="admin-hint">
      ※ 새 이용 통계는 방문자 식별자 없이 일별 합계로만 저장합니다. 이전 버전의 통계는 읽기 전용으로 합산합니다.
      ${s.fromCache ? ' · 1분 캐시된 결과' : ''}
    </p>
  `;
}

function pctOf(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

// --- 일별 막대그래프 (열람/문의/공유 3계열) ---
function renderTrend(series) {
  if (!series.length) return '<p class="admin-hint">데이터가 없습니다.</p>';
  const max = Math.max(1, ...series.map((d) => Math.max(d.detail_open, d.adopt_inquiry, d.share)));
  // 30일이 넘어가면 라벨이 겹치므로 5일 간격으로만 찍는다
  const step = series.length > 14 ? Math.ceil(series.length / 8) : 1;
  return `
    <div class="bar-chart" style="--max:${max}">
      ${series.map((d, i) => `
        <div class="bar-col" title="${d.date} · 열람 ${d.detail_open} / 문의 ${d.adopt_inquiry} / 공유 ${d.share}">
          <div class="bars">
            <i class="a" style="height:${(d.detail_open / max) * 100}%"></i>
            <i class="b" style="height:${(d.adopt_inquiry / max) * 100}%"></i>
            <i class="c" style="height:${(d.share / max) * 100}%"></i>
          </div>
          <span class="xlabel">${i % step === 0 ? d.date.slice(5).replace('-', '/') : ''}</span>
        </div>`).join('')}
    </div>`;
}

// --- 퍼널: 상세열람 100% 기준 가로 막대 ---
function renderFunnel(funnel) {
  if (!funnel.length) return '<p class="admin-hint">데이터가 없습니다.</p>';
  return `<div class="funnel">
    ${funnel.map((f) => `
      <div class="funnel-row">
        <span class="fl">${f.label}</span>
        <span class="fbar"><i style="width:${Math.min(100, f.rate)}%"></i></span>
        <span class="fv">${fmtNum(f.value)} <b>${f.rate}%</b></span>
      </div>`).join('')}
  </div>`;
}

function renderSource(src) {
  const total = (src.link || 0) + (src.list || 0);
  if (!total) return '<p class="admin-hint">데이터가 없습니다.</p>';
  const linkPct = pctOf(src.link, total);
  return `
    <div class="source-bar">
      <i class="s-link" style="width:${linkPct}%"></i>
      <i class="s-list" style="width:${100 - linkPct}%"></i>
    </div>
    <div class="chart-legend">
      <span><i class="dot a"></i> 공유 링크 ${fmtNum(src.link)}건 (${linkPct}%)</span>
      <span><i class="dot d"></i> 목록 탐색 ${fmtNum(src.list)}건</span>
    </div>`;
}

function renderTopAnimals(rows) {
  if (!rows.length) return '<p class="admin-hint">아직 열람 기록이 없습니다.</p>';
  return `<table class="stats-table">
    <thead><tr><th>개체</th><th>열람</th><th>문의</th><th>공유</th><th>평균체류</th></tr></thead>
    <tbody>
      ${rows.map((r) => `
        <tr onclick="gotoAnimal('${escapeHtml(r.id)}')" title="클릭하면 케어 기록 화면으로 이동">
          <td class="a-cell">
            ${r.thumb ? `<img src="${statThumb(r.thumb)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="no-thumb">🐾</span>'}
            <span class="a-meta">
              <b>${escapeHtml(r.noticeNo || r.id)}</b>
              <em>${escapeHtml(r.kind || '')}${r.customStatus ? ' · ' + STATUS_LABEL[r.customStatus] : ''}</em>
            </span>
          </td>
          <td><b>${fmtNum(r.detail_open)}</b></td>
          <td>${fmtNum(r.adopt_inquiry)}${r.inquiry_rate ? `<em class="rate">${r.inquiry_rate}%</em>` : ''}</td>
          <td>${fmtNum(r.share)}</td>
          <td>${r.avg_dwell_sec ? fmtDuration(r.avg_dwell_sec) : '-'}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderColdAnimals(rows) {
  if (!rows.length) return '<p class="admin-hint">보호중 개체 정보를 불러오지 못했습니다.</p>';
  return `<div class="cold-list">
    ${rows.map((r) => `
      <div class="cold-item" onclick="gotoAnimal('${escapeHtml(r.id)}')">
        ${r.thumb ? `<img src="${statThumb(r.thumb)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="no-thumb">🐾</span>'}
        <span class="c-meta">
          <b>${escapeHtml(r.noticeNo || r.id)}</b>
          <em>${escapeHtml(r.kind || '')}</em>
        </span>
        <span class="cold-count ${r.detail_open === 0 ? 'zero' : ''}">${fmtNum(r.detail_open)}회</span>
      </div>`).join('')}
  </div>`;
}

function renderFilters(rows) {
  if (!rows.length) return '<p class="admin-hint">필터 사용 기록이 없습니다.</p>';
  const max = Math.max(...rows.map((r) => r.count));
  return `<div class="funnel">
    ${rows.map((r) => `
      <div class="funnel-row">
        <span class="fl">${escapeHtml(r.label)}</span>
        <span class="fbar"><i style="width:${(r.count / max) * 100}%"></i></span>
        <span class="fv">${fmtNum(r.count)}</span>
      </div>`).join('')}
  </div>`;
}

// 통계 표에서 개체를 클릭하면 케어 기록 탭으로 이동해 바로 선택한다
function gotoAnimal(key) {
  switchTab('care');
  const a = animals.find((x) => getKey(x) === key);
  if (a) {
    selectAnimal(a);
    const esc = window.CSS?.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
    const el = document.querySelector(`.admin-animal-item[data-key="${esc}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } else {
    toast('보호중 목록에 없는 개체입니다(공고 종료 등).');
  }
}

// 버전 조회는 공개 API이므로 관리자 토큰을 보내지 않는다.
// 네트워크 오류 시에도 HTML에 표시된 이 페이지의 배포 버전은 남겨 둔다.
async function showAssetVersion() {
  const label = document.getElementById('adminVersion');
  if (!label) return;
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (typeof version === 'string' && version) label.textContent = `버전 ${version}`;
  } catch (_) { /* 로그인·통계 화면의 동작과는 무관 */ }
}

// ---------- 시작 ----------
showAssetVersion();
if (token) {
  showAdmin();
  // 새로고침해도 보던 탭을 유지한다
  try {
    if (sessionStorage.getItem('shelter_admin_tab') === 'stats') switchTab('stats');
  } catch (_) {}
} else showLogin();
