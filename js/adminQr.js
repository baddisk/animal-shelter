// T5 관리자 도구. 토큰은 기존 세션에서 Authorization 헤더로만 사용한다.
window.adminQr = (() => {
  const drafts=new Map(); // 메모리만 사용: 다른 개체를 눌러도 응답/업로드 자리가 뒤섞이지 않는다.
  let working=null, batchMessage='';
  const draft=id=>{if(!drafts.has(id))drafts.set(id,{pos:'br',v:null,message:'',error:'',force:false,saving:false});return drafts.get(id);};
  const current=()=>selected && (animals.find(a=>getKey(a)===getKey(selected)) || selected);
  function mark(id,fields){
    const row=animals.find(a=>getKey(a)===id);if(row)Object.assign(row,fields);
    if(selected && getKey(selected)===id)Object.assign(selected,fields);
  }
  async function downloadWithAuth(url,fallbackName) {
    const res=await fetch(url,{cache:'no-store',headers:{Authorization:'Bearer '+token}});
    if(!res.ok){
      const data=await res.json().catch(()=>({}));
      if(res.status===401){token='';sessionStorage.removeItem(TOKEN_KEY);showLogin();}
      const err=new Error(data.error || '파일을 받지 못했습니다.');err.code=data.code;throw err;
    }
    const blob=await res.blob(),href=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=href;a.download=res.headers.get('X-Filename') || fallbackName;
    try{document.body.appendChild(a);a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(href),5000);}
  }
  function refresh(){
    const batch=document.getElementById('qrBatch'),status=document.getElementById('qrBatchStatus');
    if(batch)batch.disabled=!!working;
    if(status)status.textContent=working==='batch'?'ZIP을 만드는 중입니다…':batchMessage;
    const box=document.getElementById('qrSection'),a=current();if(!box || !a)return;
    const id=getKey(a),d=draft(id),photos=a.qrPhotos || [],locked=!!working || d.saving;
    if(!photos.some(p=>p.v===d.v)){d.v=photos[0]?.v || null;d.force=false;}
    const ds=locked?'disabled':'';
    box.innerHTML=`<h3 id="qrHeading">④ QR 사진</h3>
      <p class="qr-help">원본은 최대 8장 중에서 고를 수 있습니다. 완성된 JPG는 KAWIS <b>1번 또는 2번</b>에 직접 올려 주세요.</p>
      <fieldset ${ds}><legend>원본 사진</legend>${photos.length?`<div class="qr-thumbs">${photos.map((p,i)=>`
        <label><input type="radio" name="qrSource" value="${i+1}" ${p.v===d.v?'checked':''}>
          <span><img src="${escapeHtml(p.thumb)}" alt="" loading="lazy" decoding="async">${i+1}번</span></label>`).join('')}</div>`:'<p class="qr-help">선택할 원본 사진이 없습니다.</p>'}</fieldset>
      <fieldset ${ds}><legend>QR 위치</legend><div class="qr-actions">${[['br','우하단'],['bl','좌하단']].map(([v,label])=>`<label><input type="radio" name="qrPosition" value="${v}" ${v===d.pos?'checked':''}> ${label}</label>`).join('')}</div></fieldset>
      <div class="qr-actions"><button type="button" class="btn-primary" data-qr-act="make" ${locked || !photos.length?'disabled':''}>${working===id?'사진 만드는 중…':'QR 사진 만들기'}</button></div>
      <p class="qr-feedback" role="status">${escapeHtml(d.message)}</p>
      ${d.error?`<p class="qr-error" role="alert">${escapeHtml(d.error)}</p>`:''}
      ${d.force?`<div class="qr-warning">작은 화면에서 안 읽힐 수 있습니다. <button type="button" class="btn-ghost" data-qr-act="force" ${ds}>검증 없이 만들기</button></div>`:''}
      ${a.qrMade?`<fieldset class="qr-upload" ${d.saving?'disabled':''}><legend>KAWIS 몇 번 자리에 올리셨나요?</legend>
        <p class="qr-help">${a.qrSlot?`기록된 자리: ${Number(a.qrSlot)}번.`:'아직 업로드 자리를 기록하지 않았습니다.'} 실제로 올린 뒤 선택하세요.</p>
        <div class="qr-actions">${[1,2].map(n=>`<button type="button" data-qr-act="slot" data-slot="${n}" class="btn-ghost" aria-pressed="${a.qrSlot===n}">${n}번</button>`).join('')}</div></fieldset>`:''}`;
    box.onchange=e=>{
      const el=e.target;if(el.name!=='qrSource' && el.name!=='qrPosition')return;
      if(el.name==='qrSource')d.v=photos[Number(el.value)-1]?.v;else d.pos=el.value;
      d.force=false;d.message='';d.error='';refresh();
      box.querySelector(`input[name="${el.name}"]:checked`)?.focus({preventScroll:true});
    };
    box.onclick=e=>{
      const btn=e.target.closest('button[data-qr-act]');if(!btn || btn.disabled)return;
      if(btn.dataset.qrAct==='slot')saveSlot(id,Number(btn.dataset.slot));
      else if(btn.dataset.qrAct==='make')make(a,false);
      else if(btn.dataset.qrAct==='force' && d.force && confirm('작은 화면에서 QR이 안 읽힐 수 있습니다. 검증 없이 만들까요?'))make(a,true);
    };
  }
  async function make(a,force){
    const id=getKey(a),d=draft(id),i=(a.qrPhotos || []).findIndex(p=>p.v===d.v);
    if(working || i<0 || (force && !d.force))return;
    const query=new URLSearchParams({slot:String(i+1),pos:d.pos,v:d.v,...(force?{force:'1'}:{})});
    working=id;d.message='';d.error='';refresh();
    try{
      await downloadWithAuth('/api/admin/qr-photo/'+encodeURIComponent(id)+'?'+query,'QR.jpg');
      mark(id,{qrMade:true});d.force=false;d.message=force?'검증 없이 JPG를 받았습니다. 업로드 전에 꼭 스캔해 보세요.':'300px 판독을 확인한 JPG를 받았습니다.';
      await loadAnimals();
    }catch(err){d.error=err.message;d.force=err.code==='QR_UNREADABLE';}
    finally{working=null;refresh();}
  }
  async function saveSlot(id,slot){
    const d=draft(id);if(d.saving)return;d.saving=true;d.error='';refresh();
    try{await api('/api/admin/animals/'+encodeURIComponent(id)+'/qr-slot',{method:'PUT',body:JSON.stringify({qrSlot:slot})});
      mark(id,{qrSlot:slot});d.message=`KAWIS ${slot}번 자리로 기록했습니다.`;await loadAnimals();
    }catch(err){d.error=err.message;}finally{d.saving=false;refresh();}
  }
  async function batch(){
    if(working)return;working='batch';batchMessage='';refresh();
    try{await downloadWithAuth('/api/admin/qr-photos.zip','QR-photos.zip');batchMessage='ZIP을 받았습니다. 안내와 실패목록(있는 경우)을 확인해 주세요.';}
    catch(err){batchMessage=err.message;}
    finally{try{await loadAnimals();}finally{working=null;refresh();}}
  }
  return {refresh,batch};
})();
