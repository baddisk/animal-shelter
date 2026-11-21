'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {counter,createCounters}=require('../lib/anonymousStats');
const ms=Date.parse('2026-11-18T15:01:03Z');
test('파일·DB 집계: 방문별 시각/원문/미등록 동물 번호가 아닌 KST 일별 증분만 보존',async t=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'care-counts-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));const file=path.join(d,'daily.json');
 const raw={event:'filter_used',id:'PRIVATE_ID',meta:{stats:'dog',status:'PRIVATE_TEXT',phone:'PRIVATE_TEXT',ip:'PRIVATE_TEXT'}};
 const r=counter(raw,ms,()=>null),s=createCounters(file,()=>null);await s.add(r);await s.add(counter({...raw,meta:{stats:'dog',address:'PRIVATE_TEXT'}},ms+3000,()=>null));s.flush();
 const disk=await fs.readFile(file,'utf8');assert(!disk.includes('PRIVATE')&&!disk.includes('T15:'));const [bin]=await createCounters(file,()=>null).read('2026-11-19');assert.equal(bin.count,2);assert.equal(bin.day,'2026-11-19');assert.deepEqual(bin.meta,{stats:'dog'});assert.equal(bin.id,null);
 const calls=[],c=createCounters(path.join(d,'other'),()=>({updateOne:async(...a)=>calls.push(a)}));const e=counter({event:'detail_close',id:'official',meta:{seconds:9,ref:'PRIVATE'}},ms,x=>x==='official'?'400000000000001':null);await c.add(e);await c.add(e);assert.equal(calls.length,2);assert.deepEqual(calls[0][0],calls[1][0]);assert.deepEqual(calls[0][1].$inc,{count:1,secSum:9,secN:1});assert.equal(calls[0][2].upsert,true);assert(!JSON.stringify(calls).includes('PRIVATE'));assert.equal(counter({event:'unrecognized'},ms),null);
});
