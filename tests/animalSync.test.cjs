'use strict';
// node --test tests/animalSync.test.cjs — 운영 키·DB·네트워크 불필요
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createAnimalSync, yearRange, apiPhotoCount, needsCrawl, filterAnimals} = require('../services/animalSync');
const t0 = Date.parse('2026-11-18T15:00:03Z');
const make = (n, fields={}) => ({desertionNo:String(n), noticeNo:`인천-강화-2026-${String(n).padStart(5,'0')}`,
  happenDt:'20261118', noticeSdt:'20261118', noticeEdt:'20261120', updTm:'v1', kindFullNm:'[개] 믹스',
  popfile1:`https://www.animal.go.kr/files/shelter/${n}.jpg`, ...fields});
async function fixture(t, opt={}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'carelink-sync-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const f={ms:t0, rows:[make(1)], api:0, collect:[], warm:[], waits:[], bad:false};
  const file=path.join(dir,'animals-snapshot.json');
  const deps={snapshotFile:file, now:()=>f.ms, wait:async n=>{f.waits.push(n);f.ms+=n;},
    shareIdOf:a=>a.noticeNo.slice(-10), fetchAllAnimalsFromApi:async range=>{f.api++;f.range=range;return f.rows;},
    crawlDetailImages:async id=>{f.collect.push(id);if(f.bad)throw Error('fixture');return ['https://www.animal.go.kr/files/shelter/'+id+'.jpg'];},
    getResizedImage:async (u,w)=>{f.warm.push([u,w]);},...opt};
  return {s:createAnimalSync(deps),f,file,deps};
}
test('한국 자정·윤일, 공고 시작/종료 포함, 8개 사진 필드와 축종·날짜 경계',()=>{
  assert.equal(yearRange(t0-4000).endde,'20261118');assert.equal(yearRange(t0).endde,'20261119');
  assert.equal(yearRange(Date.parse('2024-02-28T15:20Z')).bgnde,'20230228');
  const a=make(1,{popfile8:'b'}); assert.equal(apiPhotoCount(a),2);
  assert(needsCrawl(a,'20261120'));assert(!needsCrawl(a,'20261117'));assert(!needsCrawl(a,'20261121'));
  assert(!needsCrawl({...a,popfile7:'c'},'20261119'));assert(!needsCrawl({...a,noticeEdt:''},'20261119'));
  assert(!needsCrawl({...a,desertionNo:''},'20261119'));
  assert.deepEqual(filterAnimals([a,make(2,{kindFullNm:'[고양이] 한국'})],{bgnde:'2026-11-18',endde:'20261118',upkind:'417000'}),[a]);
});
test('동시 호출 단일 실행, 목록은 느린 크롤링보다 먼저 공개, 24장×400px 예열',async t=>{
  let release;const gate=new Promise(r=>{release=r});
  const {s,f,file}=await fixture(t,{crawlDetailImages:async no=>{await gate;return ['https://www.animal.go.kr/files/shelter/'+no+'.jpg']}});
  f.rows=Array.from({length:26},(_,i)=>make(i+1,{noticeEdt:i===0?'20261120':'20261118', chargeNm:'제외',officetel:'제외'}));
  f.rows[2].popfile2=f.rows[2].popfile1;delete f.rows[2].popfile1; // 대표 사진이 2번 필드인 개체
  const full=s.runSync();assert.equal(s.runSync(),full);assert.equal(await s.runSync({listOnly:true}),true);
  assert.equal(s.getStatus().running,true);assert.equal(s.getSnapshot().items.length,26);assert.deepEqual(s.getImages('1'),[]);
  assert.equal(f.api,1);const doc=JSON.parse(await fs.readFile(file));assert.equal(doc.crawlTargets,1);assert(!('chargeNm' in doc.items[0]));
  assert(!('officetel' in doc.items[0]));assert.equal(s.findByShareId('2026-00001').desertionNo,'1');
  release();await full;assert.equal(s.getStatus().running,false);assert.deepEqual(s.getImages('1'),['https://www.animal.go.kr/files/shelter/1.jpg']);
  assert.equal(f.warm.length,24);assert(f.warm.every(x=>x[1]===400));
});
test('1.5초 간격, 성공·실패 12시간 제한, updTm 변경, 만료/삭제 정리 및 재시작 복구',async t=>{
  const {s,f,file,deps}=await fixture(t);f.rows=[make(1),make(2),make(3,{noticeSdt:'20261121'}),make(4,{popfile2:'b',popfile3:'c'})];
  await s.runSync();assert.deepEqual(f.collect,['1','2']);assert.deepEqual(f.waits,[1500]);
  await s.runSync();assert.equal(f.collect.length,2);
  f.ms+=12*3600_000;await s.runSync();assert.equal(f.collect.length,4);
  f.rows[0].updTm='v2';f.bad=true;await s.runSync();assert.equal(f.collect.length,5);assert.deepEqual(s.getImages('1'),['https://www.animal.go.kr/files/shelter/1.jpg']);
  const restored=createAnimalSync(deps);restored.loadFromDisk();assert.deepEqual(restored.getImages('1'),['https://www.animal.go.kr/files/shelter/1.jpg']);
  await restored.runSync();assert.equal(f.collect.length,5);
  f.rows=[make(1,{noticeEdt:'20261118'})];await restored.runSync();assert.deepEqual(JSON.parse(await fs.readFile(file)).extra,{});
});
test('빈 목록·오류/부분 응답이면 좋은 디스크 파일과 마지막 성공 시각 보존',async t=>{
  const {s,f,file,deps}=await fixture(t);await s.runSync();const before=await fs.readFile(file,'utf8');const ts=s.getStatus().syncedAt;
  f.rows=[];assert.equal(await s.runSync(),false);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(s.getStatus().syncedAt,ts);
  const restored=createAnimalSync({...deps,fetchAllAnimalsFromApi:async()=>{throw Error('page 2 failed')}});restored.loadFromDisk();
  assert.equal(await restored.runSync(),false);assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(restored.findByShareId('1').noticeNo,'인천-강화-2026-00001');
});

test('스냅샷 디렉터리에 쓸 수 없어도 정상 목록은 응답하고 관리자에게 디스크 오류 표시',async t=>{
 const {f,file,deps}=await fixture(t);await fs.writeFile(file,'fixture');const s=createAnimalSync({...deps,snapshotFile:path.join(file,'not-a-directory','snapshot.json')});
 await s.runSync();assert.equal(s.getStatus().diskOK,false);assert.equal(s.getStatus().total,f.rows.length);assert.equal(s.getSnapshot().items[0].desertionNo,'1');assert.equal(await fs.readFile(file,'utf8'),'fixture');
});

test('목록 공개 직후 QR 누락: 두 요청이 새 목록 1회를 공유하고 남은 상세 수집 전에 결과 반환',async t=>{
 let firstStart,firstDone,secondDone;const started=new Promise(r=>firstStart=r),first=new Promise(r=>firstDone=r),second=new Promise(r=>secondDone=r);const seen=[];
 const {s,f}=await fixture(t,{crawlDetailImages:async no=>{seen.push(no);if(no==='1'){firstStart();await first;}if(no==='2')await second;return [];}});
 f.rows=[make(1),make(2)];const all=s.runSync();await started;
 f.rows=[...f.rows,make(3,{noticeEdt:'20261117'})];assert.equal(s.findByShareId('3'),null);
 const a=s.refreshForShareMiss(),b=s.refreshForShareMiss();assert.equal(a,b);assert.equal(f.api,1);firstDone();
 try {assert.equal(await a,true);assert.equal(f.api,2);assert.equal(s.findByShareId('3').desertionNo,'3');assert.equal(s.getStatus().running,true);}finally{secondDone();}
 assert.equal(await all,true);assert.deepEqual(seen,['1','2']);
});
