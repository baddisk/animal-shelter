'use strict';
// 신규 데이터만 처리. T8의 events 컬렉션과 events.json에는 절대 쓰지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const events = new Set(['page_view','link_open','detail_open','detail_close','photo_swipe','dwell_time',
  'filter_used','adopt_inquiry','reserve_click','similar_click','link_share','link_copy']);
const perAnimal = new Set(['detail_open','detail_close','adopt_inquiry','photo_swipe','link_share','link_copy']);
const labels = {upkind:['417000','422400','429900'],stats:['dog','cat','etc'],status:['foster','adopting','confirmed','news']};
const dayOf = ts => new Date(Number(ts) + 9*3600_000).toISOString().slice(0,10);
function counter(input, ts, lookup) {
  if (!input || !events.has(input.event) || !Number.isFinite(ts)) return null;
  const ev = input.event, raw = input.meta || {}, meta = {};
  // 임의 id, 임의 meta 문자열을 키로 사용하지 않는다. 서버에서 실제 개체로 확인한 번호만 허용.
  const id = perAnimal.has(ev) && typeof lookup === 'function' ? lookup(input.id) || null : null;
  if (ev === 'link_open') meta.path = raw.path === 'link' ? 'link' : 'list';
  if (ev === 'filter_used') for (const [k,values] of Object.entries(labels)) if (values.includes(raw[k])) meta[k]=raw[k];
  const seconds = ['dwell_time','detail_close'].includes(ev) && typeof raw.seconds === 'number' &&
    Number.isFinite(raw.seconds) && raw.seconds > 0 && raw.seconds < 3600 ? Math.round(100*raw.seconds)/100 : 0;
  return {day:dayOf(ts), event:ev, id, meta, count:1, secSum:seconds, secN:seconds ? 1 : 0};
}
function keyOf(r) { return [r.day,r.event,r.id||'-',r.meta.path||'-',r.meta.upkind||'-',r.meta.stats||'-',r.meta.status||'-'].join('|'); }
function createCounters(file, collection, warn=()=>console.warn('[통계] 익명 합계 저장 상태를 확인하세요.')) {
  const local = new Map(); let timer=null, dirty=false, safeFile=true;
  try {
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(data?.version!==1 || !Array.isArray(data.rows))throw Error('invalid');
    for(const r of data.rows){if(!r||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!events.has(r.event)||!r.meta||!Number.isSafeInteger(r.count)||r.count<=0)throw Error('invalid');local.set(keyOf(r),r);}
  } catch(e){if(e.code!=='ENOENT'){safeFile=false;warn();}} // 손상된 파일을 빈 집계로 덮어쓰지 않음
  function flush(){
    if(timer)clearTimeout(timer);timer=null;
    if(!dirty || !safeFile)return;
    try{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,rows:[...local.values()]}),{mode:0o600});fs.renameSync(file+'.tmp',file);dirty=false;}
    catch(_){warn();}
  }
  async function add(r){
    const coll=collection();
    if(coll){const {count,secSum,secN,...dimensions}=r;
      const update={$setOnInsert:dimensions,$inc:{count,secSum,secN}};
      try{await coll.updateOne({_id:keyOf(r)},update,{upsert:true});}catch(e){if(e.code!==11000)throw e;await coll.updateOne({_id:keyOf(r)},{$inc:{count,secSum,secN}});}
      return;
    }
    const key=keyOf(r),old=local.get(key);
    if(old){old.count+=r.count;old.secSum+=r.secSum;old.secN+=r.secN;}else local.set(key,{...r});
    dirty=true;if(!timer && safeFile)timer=setTimeout(flush,500); // 지속 입력 중에도 0.5초마다 기록
  }
  async function read(fromDay){
    const coll=collection();
    return coll?coll.find({day:{$gte:fromDay}}).project({_id:0}).toArray():[...local.values()].filter(r=>r.day>=fromDay);
  }
  return {add,read,flush};
}
module.exports={counter,createCounters,dayOf};
