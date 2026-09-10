// ==============================================================
// 🔐 관리자 페이지 — 상태 지정(임시보호/입양진행중) + 케어 로그 CRUD
//    텍스트 전용: 사진 업로드 없음
// ==============================================================
const TOKEN_KEY = 'shelter_admin_token';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let animals = [];
let selected = null;      // 선택된 개체(API 데이터 + customStatus)
let record = null;        // { status, logs }
let editingLogId = null;  // 수정 중인 로그 id

const STATUS_LABEL = { foster: '🏡 임시보호중', adopting: '🤝 입양진행중', none: '⭕ 지정 안 함' };
const LOG_TYPES = {
  intake: '📍 입소', medical: '💉 치료', surgery: '🏥 수술', vaccine: '🛡️ 접종·예방',
  care: '🐾 케어·일상', foster: '🏡 임시보호', adopting: '🤝 입양 진행', note: '📝 소식'
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
  return p.startsWith('/') ? p : `/api/image-proxy?url=${encodeURIComponent(p)}`;
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
async function loadAnimals() {
  const listEl = document.getElementById('adminList');
  listEl.innerHTML = '<div class="admin-list-empty"><i class="fas fa-circle-notch fa-spin"></i> 개체 목록 불러오는 중...</div>';

  // 조회기간을 넉넉하게(최근 2년) 명시 지정 → 기본 기간 조회로 인한 목록 누락 방지
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const qs = new URLSearchParams({
    refresh: '1',
    bgnde: ymd(new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())),
    endde: ymd(now)
  });

  try {
    const res = await fetch(`/api/animals?${qs}`);
    const data = await res.json();
    animals = data.items || [];
  } catch (_) {
    animals = [];
  }

  const headerHtml = `
    <div class="admin-list-header">
      <span><i class="fas fa-list"></i> 보호중 개체 <b>${animals.length}</b>마리</span>
      <button type="button" class="icon-btn edit" title="목록 새로고침" onclick="loadAnimals()"><i class="fas fa-sync-alt"></i></button>
    </div>`;

  if (!animals.length) {
    listEl.innerHTML = headerHtml + '<div class="admin-list-empty">API에서 보호중인 개체를 찾지 못했습니다.<br>우측 상단 새로고침 버튼을 눌러보세요.</div>';
    return;
  }

  listEl.innerHTML = headerHtml + animals.map((a) => {
    const st = a.customStatus || 'none';
    return `
      <div class="admin-animal-item ${selected && getKey(selected) === getKey(a) ? 'selected' : ''}" data-key="${getKey(a)}" onclick="selectAnimalBy('${getKey(a)}')">
        <img src="${thumbUrl(a)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="admin-animal-meta">
          <div class="nm">${a.noticeNo || getKey(a)}</div>
          <div class="sub">${(a.kindFullNm || a.kindNm || '')} · ${a.happenPlace || ''}</div>
          <div class="sub">기록 ${a.logCount || 0}건</div>
        </div>
        <span class="status-dot ${st}">${st === 'none' ? '보호중' : STATUS_LABEL[st]}</span>
      </div>`;
  }).join('');
}

function selectAnimalBy(key) {
  const a = animals.find((x) => getKey(x) === key);
  if (a) selectAnimal(a);
}

async function selectAnimal(a) {
  selected = a;
  editingLogId = null;
  document.querySelectorAll('.admin-animal-item').forEach((el) =>
    el.classList.toggle('selected', el.dataset.key === getKey(a))
  );
  renderPanel({ loading: true });
  try {
    record = await api(`/api/animals/${encodeURIComponent(getKey(a))}/logs`);
  } catch (e) {
    record = { status: a.customStatus, logs: [] };
    toast('기록 조회 실패: ' + e.message);
  }
  renderPanel();
}

// ---------- 편집 패널 ----------
function renderPanel(opt = {}) {
  const panel = document.getElementById('adminPanel');
  if (!selected) {
    panel.innerHTML = '<p style="color:#94A3B8; font-size:0.9rem;">왼쪽에서 개체를 선택하세요.</p>';
    return;
  }
  const a = selected;
  const status = record?.status ?? a.customStatus ?? null;
  const logs = opt.loading ? null : (record?.logs || []);

  panel.innerHTML = `
    <h2>${a.noticeNo || getKey(a)} <small style="color:#94A3B8; font-weight:400;">${a.kindFullNm || ''} ${a.colorCd || ''} ${a.age || ''}</small></h2>

    <h3>① 현재 상태 지정</h3>
    <div class="radio-row" id="statusRadios">
      ${['none', 'foster', 'adopting'].map((s) => `
        <label class="radio-pill ${s} ${((status || 'none') === s) ? 'checked' : ''}">
          <input type="radio" name="customStatus" value="${s}" ${((status || 'none') === s) ? 'checked' : ''}>
          ${STATUS_LABEL[s]}
        </label>`).join('')}
    </div>
    <p class="admin-hint">상태를 바꾸면 저장 시 타임라인에 자동으로 한 줄 기록이 추가됩니다.</p>
    <div style="margin-top:10px;">
      <button class="btn-primary" onclick="saveStatus()"><i class="fas fa-save"></i> 상태 저장</button>
    </div>

    <h3>② 케어 기록 ${opt.loading ? '<i class="fas fa-circle-notch fa-spin" style="font-size:0.8rem;"></i>' : `(${(logs || []).length}건)`}</h3>
    <div id="adminLogList">
      ${opt.loading ? '<p class="admin-hint">불러오는 중...</p>' : renderLogList(logs || [])}
    </div>

    <h3>${editingLogId ? '✏️ 기록 수정 중' : '③ 새 기록 추가'}</h3>
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
  `;
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
async function saveStatus() {
  const val = document.querySelector('input[name=customStatus]:checked')?.value || 'none';
  const status = val === 'none' ? null : val;
  try {
    await api(`/api/admin/animals/${encodeURIComponent(getKey(selected))}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    toast(status ? `상태 저장: ${STATUS_LABEL[status]}` : '상태 지정 해제');
    logsCacheBust();
    await Promise.all([loadAnimals(), refreshRecord()]);
  } catch (e) {
    toast('실패: ' + e.message);
  }
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
  record = await api(`/api/animals/${encodeURIComponent(getKey(selected))}/logs`);
  renderPanel();
}

// ---------- 시작 ----------
if (token) showAdmin();
else showLogin();
