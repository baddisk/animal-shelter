'use strict';
// 외부 API/운영 DB 대신 기존 격리 서버와 실제 배포 JS를 사용한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { makeSite, boot, until, id } = require('./fixtures/t2-site.cjs');
const { counter } = require('../lib/anonymousStats');
const keys = ['none', 'foster', 'adopting', 'confirmed'];
const labels = ['보호중', '임시보호중', '입양상담중', '입양확정'];
const oldLog = { id:'old1', date:'20250103', type:'adopting', title:'입양 진행 시작', content:'', createdAt:'2025-01-03T01:00:00.000Z' };

async function readJSON(response, expected = 200) {
  const res = await response; assert.equal(res.status, expected); return res.json();
}
test('운영과 같은 상태 API: 기존 자료를 열 때는 쓰지 않고 네 단계는 명시적 변경만 기록', {timeout:20000}, async t => {
  const dir = await makeSite(), file = path.join(dir, 'data/db.json');
  let s;
  t.after(async () => { if (s) await s.close(); await fs.rm(dir, { recursive:true, force:true }); });
  const old = { status:'adopting', statusUpdatedAt:oldLog.createdAt, logs:[oldLog] };
  const db = JSON.parse(await fs.readFile(file)); db.animals[id(2)] = old;
  // 일부 예전 문서는 기록이 없어 logs 자체가 없다.
  db.animals[id(4)] = {status:'adopting'};
  const initial = JSON.stringify(db); await fs.writeFile(file, initial);
  s = await boot(dir, {count:4});
  const {token} = await readJSON(s.req('/api/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:s.password})}));
  assert(token);
  const put = (body, n = 2, authenticated = true) => s.req(`/api/admin/animals/${id(n)}/status`, {
    method:'PUT', headers:{'Content-Type':'application/json', ...(authenticated ? {Authorization:'Bearer '+token} : {})}, body:JSON.stringify(body)
  });
  const logs = (n = 2) => readJSON(s.req(`/api/animals/${id(n)}/logs`));
  const list = async () => (await readJSON(s.req('/api/animals'))).items;
  const checkStage = async (value, count, n = 2) => {
    const a = (await list()).find(row => row.desertionNo === id(n));
    assert(a, '입양확정만으로 목록에서 제외하지 않는다'); assert.equal(a.processState, '보호중');
    assert.equal(a.customStatus, value); assert.equal(a.logCount, count);
    const r = await logs(n); assert.equal(r.status, value); assert.equal(r.logs.length, count); return r;
  };
  await t.test('이전 adopting은 그대로 읽으며 같은 상태·최초 기본 상태 저장은 쓰기/로그 없음', async () => {
    const r = await checkStage('adopting', 1); assert.deepEqual(r.logs, [oldLog]);
    assert.deepEqual((await readJSON(put({status:'adopting'}))).record, old);
    assert.equal((await readJSON(put({status:null}, 3))).record.status, null);
    assert.equal(await fs.readFile(file, 'utf8'), initial);
  });
  await t.test('인증 없이는 변경 불가, 잘못된 값·누락된 값은 보호중으로 처리하지 않음', async () => {
    await readJSON(put({status:'confirmed'}, 2, false), 401);
    for (const body of [{}, {status:''}, {status:false}, {status:0}, {status:'none'}, {status:'wrong'}]) {
      await readJSON(put(body), 400);
    }
    assert.deepEqual((await logs()).logs, [oldLog]); assert.equal((await logs()).status, 'adopting');
  });
  await t.test('상담→확정→임시보호→상담→보호중: 목록/상세/새 로그 일치 및 중복 저장 방지', async () => {
    let count = 1;
    for (const [value, type, title] of [['confirmed','confirmed','입양확정'], ['foster','foster','임시보호 이동'], ['adopting','adopting','입양상담 시작'], [null,'care','보호중으로 변경']]) {
      const first = (await readJSON(put({status:value}))).record;
      const repeat = (await readJSON(put({status:value}))).record; assert.deepEqual(repeat, first);
      const r = await checkStage(value, ++count); assert.deepEqual(r.logs.find(l=>l.id===oldLog.id), oldLog);
      assert.equal(r.logs[0].title, title); assert.equal(r.logs[0].type, type);
    }
    assert.equal((await readJSON(put({status:'confirmed',addLog:false}))).record.logs.length, count);
    await checkStage('confirmed', count);
  });
  await t.test('확정 로그를 다시 편집해도 종류가 유지되고 옛 로그는 그대로, 재시작 후에도 확정', async () => {
    const first = (await readJSON(put({status:'confirmed'}, 4))).record.logs[0];
    const update = await readJSON(s.req(`/api/admin/animals/${id(4)}/logs/${first.id}`, {
      method:'PUT', headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({date:first.date, type:'confirmed', title:'입양확정 확인', content:''})
    }));
    assert.equal(update.logs[0].type, 'confirmed');
    await until(async () => {
      const data = JSON.parse(await fs.readFile(file));
      return data.animals[id(2)]?.status === 'confirmed' && data.animals[id(4)]?.logs?.[0]?.title === '입양확정 확인';
    });
    const saved = JSON.parse(await fs.readFile(file)); assert(!saved.animals[id(3)]);
    await s.close(); s = await boot(dir, {offline:true, count:4});
    assert.deepEqual((await checkStage('confirmed', 5)).logs.find(l=>l.id===oldLog.id), oldLog);
    assert.equal((await checkStage('confirmed', 1, 4)).logs[0].type, 'confirmed');
  });
});

test('모의 MongoDB: 레거시 상담 조회는 쓰지 않고 확정과 보호중 복귀만 기존 문서에 저장', async t => {
  const dir = await makeSite(); let s;
  t.after(async () => { if (s) await s.close(); await fs.rm(dir, {recursive:true,force:true}); });
  const file = path.join(dir,'data/db.json'), before = await fs.readFile(file);
  s = await boot(dir, {count:3,mockCareDB:true}); await s.rpc('db');
  const req = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const {token} = await readJSON(s.req('/api/admin/login',req({password:s.password})));
  const get = () => readJSON(s.req(`/api/animals/${id(2)}/logs`));
  const put = status => readJSON(s.req(`/api/admin/animals/${id(2)}/status`,{
    ...req({status}),method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token}
  }));
  assert.equal((await get()).status,'adopting'); await put('adopting');
  assert.deepEqual((await s.rpc('get')).careWrites,[]);
  await put('confirmed'); await put('confirmed'); await put(null);
  assert.deepEqual((await s.rpc('get')).careWrites,[{key:id(2),status:'confirmed',logs:1},{key:id(2),status:null,logs:2}]);
  assert.equal((await get()).status,null); assert.deepEqual(await fs.readFile(file),before);
});

async function client(name, globals) {
  const ctx = vm.createContext(globals);
  new vm.Script(await fs.readFile(path.join(__dirname, '../js', name), 'utf8'), {filename:name}).runInContext(ctx);
  return ctx;
}
test('관리자 라디오 4개 순서·기본 상태, 기록의 명시적 null 및 개체 빠른 전환', async () => {
  const panel = {innerHTML:''};
  const c = await client('admin.js', {window:{}, sessionStorage:{getItem:()=>''}, setInterval(){},
    document:{getElementById:k=>k==='adminPanel'?panel:k==='adminVersion'?null:{style:{}}, querySelectorAll:()=>[]}});
  const options = () => [...panel.innerHTML.matchAll(/<input type="radio" name="customStatus" value="([^"]+)"([^>]*)>\s*<span>([^<]+)<\/span>/g)];
  for (const key of keys) {
    c.state = key==='none'?null:key;
    vm.runInContext("selected={customStatus:'confirmed'};record={status:state,logs:[]};renderPanel();", c);
    const radios = options(); assert.deepEqual(radios.map(r=>r[1]), keys); assert.deepEqual(radios.map(r=>r[3].split(' ').pop()), labels);
    assert.deepEqual(radios.filter(r=>r[2].includes('checked')).map(r=>r[1]), [key]);
  }
  const release = new Map(); c.api = url => new Promise(r=>release.set(url,r));
  const a = c.selectAnimal({desertionNo:'1',customStatus:'adopting'});
  const b = c.selectAnimal({desertionNo:'2',customStatus:null});
  assert(options().every(r=>r[2].includes('disabled')));
  release.get('/api/animals/2/logs')({status:'confirmed',logs:[]}); await b;
  release.get('/api/animals/1/logs')({status:'adopting',logs:[]}); await a;
  assert.deepEqual(options().filter(r=>r[2].includes('checked')).map(r=>r[1]), ['confirmed']);
});

test('공개 카드·상세, 축종과 결합한 상태 필터, 상담/확정 수 분리 및 기존 공고 표시', async () => {
  const counts = {};
  const c = await client('app.js', {window:{}, document:{addEventListener(){},getElementById:k=>counts[k] ||= {}}});
  c.rows = [null,'foster','adopting','confirmed','adopting'].map((v,i)=>({desertionNo:String(i),kindFullNm:i===2?'[고양이]':'[개]',processState:'보호중',customStatus:v,logCount:i===3?2:0}));
  vm.runInContext('allAnimals=rows;updateStatusChips();', c);
  assert.deepEqual(['cntAll','cntFoster','cntAdopting','cntConfirmed','cntNews'].map(k=>counts[k].textContent), [5,1,2,1,1]);
  for (let i=0;i<4;i++) {
    assert(c.badgeFor(c.rows[i]).text.endsWith(labels[i]));
    assert(c.modalDetailHtml(c.rows[i],'개','🏠 보호중','공고 기간').includes(labels[i]));
  }
  assert(c.badgeFor({processState:'공고중',customStatus:null}).text.includes('공고중'));
  assert(c.modalDetailHtml({...c.rows[3],processState:'공고중'},'개','📢 공고중','공고 기간').includes('(시스템: 📢 공고중)'));
  for (const [status, species, expected] of [['adopting','all',['2','4']],['adopting','cat',['2']],['confirmed','all',['3']],['confirmed','cat',[]],['foster','all',['1']],['news','all',['3']],['all','all',['0','1','2','3','4']]]) {
    Object.assign(c,{status,species});
    const ids = vm.runInContext('currentStatusFilter=status;currentStatsFilter=species;getFilteredAnimals().map(a=>a.desertionNo)',c);
    assert.deepEqual(Array.from(ids), expected);
  }
  const html = await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  assert.match(html,/data-status="adopting">🤝 입양상담중 <em id="cntAdopting"/); assert.match(html,/data-status="confirmed">✅ 입양확정 <em id="cntConfirmed"/);
});

test('공개 필터 집계는 상담·확정 코드만 구분하고 자유 입력은 수집하지 않음', () => {
  for (const status of ['adopting', 'confirmed', 'invalid']) {
    const r = counter({event:'filter_used',id:'not-saved',meta:{status,other:'not-saved'}},Date.now());
    assert.equal(r.id,null);assert.deepEqual(r.meta,status==='invalid'?{}:{status});
  }
});
