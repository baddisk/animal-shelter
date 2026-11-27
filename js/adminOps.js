'use strict';
// T10 운영 목록. 인증한 전체 목록 응답 하나를 사용한다. 메모/초안은 브라우저 저장소에 남기지 않는다.
window.adminOps=(()=>{
  const states={none:'지정 안 함',foster:'임시보호중',adopting:'입양진행중'};
  const phases={open:'공고 중',ended:'공고 종료',upcoming:'공고 예정',unknown:'공고 기간 미상'};
  const perPage=25, pages={photo:1,qr:1};let mode='photo';
  const drafts=new Map(), notesBusy=new Set(), messages=new Map();
  const el=id=>document.getElementById(id);
  const byKey=key=>animals.find(a=>getKey(a)===key);
  const tie=(a,b)=>String(a.noticeNo || '').localeCompare(String(b.noticeNo || ''),'ko') || getKey(a).localeCompare(getKey(b));
  function queues(rows){
    // 입력은 인증된 현재 보호 목록이다. QR 개별 작업은 공고 기간과 무관하고, T5 일괄 ZIP은 별도다.
    return {
      photo:rows.filter(a=>Number.isInteger(a.photoCount) && a.photoCount<=2).sort((a,b)=>(b.daysInCare ?? -1)-(a.daysInCare ?? -1) || tie(a,b)),
      qr:rows.filter(a=>!a.qrMade && !a.qrSlot).sort((a,b)=>(a.noticeEnd || '99999999').localeCompare(b.noticeEnd || '99999999') || tie(a,b))
    };
  }
  function chips(a){
    const key=getKey(a), active=a.customStatus ?? 'none';
    return `<div class="quick-states" role="group" aria-label="${escapeHtml(a.noticeNo || key)} 상태 바로 변경">${Object.entries(states).map(([v,label])=>
      `<button type="button" class="quick-chip ${v}" data-quick="${v}" aria-pressed="${active===v}" ${statusBusy.has(key)?'disabled':''}>${label}</button>`).join('')}</div>`;
  }
  function syncLocks(key){
    document.querySelectorAll(`[data-key="${CSS.escape(key)}"] [data-quick]`).forEach(b=>b.disabled=statusBusy.has(key));
    const b=el('saveDetailStatus');if(b && selected && getKey(selected)===key)b.disabled=!record || statusBusy.has(key);
  }
  function noteForm(a){
    const key=getKey(a), busy=notesBusy.has(key), msg=messages.get(key);
    return `<form class="ops-note" data-note-form>
      <label>촬영 메모 <small>관리자 전용</small><textarea rows="2" name="photoNote" maxlength="500" autocomplete="off" placeholder="예: 사나움, 케이지 촬영만 가능" ${busy?'disabled':''}>${escapeHtml(drafts.get(key) ?? a.photoNote ?? '')}</textarea></label>
      <div><button type="submit" class="btn-ghost" ${busy?'disabled':''}>메모 저장</button><span data-note-msg role="status" ${msg?.error?'class="ops-error"':''}>${escapeHtml(busy?'저장 중…':msg?.text || '')}</span></div></form>`;
  }
  function rowHtml(a){
    const key=getKey(a), img=thumbUrl(a) || a.qrPhotos?.[0]?.thumb, st=Object.hasOwn(STATUS_LABEL,a.customStatus)?a.customStatus:'none';
    return `<article class="ops-row" data-key="${escapeHtml(key)}">
      <div class="ops-id"><span class="ops-thumb">사진 없음${img?`<img src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`:''}</span>
        <div><h4>${escapeHtml(a.noticeNo || key)}</h4><p>${mode==='photo'?`${a.daysInCare==null?'접수일 미상':'보호 '+Number(a.daysInCare)+'일'} · 사진 ${Number(a.photoCount)}장`:`공고 종료일 ${escapeHtml(formatDate8(a.noticeEnd) || '미상')}`}</p>
        <small>${phases[a.noticePhase] || phases.unknown}</small></div></div>
      <div class="ops-state"><span class="status-dot ${st}">${STATUS_LABEL[st]}</span>${chips(a)}</div>
      ${mode==='photo'?noteForm(a):'<div class="ops-qr"><button type="button" class="btn-ghost" data-ops="qr">QR 사진 만들기</button></div>'}</article>`;
  }
  function render(){
    const root=el('tabOps');if(!root || root.style.display==='none')return;
    const q=queues(animals), list=q[mode], max=Math.max(1,Math.ceil(list.length/perPage));
    pages[mode]=Math.min(max,Math.max(1,pages[mode]));const page=pages[mode];
    root.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
    el('opsAsOf').textContent=adminListDay?`${formatDate8(adminListDay)} 한국 날짜 · 보호 중인 개체 기준`:'보호 중인 개체 기준';
    el('opsPhotoCount').textContent=adminListReady?q.photo.length:'–';el('opsQrCount').textContent=adminListReady?q.qr.length:'–';
    el('opsTitle').textContent=mode==='photo'?'■ 사진 보강 필요':'□ QR 미적용 · 보호 중 전체';
    el('opsHint').textContent=mode==='photo'?'API와 수집된 사진 중 많은 쪽이 2장 이하인 개체입니다. 접수일부터 오래 보호한 순이며 당일은 0일입니다.':'공고 기간에 관계없이 관리자 보호 목록에서 QR 생성 기록과 KAWIS 업로드 자리 기록이 모두 없는 개체를 표시합니다. 공고 종료일이 이른 순이며 날짜 미상은 마지막입니다. 일괄 ZIP은 공고 중인 개체만 최대 20마리입니다.';
    el('opsWarning').hidden=!adminListError;el('opsWarning').textContent=adminListError;
    const box=el('opsRows'), active=document.activeElement;
    // 다른 줄의 저장 응답/목록 갱신이 와도 타이핑 중인 메모와 커서를 빼앗지 않는다.
    const focused=box.contains(active) && active.name==='photoNote'?{key:active.closest('[data-key]').dataset.key,from:active.selectionStart,to:active.selectionEnd}:null;
    if(!adminListReady)box.textContent=adminListError?'목록을 다시 읽어 주세요.':'개체 목록을 불러오는 중…';
    else if(!list.length)box.innerHTML=`<p class="admin-list-empty">${mode==='photo'?'사진 보강이 필요한 개체가 없습니다.':'현재 보호 목록에 QR 미적용 개체가 없습니다.'}</p>`;
    else box.innerHTML=list.slice((page-1)*perPage,page*perPage).map(rowHtml).join('');
    if(focused){const field=box.querySelector(`[data-key="${CSS.escape(focused.key)}"] textarea`);if(field && !field.disabled){field.focus({preventScroll:true});field.setSelectionRange(focused.from,focused.to);}}
    const nav=root.querySelector('.ops-pages');nav.hidden=max<=1;
    el('opsPageLabel').textContent=`${page} / ${max}쪽 · 총 ${list.length}마리`;
    nav.querySelector('[data-page="prev"]').disabled=page===1;nav.querySelector('[data-page="next"]').disabled=page===max;
  }
  async function saveNote(form){
    const key=form.closest('[data-key]').dataset.key, a=byKey(key), session=token;
    if(!session || !a || notesBusy.has(key))return;
    const field=form.elements.photoNote, raw=field.value;
    if(raw.length>500){field.focus();toast('촬영 메모는 500자 이내로 입력해 주세요.');return;}
    notesBusy.add(key);drafts.set(key,raw);field.disabled=true;form.querySelector('button').disabled=true;
    form.querySelector('[data-note-msg]').textContent='저장 중…';
    try{
      const data=await api('/api/admin/animals/'+encodeURIComponent(key)+'/photo-note',{method:'PUT',body:JSON.stringify({photoNote:raw.trim()})});
      if(session!==token)return;
      const latest=byKey(key);if(latest)latest.photoNote=data.photoNote;
      if(selected && getKey(selected)===key)selected.photoNote=data.photoNote;
      drafts.delete(key);messages.set(key,{text:data.photoNote?'저장했습니다.':'메모를 지웠습니다.'});
      await loadAnimals();
    }catch(err){if(session===token)messages.set(key,{text:err.message || '저장하지 못했습니다.',error:true});}
    finally{if(session===token){notesBusy.delete(key);render();}}
  }
  async function openQr(a){
    switchTab('care');await selectAnimal(a); // T5 편집기로 이동만 한다. 생성/자리 기록은 자동 실행하지 않는다.
    if(selected!==a || !token || el('tabCare').style.display==='none')return;
    const section=el('qrSection');if(section){const heading=el('qrHeading');heading.tabIndex=-1;heading.focus({preventScroll:true});section.scrollIntoView({block:'start'});}
  }
  function click(event){
    const target=event.target.closest('button'), row=event.target.closest('[data-key]');
    if(target?.disabled)return;
    if(target?.dataset.mode && ['photo','qr'].includes(target.dataset.mode)){mode=target.dataset.mode;render();return;}
    if(target?.dataset.page){pages[mode]+=target.dataset.page==='next'?1:-1;render();el('opsTitle').scrollIntoView({block:'nearest'});return;}
    if(target?.dataset.ops==='reload'){loadAnimals();return;}
    if(!row)return;const a=byKey(row.dataset.key);if(!a)return;
    if(target?.hasAttribute('data-quick')){saveAnimalStatus(a,target.dataset.quick,true);return;}
    if(target?.dataset.ops==='qr'){openQr(a);return;}
    if(row.classList.contains('admin-animal-item') && !event.target.closest('.quick-states'))selectAnimal(a);
  }
  function init(){
    const root=el('tabOps');root.addEventListener('click',click);el('adminList').addEventListener('click',click);
    root.addEventListener('input',e=>{const t=e.target;if(t.name!=='photoNote')return;
      const key=t.closest('[data-key]').dataset.key;drafts.set(key,t.value);messages.set(key,{text:'저장 전'});
      const msg=t.form.querySelector('[data-note-msg]');msg.className='';msg.textContent='저장 전';
    });
    root.addEventListener('submit',e=>{if(e.target.matches('[data-note-form]')){e.preventDefault();saveNote(e.target);}});
  }
  function reset(){drafts.clear();notesBusy.clear();messages.clear();mode='photo';pages.photo=pages.qr=1;el('opsRows').textContent='';}
  return {init,render,reset,queues,chips,syncLocks};
})();
