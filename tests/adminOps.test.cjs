'use strict';
// 관리자 운영 목록: 실제 배포 JS·로컬 서버만 사용. 기관 API, 운영 DB, KAWIS로 요청하지 않는다.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {makeSite,boot,id,share}=require('./fixtures/t2-site.cjs');
const day=n=>new Date(Date.now()+(9+n*24)*3600000).toISOString().slice(0,10).replaceAll('-','');
const url=n=>`https://www.animal.go.kr/files/shelter/ops-${n}.jpg`;
const secret='촬영용 비공개 메모 & <대기>',noteNo=n=>'인천-강화-'+share(n);
const item=(n,age,edt,num,extra={})=>({desertionNo:id(n),noticeNo:noteNo(n),processState:'보호중',happenDt:day(-age),noticeSdt:day(-4),noticeEdt:day(edt),...Object.fromEntries(Array.from({length:num},(_,i)=>['popfile'+(i+1),url(i+1)])),...extra});
const data=[item(1,50,4,2),item(2,40,0,1),item(3,30,1,3),item(4,100,-1,0),item(5,12,8,1,{noticeSdt:day(3)}),item(6,0,2,1),
  item(7,0,0,0,{processState:'공고중',noticeSdt:'',noticeEdt:'',happenDt:'20260230'}),item(8,20,2,3),item(9,1,-2,0,{desertionNo:'',popfile:url(9)})];
const old={status:'foster',statusUpdatedAt:'2025-06-01T00:00:00Z',logs:[{id:'log1',title:'기존 이력',type:'care',date:'20250601'}],instagramUrl:'https://www.instagram.com/p/KeepPost/',photoNote:secret};
async function site(t,opts={}){
  const dir=await makeSite(),file=path.join(dir,'data/db.json');let s;
  t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});
  await fs.writeFile(file,JSON.stringify({animals:{[id(1)]:old,[id(3)]:{status:null,logs:[],qrMade:{verified:true}},[id(6)]:{status:'confirmed',logs:[],qrSlot:2}}}));
  await fs.mkdir(path.join(dir,'cache'));await fs.writeFile(path.join(dir,'cache/animals-snapshot.json'),JSON.stringify({syncedAt:new Date().toISOString(),items:data,extra:{[id(1)]:{images:[url(7),url(8)]},[id(2)]:{images:[url(7),url(8),url(9)]}}}));
  const start=()=>boot(dir,{offline:true,...opts});s=await start();return {s,file,dir,async restart(){await s.close();s=await start();return s;}};
}
const req=(method,body,h={})=>({method,body:JSON.stringify(body),headers:{'Content-Type':'application/json',...h}});
async function json(p,status=200){const r=await p,d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
async function login(s){return {Authorization:'Bearer '+(await json(s.req('/api/admin/login',req('POST',{password:s.password})))).token};}
const list=(s,h)=>json(s.req('/api/admin/animals',{headers:h}));
const put=(s,h,key,field,body,code)=>json(s.req('/api/admin/animals/'+encodeURIComponent(key)+'/'+field,req('PUT',body,h)),code);
const logs=(s,k)=>json(s.req('/api/animals/'+encodeURIComponent(k)+'/logs'));

test('운영 목록 두 가지: API/크롤 장수의 최댓값(합집합 아님), KST 보호일·공고 경계·T5 생성/자리 기록·정렬',async t=>{
  const {s,file}=await site(t),before=await fs.readFile(file),auth=await login(s);
  await json(s.req('/api/admin/animals'),401);const res=await s.req('/api/admin/animals',{headers:auth});assert.match(res.headers.get('cache-control'),/private.*no-store/);
  const {items,asOf}=await res.json();assert.equal(asOf,day(0));const a=n=>items.find(x=>x.noticeNo===noteNo(n));
  assert.equal(a(1).photoCount,2);assert.equal(a(1).qrPhotos.length,4);assert.equal(a(2).photoCount,3);assert.equal(a(3).photoCount,3);
  assert.equal(a(1).daysInCare,50);assert.equal(a(6).daysInCare,0);assert.equal(a(7).daysInCare,null);assert.equal(a(9).photoCount,1);
  assert.equal(a(2).noticePhase,'open');assert.equal(a(4).noticePhase,'ended');assert.equal(a(5).noticePhase,'upcoming');assert.equal(a(7).noticeEnd,null);
  const ctx={window:{},getKey:x=>x.desertionNo || x.noticeNo};vm.runInNewContext(await fs.readFile(path.join(__dirname,'../js/adminOps.js'),'utf8'),ctx);
  const order=items.map(x=>x.noticeNo),q=ctx.window.adminOps.queues(items);assert.deepEqual(items.map(x=>x.noticeNo),order);
  assert.deepEqual(Array.from(q.photo,x=>x.noticeNo),[4,1,5,9,6,7].map(noteNo));assert.deepEqual(Array.from(q.qr,x=>x.noticeNo),[2,8,1,7].map(noteNo));
  assert.equal(a(6).customStatus,'confirmed');assert.equal(a(1).photoNote,secret);assert.equal(a(2).photoNote,'');
  for(const u of ['/api/animals',`/api/animals/${id(1)}/logs`,`/a/${share(1)}`]){const text=await(await s.req(u)).text();assert(!text.includes(secret)&&!text.includes('photoNote'));}
  assert.deepEqual(await fs.readFile(file),before);assert.equal((await s.rpc('get')).detail.length,0,'조회는 상세 크롤링을 시작하지 않는다');
  assert.deepEqual(ctx.window.adminOps.queues([]).photo,[]);
});
test('촬영 메모: 인증·저장·수정·삭제·재시작·실패 시 원복, QR/게시물/케어 이력과 분리',async t=>{
  const f=await site(t);let {s}=f,h=await login(s);const key=id(1),before=await fs.readFile(f.file);
  await put(s,{},key,'photo-note',{photoNote:'변경'},401);await put(s,h,id(999),'photo-note',{photoNote:'변경'},404);
  for(const body of [{},{photoNote:null},{photoNote:7},{photoNote:'가'.repeat(501)}])await put(s,h,key,'photo-note',body,400);
  await put(s,h,key,'photo-note',{photoNote:secret});await put(s,h,id(2),'photo-note',{photoNote:'  '});assert.deepEqual(await fs.readFile(f.file),before);
  await put(s,h,id(3),'photo-note',{photoNote:'QR 작업 후 촬영'});await put(s,h,key,'photo-note',{photoNote:'  야외 촬영  '});
  const records=JSON.parse(await fs.readFile(f.file)).animals;assert.deepEqual(records[key],{...old,photoNote:'야외 촬영'});assert.deepEqual(records[id(3)].qrMade,{verified:true});
  await fs.mkdir(f.file+'.tmp');await put(s,h,key,'photo-note',{photoNote:'실패해야 함'},503);await put(s,h,key,'status',{status:'confirmed',expectedStatus:'foster'},503);
  assert.deepEqual((await logs(s,key)),{status:'foster',logs:old.logs});assert.equal((await list(s,h)).items.find(a=>a.desertionNo===key).photoNote,'야외 촬영');await fs.rmdir(f.file+'.tmp');
  const r=await put(s,h,noteNo(9),'photo-note',{photoNote:'공고번호 키'});assert.equal(r.photoNote,'공고번호 키');
  s=await f.restart();h=await login(s);assert.equal((await list(s,h)).items.find(a=>a.desertionNo===key).photoNote,'야외 촬영');
  await put(s,h,key,'photo-note',{photoNote:''});assert.deepEqual(JSON.parse(await fs.readFile(f.file)).animals[key],{...old,photoNote:''});assert(!(await(await s.req('/api/animals')).text()).includes('공고번호 키'));
});
test('목록 상태 칩: 기존 API의 변경과 로그는 한 번에 저장, 중복 클릭/다른 관리자의 오래된 상태는 덮지 않음',async t=>{
  const {s,file}=await site(t),h=await login(s),key=id(1),path='status';
  await put(s,{},key,path,{status:'adopting',expectedStatus:'foster'},401);await put(s,h,noteNo(1),path,{status:'adopting',expectedStatus:'foster'},404);
  await Promise.all([1,2].map(()=>put(s,h,key,path,{status:'adopting',expectedStatus:'foster'})));
  let r=await logs(s,key);assert.equal(r.status,'adopting');assert.equal(r.logs.length,2);assert.deepEqual(r.logs[1],old.logs[0]);assert.equal(r.logs[0].title,'입양상담 시작');
  await put(s,h,key,path,{status:'confirmed'});await put(s,h,key,path,{status:null,expectedStatus:'adopting'},409);assert.equal((await logs(s,key)).logs.length,3);
  await put(s,h,key,path,{status:null,expectedStatus:'confirmed'});await put(s,h,key,path,{status:null,expectedStatus:null});r=await logs(s,key);assert.equal(r.status,null);assert.equal(r.logs.length,4);assert.equal(r.logs[0].title,'보호중으로 변경');
  assert.equal(JSON.parse(await fs.readFile(file)).animals[key].photoNote,secret);
});
test('모의 MongoDB: 메모는 단일 필드, 상태·한 줄 이력은 함께 커밋, 쓰기 실패는 503이고 공개되지 않음',async t=>{
  for(const fail of [false,true]){
    const {s,file}=await site(t,{mockCareDB:true,traceAnimalPatches:true,rejectOpsWrite:fail});await s.rpc('db');const h=await login(s),key=id(2),before=await fs.readFile(file);
    await put(s,h,key,'photo-note',{photoNote:secret},fail?503:200);await put(s,h,key,'status',{status:'foster',expectedStatus:'adopting'},fail?503:200);
    let a=(await list(s,h)).items.find(x=>x.desertionNo===key);assert.equal(a.photoNote,fail?'':secret);assert.equal(a.customStatus,fail?'adopting':'foster');assert.equal(a.logCount,fail?0:1);
    if(!fail){await json(s.req(`/api/admin/animals/${key}/logs`,req('POST',{date:day(0),type:'care',title:'산책'},h)));
      const patches=(await s.rpc('get')).animalPatches;assert.deepEqual(patches[0],{photoNote:secret});assert.deepEqual(Object.keys(patches[1]).sort(),['logs','status','statusUpdatedAt']);assert(!('photoNote' in patches[2]));
      assert.equal((await list(s,h)).items.find(x=>x.desertionNo===key).photoNote,secret);}
    assert.deepEqual(await fs.readFile(file),before);assert(!(await(await s.req('/api/animals')).text()).includes(secret));
  }
});
test('실제 목록 경로: 국가 종료 개체 제외, 보호소 입양확정은 유지, 같은 날짜는 공고번호 순',async t=>{
  const dir=await makeSite();let s;t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});
  const rec=JSON.parse(await fs.readFile(path.join(dir,'data/db.json')));rec.animals[id(3)]={status:'confirmed',logs:[]};await fs.writeFile(path.join(dir,'data/db.json'),JSON.stringify(rec));
  const rows=[{processState:'종료(입양)'},{processState:'종료(반환)'},{noticeNo:'인천-강화-2026-09999'},{noticeNo:'인천-강화-2026-00001'}].map(a=>({...a,noticeSdt:day(0),noticeEdt:day(2)}));
  s=await boot(dir,{count:4,rows,qrExtras:'<html>추가 사진 없음</html>'});const auth=await login(s),d=await list(s,auth);assert.equal(d.items.length,2);
  const ctx={window:{},getKey:a=>a.desertionNo};vm.runInNewContext(await fs.readFile(path.join(__dirname,'../js/adminOps.js'),'utf8'),ctx);const q=ctx.window.adminOps.queues(d.items);
  for(const xs of [q.photo,q.qr])assert.deepEqual(Array.from(xs,x=>x.desertionNo),[id(4),id(3)]);
  assert.equal(q.photo[1].customStatus,'confirmed');assert.equal(q.photo[1].noticePhase,'open');assert.equal(q.photo[1].daysInCare,1);
});
