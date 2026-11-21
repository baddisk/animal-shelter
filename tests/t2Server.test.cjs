'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),sharp=require('sharp');
const {makeSite,boot,until,id,share,short,img}=require('./fixtures/t2-site.cjs');
const json=r=>r.then(x=>x.json());const login=async s=>(await json(s.req('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:s.password})}))).token;
const mark='/api/admin/sync',key=w=>createHash('sha1').update(img+'|'+w).digest('hex')+'.jpg';
test('T8 기반 Express T2 · 외부망 없이 실서버 경로 검증',{timeout:40000},async t=>{
 const dir=await makeSite(),snapshot=path.join(dir,'cache/animals-snapshot.json'),pics=path.join(dir,'cache/img-cache');let s=null;
 t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});s=await boot(dir,{hold:true});
 const tok=await login(s);assert(tok);const admin={Authorization:'Bearer '+tok};const manual=()=>s.req(mark,{method:'POST',headers:admin});
 await t.test('관리자 인증, 20분/하루 타이머, 콜드 목록 요청 합치기, 1,005건 21페이지·메모리 필터',async()=>{
  assert.equal((await s.req(mark)).status,401);assert.equal((await s.req(mark,{method:'POST'})).status,401);
  const a=s.req('/api/animals'),b=s.req('/api/animals?upkind=422400&refresh=1');await until(async()=>(await s.rpc('get')).pages.includes(1));
  await s.rpc('list');const [ra,rb]=await Promise.all([a,b]);assert.match(ra.headers.get('cache-control'),/public, max-age=60/);const {items}=await ra.json();assert.equal(items.length,1005);assert.equal((await rb.json()).total,201);assert.equal(items[0].customStatus,'foster');assert.equal(items[0].logCount,1);assert.equal(items[0].shareId,share(1));assert.equal(items[0].shortCode,short(share(1)));
  assert.equal((await json(s.req('/api/animals?bgnde=20391231'))).total,0);let l=await s.rpc('get');assert.equal(l.pages.length,21);assert(l.intervals.includes(1200000)&&l.intervals.includes(86400000));assert.match(l.ranges[0][0],/^\d{8}$/);assert(!JSON.stringify(items).includes('TEST_ONLY_NAME'));
  await until(async()=>(await s.rpc('get')).detail.length===1);assert.equal((await json(s.req(mark,{headers:admin}))).running,true);
  const disk=await fs.readFile(snapshot,'utf8');assert(!/TEST_ONLY_|careTel|officetel|chargeNm/.test(disk));assert.equal(JSON.parse(disk).items.length,1005);
 });
 await t.test('느린 수집 동안 상세 즉시 반환, 관리자 중복 실행 합치기, 두 대상 간 1.5초·8초·UA',async()=>{
  const inflight=[manual(),manual()];for(let i=0;i<10;i++)assert.deepEqual((await json(s.req('/api/detail-images?desertionNo='+id(1)+'&refresh=1'))).images,[]);
  assert.equal((await s.rpc('get')).detail.length,1);await s.rpc('crawl');const done=await Promise.all(inflight.map(r=>json(r)));assert(done.every(r=>r.ok&&r.crawlTargets===2));
  const l=await s.rpc('get');assert.deepEqual(l.detail.map(d=>d.no),[id(1),id(2)]);assert(l.detail[1].time-l.detail[0].time>=1490);assert(l.detail.every(d=>d.timeout===8000&&d.ua==='GanghwaShelterSite/1.0 (+https://ganghwa-shelter.onrender.com)'));
  assert.equal(l.pages.length,21);assert.equal((await json(s.req('/api/detail-images?desertionNo='+id(1)))).count,2);assert.equal((await s.rpc('get')).detail.length,2);
 });
 await t.test('400px JPEG 영구 캐시, 메타데이터 제거, WebP 재사용',async()=>{
  await until(async()=>{try{return (await fs.stat(path.join(pics,key(400)))).size>0;}catch(_){return false;}});
  const meta=await sharp(path.join(pics,key(400))).metadata();assert.equal(meta.width,400);assert.equal(meta.format,'jpeg');assert(!meta.exif);
  const url='/api/image-proxy?url='+encodeURIComponent(img)+'&w=400';assert.equal((await s.req(url,{headers:{Accept:'image/jpeg'}})).headers.get('content-type'),'image/jpeg');assert.match((await s.req(url,{headers:{Accept:'image/webp'}})).headers.get('content-type'),/image\/webp/);assert.equal((await s.rpc('get')).orig,1);
 });
 await t.test('기존/신규 QR 및 단축 주소, 미등록 개체는 1회 대기 뒤 안내, 마지막 페이지 실패 보존',async()=>{
  const groups=async()=>(await s.rpc('get')).ranges.length;const n=await groups();assert.match(await (await s.req('/a/'+share(1))).text(),/__CARELINK_BOOT__/);assert.equal(await groups(),n);
  await s.rpc('count',1006);assert.match(await (await s.req('/a/'+share(1006))).text(),new RegExp(share(1006)));assert.equal(await groups(),n+1);
  await s.rpc('count',1007);const good=await s.req('/s/'+short(share(1007)),{redirect:'manual'});assert.equal(good.headers.get('location'),'/a/'+share(1007));assert.equal(await groups(),n+2);
  const pending=await s.req('/a/'+share(2000),{redirect:'manual'});assert.equal(pending.status,302);assert.equal(pending.headers.get('location'),'/?share=pending');assert.equal(await groups(),n+3);
  const home=await (await s.req('/?share=pending')).text();assert.match(home,/방금 등록된 아이라 정보를 불러오는 중이에요\. 잠시 후 다시 열어 주세요/);assert.doesNotMatch(home,/id="sharePending" hidden/);
  await until(async()=>!(await json(s.req(mark,{headers:admin}))).running);const before=await fs.readFile(snapshot);await s.rpc('fail',21);const failed=await manual();assert.equal(failed.status,503);assert.deepEqual(await fs.readFile(snapshot),before);assert.equal((await json(s.req('/api/animals'))).total,1007);assert.equal((await s.rpc('get')).detail.length,2);
 });
 await t.test('과거 통계 읽기 전용, 신규 입력은 익명 일별 증분, 통계 응답/CSV 유지',async()=>{
  const legacy=path.join(dir,'data/events.json'),old=await fs.readFile(legacy);for(let i=0;i<2;i++){
   const r=await s.req('/api/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:'detail_open',id:id(1),meta:{name:'PRIVATE_TEST',phone:'PRIVATE_TEST'}})});assert.equal(r.status,204);
  }const stats=await json(s.req('/api/admin/stats?days=7&refresh=1',{headers:admin}));assert.equal(stats.totals.events,3);assert.equal(stats.totals.detail_open,2);assert.equal(stats.totals.page_view,1);assert.match(await (await s.req('/api/admin/stats/export.csv',{headers:admin})).text(),/상세열람/);
  await until(async()=>{try{return (await fs.readFile(path.join(dir,'data/events-daily.json'),'utf8')).includes('"count":2')}catch(_){return false;}});const disk=await fs.readFile(path.join(dir,'data/events-daily.json'),'utf8');assert(!/PRIVATE_TEST|"ts"|"phone"/.test(disk));assert.deepEqual(await fs.readFile(legacy),old);
 });
 await t.test('외부 중단 후 새 프로세스: 목록·추가 사진·JPEG 복원, 7일 초과 JPEG만 청소',async()=>{
  await s.close();s=null;const old=path.join(pics,'f'.repeat(40)+'.jpg'),time=new Date(Date.now()-8*86400000);await fs.copyFile(path.join(pics,key(400)),old);await fs.utimes(old,time,time);
  s=await boot(dir,{offline:true});assert.equal((await json(s.req('/api/animals'))).total,1007);assert.equal((await json(s.req('/api/detail-images?desertionNo='+id(2)+'&refresh=1'))).count,2);assert.equal((await s.req('/api/image-proxy?w=400&url='+encodeURIComponent(img))).status,200);
  await until(async()=>!(await fs.stat(old).then(()=>true,()=>false)));assert((await fs.stat(path.join(pics,key(400)))).size>0);assert.equal((await s.rpc('get')).orig,0);
  assert.match((await json(s.req('/api/version'))).version,/^1\.7\.0-/);
 });
});

test('운영 API 키·관리 비밀번호 누락 시 샘플을 실데이터로 게시하거나 관리자 로그인을 허용하지 않음',async t=>{
 const dir=await makeSite();let s;t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});s=await boot(dir,{noKey:true,noPassword:true});
 const res=await s.req('/api/animals'),data=await res.json();assert.equal(res.status,503);assert.equal(data.mock,undefined);assert.equal(data.total,0);assert.equal(await fs.stat(path.join(dir,'cache','animals-snapshot.json')).then(()=>true,()=>false),false);
 assert.equal((await s.req('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'not-a-configured-password'})})).status,503);
});

test('MongoDB 초기 케어 입력이 준비되기 전에 상태 없는 카드 목록을 발행하지 않음 (격리 모의 DB)',async t=>{
 const dir=await makeSite();let s;t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});s=await boot(dir,{count:3,mockCareDB:true});
 await until(async()=>(await s.rpc('get')).detail.length>0);let finished=false;const list=json(s.req('/api/animals')).then(data=>{finished=true;return data;});
 await until(async()=>(await s.rpc('get')).animalsIn>0);assert.equal((await s.req('/api/version')).status,200);assert.equal(finished,false);
 await s.rpc('db');assert.equal((await list).items.find(a=>a.desertionNo===id(2)).customStatus,'adopting');
});
