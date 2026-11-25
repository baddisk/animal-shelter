'use strict';
// 운영 데이터·실제 인스타 게시물을 사용하지 않는 T9 회귀 테스트.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {normalize}=require('../js/instagramPost');
const {counter,createCounters}=require('../lib/anonymousStats');
const {makeSite,boot,until,id,share}=require('./fixtures/t2-site.cjs');
const base='https://www.instagram.com',post=base+'/p/Abc_12-x/',reel=base+'/reel/X-y_99/';
const q='?igsh=TEST_QUERY_DO_NOT_STORE&utm_source=TEST_QUERY_DO_NOT_STORE';
const req=(method,body,headers={})=>({method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function result(p,status=200){const r=await p;const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
async function auth(s){const {token}=await result(s.req('/api/admin/login',req('POST',{password:s.password})));return {Authorization:'Bearer '+token};}
function put(s,key,body,headers,status=200){return result(s.req(`/api/admin/animals/${encodeURIComponent(key)}/instagram`,req('PUT',body,headers)),status);}
const getUrls=async s=>Object.fromEntries((await result(s.req('/api/animals'))).items.map(a=>[a.desertionNo,a.instagramUrl]));
async function fixture(t,options={},seed){
  const dir=await makeSite(),file=path.join(dir,'data/db.json');let s;
  t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});
  if(seed){const d=JSON.parse(await fs.readFile(file));Object.assign(d.animals,seed);await fs.writeFile(file,JSON.stringify(d));}
  s=await boot(dir,{count:3,...options});return {s,file,dir,async restart(){await s.close();s=await boot(dir,{offline:true,count:3});return s;}};
}

test('동일한 URL 규칙: 게시물·릴스만 허용, 대소문자/밑줄 유지, 추적 쿼리·조각 제거',()=>{
  assert.equal(normalize(post+q),post);assert.equal(normalize(' '+reel.slice(0,-1)+'#direct '),reel);
  for(const v of [null,0,{},'',base+'/shelter/',base+'/stories/shelter/7',base+'/p/',base+'/p/abc/extra/',base+'/p/a b/',base+'/p/%2F/',
    'http://www.instagram.com/p/abc/','https://instagram.com/p/abc/','https://www.instagram.com.example.org/p/abc/','https://name@www.instagram.com/p/abc/',
    'https://www.instagram.com:8000/p/abc/','/reel/abc/',post+'a'.repeat(4097)])assert.equal(normalize(v),null);
});
test('서버: 관리자만 연결/교체/해제, 잘못된 값은 기존 주소를 보존, 목록·재시작·케어/QR 독립',async t=>{
  const old={status:'foster',statusUpdatedAt:'2025-04-02T01:00:00Z',logs:[{id:'oldLog',title:'과거 기록',type:'care',date:'20250402'}],qrSlot:1,qrMade:{verified:true}};
  const key=id(1),f=await fixture(t,{}, {[key]:old,[id(3)]:{status:null,logs:[],instagramUrl:base+'/not-a-post/'}});let {s}=f;
  const before=await fs.readFile(f.file),a=await auth(s);assert.deepEqual(await getUrls(s),{[key]:null,[id(2)]:null,[id(3)]:null});
  await put(s,key,{instagramUrl:post},{},401);await put(s,id(100),{instagramUrl:post},a,404);await put(s,id(2),{instagramUrl:''},a);
  assert.deepEqual(await fs.readFile(f.file),before,'단순 조회나 빈 링크 해제는 기존 자료를 다시 쓰지 않는다');
  assert.equal((await put(s,key,{instagramUrl:post+q},a)).instagramUrl,post);
  for(const body of [{}, {instagramUrl:42}, {instagramUrl:'http://not-a-post.example/'},{instagramUrl:base+'/shelter/'}])await put(s,key,body,a,400);
  assert.equal((await getUrls(s))[key],post);const adminList=await result(s.req('/api/admin/animals',{headers:a}));assert.equal(adminList.items.find(row=>row.desertionNo===key).instagramUrl,post);
  assert.equal((await put(s,key,{instagramUrl:reel+q},a)).instagramUrl,reel);
  let data=await fs.readFile(f.file,'utf8');assert(!data.includes('TEST_QUERY'));assert.deepEqual(JSON.parse(data).animals[key],{...old,instagramUrl:reel});
  await until(async()=>fs.stat(path.join(f.dir,'cache/animals-snapshot.json')).then(()=>true,()=>false));
  s=await f.restart();const h=await auth(s);assert.equal((await getUrls(s))[key],reel);
  await put(s,key,{instagramUrl:' '},h);assert.equal((await getUrls(s))[key],null);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file)).animals[key],{...old,instagramUrl:null});
});
test('관리번호 없으면 기존 공고번호 키 사용, 로컬 저장 실패는 메모리와 디스크 모두 원복',async t=>{
  const key='인천-강화-'+share(3),old={status:'foster',logs:[],instagramUrl:reel};
  const {s,file}=await fixture(t,{rows:[{},{},{desertionNo:'',noticeNo:key}]},{[id(1)]:old});
  const a=await auth(s);await getUrls(s);const before=await fs.readFile(file);
  await put(s,'인천-강화-'+share(1),{instagramUrl:post},a,404); // 관리번호가 있으면 같은 개체에 두 키를 만들지 않는다.
  await fs.mkdir(file+'.tmp'); // 파일을 쓸 수 없는 상황(운영 레코드와 무관한 임시 사이트)
  await put(s,id(1),{instagramUrl:post},a,503);await put(s,key,{instagramUrl:post},a,503);
  const urls=await getUrls(s);assert.equal(urls[id(1)],reel);assert.equal(urls[''],null);assert.deepEqual(await fs.readFile(file),before);
  await fs.rmdir(file+'.tmp');await put(s,key,{instagramUrl:post+q},a);
  const rows=(await result(s.req('/api/animals'))).items;assert.equal(rows.find(r=>r.noticeNo===key).instagramUrl,post);
  const data=JSON.parse(await fs.readFile(file));assert.equal(data.animals[key].instagramUrl,post);assert(!data.animals['']);assert.deepEqual(data.animals[id(1)],old);
});
test('모의 MongoDB: 게시물 필드 하나만 쓰고 다른 케어 저장이 링크를 되돌리지 않음, 실패 시 성공 표시 없음',async t=>{
  for(const fail of [false,true]){
    const {s,file}=await fixture(t,{mockCareDB:true,traceAnimalPatches:true,rejectInstagramWrite:fail});
    const fileBefore=await fs.readFile(file),a=await auth(s);await s.rpc('db');await getUrls(s);
    const r=await put(s,id(2),{instagramUrl:reel+q},a,fail?503:200);
    if(fail){assert(r.error);assert.equal((await getUrls(s))[id(2)],null);}
    else {
      assert.equal(r.instagramUrl,reel);await result(s.req(`/api/admin/animals/${id(2)}/status`,req('PUT',{status:'confirmed',addLog:false},a)));
      assert.equal((await getUrls(s))[id(2)],reel);await put(s,id(2),{instagramUrl:null},a);
      const patches=(await s.rpc('get')).animalPatches;assert.deepEqual(patches[0],{instagramUrl:reel});assert(!('instagramUrl' in patches[1]));assert.deepEqual(patches[2],{instagramUrl:null});
    }
    assert.deepEqual(await fs.readFile(file),fileBefore);
  }
});
test('공개 UI: 주소 없는 개체는 섹션 없음, 카드 캐시는 정규 주소만, 갤러리 아래 버튼/링크만 초기 출력',async()=>{
  const win={},body={innerHTML:''},ctx=vm.createContext({window:win,URL,document:{addEventListener(){},getElementById:()=>body}});
  for(const file of ['instagramPost.js','app.js'])new vm.Script(await fs.readFile(path.join(__dirname,'../js',file),'utf8')).runInContext(ctx);
  assert.equal(ctx.instaSectionHtml({}), '');assert.equal(ctx.instaSectionHtml({instagramUrl:base+'/profile/'}),'');
  const a={noticeNo:'test-only',customStatus:null,instagramUrl:post+q};
  const html=ctx.instaSectionHtml(a);assert.match(html,/영상으로 만나기/);assert.match(html,/▶ 영상 보기/);assert.match(html,/인스타그램 앱에서 보기/);
  assert(html.includes('href="'+post+'"'));assert(!/<iframe|<script|<blockquote|<img|TEST_QUERY/i.test(html));
  assert.equal(ctx.cachedCard(a).instagramUrl,post);assert(!ctx.cachedCard({instagramUrl:'https://elsewhere.example/x'}).instagramUrl);
  ctx.setupModalImageNavigation=()=>{};ctx.renderModalContent(a,'개','보호중','정보 없음');
  const idx=['class="modal-gallery-wrapper"','class="insta-video"','class="modal-detail"','class="insta-brand-link"'].map(s=>body.innerHTML.indexOf(s));
  assert(idx[0]>=0&&idx[0]<idx[1]&&idx[1]<idx[2]&&idx[2]<idx[3]);
  ctx.renderModalContent({},'개','보호중','정보 없음');assert(!body.innerHTML.includes('class="insta-video"'));assert(body.innerHTML.includes('class="insta-brand-link"'));
});
test('기존 SDK가 있으면 버튼을 누른 뒤 그 SDK로 v14 게시물 하나만 처리 (새 스크립트 없음)',async()=>{
  const win={},note={},box={},events=[];let processed=0;
  const section={dataset:{url:reel},querySelector:s=>s==='.insta-embed-box'?box:note};
  const btn={dataset:{url:reel},closest:()=>section};const click={target:{closest:s=>s==='.insta-play-btn'?btn:null}};
  const ctx=vm.createContext({window:win,URL,setTimeout(){},document:{addEventListener(){},createElement(){assert.fail('기존 SDK를 중복 로드함');}}});
  for(const file of ['instagramPost.js','app.js'])new vm.Script(await fs.readFile(path.join(__dirname,'../js',file),'utf8')).runInContext(ctx);
  win.instgrm={Embeds:{process(){processed++;assert(box.innerHTML.includes('data-instgrm-version="14"'));assert(box.innerHTML.includes('data-instgrm-permalink="'+reel+'"'));}}};
  ctx.track=(...args)=>events.push(args);
  const key='인천-강화-'+share(3);ctx.animal={noticeNo:key,instagramUrl:reel};
  vm.runInContext('activeAnimal=animal;isModalOpen=true;',ctx);const html=ctx.instaSectionHtml(ctx.animal);
  assert(!html.includes('blockquote')&&!html.includes('embed.js'));assert.equal(processed,0);
  ctx.onInstaClick(click);assert.equal(processed,1);assert.deepEqual(events,[['video_open',key]]);
  vm.runInContext('activeAnimal=null;isModalOpen=false;',ctx);ctx.onInstaClick(click);assert.equal(processed,1);
});
test('클릭은 개체·종류별 일별 합계: 영상 선택, post, account 분리; 원문/방문자 정보·잘못된 종류 제외',async t=>{
  const {s,dir}=await fixture(t),a=await auth(s);await getUrls(s);
  for(const [event,kind] of [['video_open','account'],['insta_click','account'],['insta_click','post'],['insta_click','post']]){
    const r=await s.req('/api/track',req('POST',{event,id:id(1),meta:{kind,url:post+q,other:'TEST_QUERY_DO_NOT_STORE'}}));assert.equal(r.status,204);
  }
  const stats=await result(s.req('/api/admin/stats?days=1&refresh=1',{headers:a}));assert.equal(stats.totals.video_open,1);assert.equal(stats.totals.insta_click,3);assert.equal(stats.totals.insta_post,2);assert.equal(stats.totals.insta_account,1);
  const bins=await until(async()=>{try{const text=await fs.readFile(path.join(dir,'data/events-daily.json'),'utf8');assert(!text.includes('TEST_QUERY')&&!text.includes('instagram.com'));return JSON.parse(text).rows;}catch(_){return null;}});
  const v=bins.find(b=>b.event==='video_open');assert.deepEqual(v.meta,{});assert.equal(v.id,id(1));
  const links=bins.filter(b=>b.event==='insta_click');assert.deepEqual(Object.fromEntries(links.map(b=>[b.meta.kind,b.count])),{account:1,post:2});assert(links.every(b=>b.id===id(1)));
  assert.equal(counter({event:'insta_click',id:id(1),meta:{kind:'arbitrary',url:post}},Date.now(),()=>id(1)),null);
  for(const event of ['insta_click','video_open'])assert.equal(counter({event,id:'unknown',meta:{kind:'post'}},Date.now(),()=>null),null);
  const calls=[],mock=createCounters(path.join(dir,'test-only-counter.json'),()=>({updateOne:async (filter,update)=>calls.push({filter,update})}));
  for(const r of [...links,v])await mock.add(r);assert.equal(new Set(calls.map(c=>c.filter._id)).size,3);assert(!JSON.stringify(calls).includes('TEST_QUERY'));
});
