'use strict';
// 실행 시 외부 API·운영 DB·KAWIS에는 연결하지 않는다. 독립 ZIP 리더/QR 디코더로 다운로드 자체를 검사한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp'),jsQR=require('jsqr');
const {makeQrPhoto,decodableAt,noticeId,shareFromCode,publicOrigin,inNotice}=require('../services/qrPhoto');
const {makeSite,boot,until,id,share,img}=require('./fixtures/t2-site.cjs');
const origin='https://ganghwa-shelter.onrender.com', url=origin+'/q/26-520';
const date=offset=>new Date(Date.now()+9*3600000+offset*86400000).toISOString().slice(0,10).replaceAll('-','');
const code=n=>`${share(n).slice(2,4)}-${n}`;
const jpg=(w,h)=>sharp({create:{width:w,height:h,channels:3,background:'#8A977A'}}).withMetadata().jpeg().toBuffer();
async function scan(buf,w=300){const {data,info}=await sharp(buf).resize({width:w}).ensureAlpha().raw().toBuffer({resolveWithObject:true});return jsQR(new Uint8ClampedArray(data),info.width,info.height);}
function contents(b) {
  const e=b.lastIndexOf(Buffer.from([0x50,0x4b,5,6]));assert(e>=0);const files=new Map();let p=b.readUInt32LE(e+16);
  for(let i=0;i<b.readUInt16LE(e+10);i++){
    assert.equal(b.readUInt32LE(p),0x02014b50);assert.equal(b.readUInt16LE(p+10),0);
    const nameLen=b.readUInt16LE(p+28),name=b.subarray(p+46,p+46+nameLen).toString(),size=b.readUInt32LE(p+20),o=b.readUInt32LE(p+42);
    assert.equal(b.readUInt32LE(o),0x04034b50);const start=o+30+b.readUInt16LE(o+26)+b.readUInt16LE(o+28);
    assert(!files.has(name));files.set(name,b.subarray(start,start+size));p+=46+nameLen+b.readUInt16LE(p+30)+b.readUInt16LE(p+32);
  }return files;
}
async function login(s){const r=await s.req('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:s.password})});assert.equal(r.status,200);return {Authorization:'Bearer '+(await r.json()).token};}
async function site(t,options,seed){const dir=await makeSite();let s;const file=path.join(dir,'data/db.json');
  t.after(async()=>{if(s)await s.close();await fs.rm(dir,{recursive:true,force:true});});
  if(seed){const d=JSON.parse(await fs.readFile(file));Object.assign(d.animals,seed);await fs.writeFile(file,JSON.stringify(d));}
  s=await boot(dir,options);return {s,file,dir,restart:async()=>{await s.close();s=await boot(dir,{offline:true});return s;}};}
const photo=n=>`/api/admin/qr-photo/${id(n)}`;
const slot=(s,n,qrSlot,headers)=>s.req(`/api/admin/animals/${id(n)}/qr-slot`,{method:'PUT',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({qrSlot})});
async function ogImage(s,n){const r=await s.req('/a/'+share(n));assert.equal(r.status,200);const h=await r.text();const match=h.match(/property="og:image" content="([^"]+)"/);return match?decodeURIComponent(match[1].replaceAll('&amp;','&')):null;}

test('합성: 양쪽 위치·실제 300px 목표 주소·EXIF 제거·폭 1200 제한·비확대·판독 실패와 강제 생성',async()=>{
  const image=await jpg(1600,1200);
  for(const pos of ['bl','br']){
    const p=await makeQrPhoto(image,url,pos),m=await sharp(p.buffer).metadata(),qr=await scan(p.buffer);
    assert.equal(m.format,'jpeg');assert.equal(m.width,1200);assert.equal(m.height,900);assert(!m.exif);
    assert.equal(qr?.data,url);assert.equal(qr.location.topLeftCorner.x<150,pos==='bl');assert(qr.location.bottomLeftCorner.y>120);
    assert(p.verified && [0.30,0.34,0.38,0.42].includes(p.ratio));assert.equal(await decodableAt(p.buffer,300,url+'1'),false);
  }
  const s=await makeQrPhoto(await jpg(540,440),url);assert.equal((await sharp(s.buffer).metadata()).width,540);
  // 이 종횡비에서는 30%로는 읽히지 않아서 더 큰 비율을 써야 한다.
  const adaptive=await makeQrPhoto(await jpg(1200,620),url);assert(adaptive.ratio>0.30);assert.equal((await scan(adaptive.buffer)).data,url);
  const wide=await jpg(1200,120);await assert.rejects(makeQrPhoto(wide,url),e=>e.code==='QR_UNREADABLE');
  const forced=await makeQrPhoto(wide,url,'bl',{skipVerify:true});assert.equal(forced.verified,false);assert.equal(forced.ratio,0.30);
  assert.equal((await sharp(forced.buffer).metadata()).format,'jpeg');
});
test('짧은 공고 주소와 KST 공고기간 경계(사진 수·보호소 수동 상태와 독립)',()=>{
  assert.deepEqual(noticeId({noticeNo:'인천-강화-2026-00520'}),{share:'2026-00520',code:'26-520'});assert.equal(shareFromCode('26-520'),'2026-00520');assert.equal(shareFromCode('oops'),null);
  assert.throws(()=>noticeId({noticeNo:'미정'}));assert.equal(publicOrigin('https://qr.example/'),'https://qr.example');assert.throws(()=>publicOrigin('https://qr.example/path'));
  const a={noticeSdt:'20261118',noticeEdt:'20261119',processState:'보호중'};assert(inNotice(a,'20261118'));assert(inNotice(a,'20261119'));assert(!inNotice(a,'20261117'));assert(!inNotice(a,'20261120'));assert(!inNotice({...a,processState:'종료(입양)'},'20261118'));assert(!inNotice({processState:'보호중'},'20261118'));
});
test('관리자 JPG: 원본·T2 추가 순서/중복, 인증, 저장·재시작, /q/ 연결, 실제 KAWIS 자리만 OG에서 제외', {timeout:30000},async t=>{
  const {s,file,restart}=await site(t,{count:4,publicOrigin:origin,qrPictures:true,qrExtras:'<img src="/files/shelter/shared.jpg"><img src="/files/shelter/fixture-extra.jpg">',rows:[{}, {}, {popfile2:null},{popfile1:'https://www.animal.go.kr/files/shelter/wide.jpg'}]});
  const admin=await login(s);for(const p of [photo(1),'/api/admin/qr-photos.zip','/api/admin/animals'])assert.equal((await s.req(p)).status,401);
  assert.equal((await slot(s,1,1,{})).status,401);assert.equal((await slot(s,1,1,admin)).status,409);
  const list=async()=>(await (await s.req('/api/admin/animals',{headers:admin})).json()).items;
  const first=await until(async()=>{const a=(await list()).find(x=>x.desertionNo===id(1));return a?.qrPhotos.length===3 && a;});
  assert.deepEqual(first.qrPhotos.map(p=>new URL(p.thumb,'https://fixture.invalid').searchParams.get('url').split('/').pop()),['shared.jpg','second.jpg','fixture-extra.jpg']);assert(!first.qrMade && !first.qrSlot);
  assert.equal((await s.req(photo(1),{method:'HEAD',headers:admin})).status,405);
  for(const query of ['?slot=0','?slot=9','?slot=n','?slot=4','?pos=top','?force=true'])assert.equal((await s.req(photo(1)+query,{headers:admin})).status,400);
  assert.equal((await s.req(photo(999),{headers:admin})).status,404);assert.equal((await s.req(photo(1)+'?slot=2&v=stale',{headers:admin})).status,409);
  const pages=(await s.rpc('get')).pages.length;
  const r=await s.req(photo(1)+'?slot=3&pos=bl&v='+first.qrPhotos[2].v,{headers:admin});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/jpeg');assert.equal(r.headers.get('x-filename'),share(1)+'_QR.jpg');assert.match(r.headers.get('cache-control'),/no-store/);
  const fileBuf=Buffer.from(await r.arrayBuffer()),m=await sharp(fileBuf).metadata();assert.equal(m.width,1200);assert.equal(m.height,900);
  const pixel=await sharp(fileBuf).extract({left:0,top:0,width:1,height:1}).raw().toBuffer();assert(pixel[2]>pixel[0]+70,'T2 추가 원본을 사용');
  const qr=await scan(fileBuf);assert.equal(qr.data,origin+'/q/'+code(1));assert(qr.location.topLeftCorner.x<150);
  const redir=await s.req(new URL(qr.data).pathname,{redirect:'manual'});assert.equal(redir.status,302);assert.equal(redir.headers.get('location'),'/a/'+share(1));
  assert.match(await (await s.req(redir.headers.get('location'))).text(),new RegExp('window.__CARELINK_BOOT__="'+share(1)+'"'));
  assert.equal((await s.rpc('get')).pages.length,pages);const rec=()=>fs.readFile(file,'utf8').then(JSON.parse).then(db=>db.animals[id(1)]);
  assert.equal((await rec()).qrMade.url,qr.data);assert((await rec()).qrMade.verified);assert(!(await rec()).qrSlot);assert.equal((await rec()).status,'foster');assert.equal((await rec()).logs.length,1);
  assert.match(await ogImage(s,1),/shared\.jpg/);assert.equal((await slot(s,1,3,admin)).status,400);
  assert.equal((await slot(s,1,1,admin)).status,200);assert.match(await ogImage(s,1),/second\.jpg/);
  assert.equal((await slot(s,1,2,admin)).status,200);assert.match(await ogImage(s,1),/shared\.jpg/);
  assert.equal((await s.req(photo(3),{headers:admin})).status,200);assert.equal((await slot(s,3,1,admin)).status,200);assert.equal(await ogImage(s,3),null); // 오직 QR 사진뿐이면 OG 이미지 생략
  const failed=await s.req(photo(4),{headers:admin});assert.equal(failed.status,422);assert.equal((await failed.json()).code,'QR_UNREADABLE');assert(!(await list()).find(a=>a.desertionNo===id(4)).qrMade);
  assert.equal((await s.req(photo(4)+'?force=1',{headers:admin})).status,200);assert.equal(JSON.parse(await fs.readFile(file)).animals[id(4)].qrMade.verified,false);
  const publicData=await (await s.req('/api/animals')).text();assert(!/qrMade|qrSlot|qrPhotos/.test(publicData));
  const again=await restart(),auth=await login(again),rows=(await (await again.req('/api/admin/animals',{headers:auth})).json()).items;
  assert(rows.find(a=>a.desertionNo===id(1)).qrMade);assert.equal(rows.find(a=>a.desertionNo===id(1)).qrSlot,2);assert.match(await ogImage(again,1),/shared\.jpg/);
});
test('일괄 ZIP: 공고중·미생성만 최대 20마리, 1번 우하단, 실패 명단·재시도·미업로드 상태 유지', {timeout:35000},async t=>{
  const rows=Array.from({length:26},()=>({noticeSdt:date(-1),noticeEdt:date(1),popfile3:img})); // API 3장: 추가 수집과 독립
  rows[1].noticeEdt=date(-1);rows[2].noticeSdt=date(1);Object.assign(rows[3],{popfile1:null,popfile2:null,popfile3:null,noticeSdt:date(0)});
  rows[4].noticeNo='공고번호 미정';rows[5].popfile1='https://www.animal.go.kr/files/shelter/wide.jpg';
  // 사진이 없는 개체에 새 상세 정보를 만들어 주지 않는 스냅샷 모의 응답
  const {s,file}=await site(t,{count:rows.length,rows,qrPictures:true,qrExtras:'<html>추가 사진 없음</html>'},{[id(1)]:{status:'confirmed',logs:[],qrMade:{at:'2026-01-01T00:00:00Z'},qrSlot:1}});
  const admin=await login(s),getzip=async()=>{const r=await s.req('/api/admin/qr-photos.zip',{headers:admin});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/zip');assert.match(r.headers.get('x-filename'),/^QR-\d{8}\.zip$/);return contents(Buffer.from(await r.arrayBuffer()));};
  const z=await getzip();assert(z.has('실패목록.txt'));const report=z.get('실패목록.txt').toString();for(const k of [share(4),'공고번호 미정',share(6)])assert(report.includes(k));
  const names=[...z.keys()].filter(n=>n.endsWith('.jpg'));assert.deepEqual(names,Array.from({length:17},(_,i)=>share(i+7)+'_QR.jpg'));
  const sample=await scan(z.get(names[0]));assert.equal(sample.data,s.base+'/q/'+code(7));assert(sample.location.topLeftCorner.x>150);
  const d=JSON.parse(await fs.readFile(file)).animals;assert.equal(Object.values(d).filter(a=>a.qrMade).length,18);assert(!d[id(7)].qrSlot);assert(!d[id(24)]);assert.equal(d[id(1)].qrSlot,1);
  const next=await getzip();assert.deepEqual([...next.keys()].filter(n=>n.endsWith('.jpg')),[24,25,26].map(n=>share(n)+'_QR.jpg'));assert(next.has('실패목록.txt'));
});
test('모의 MongoDB: QR만 부분 저장, 케어 상태/과거 기록 유지, 저장 실패는 생성 완료/다운로드로 처리하지 않음', {timeout:20000},async t=>{
  for(const fail of [false,true]){
    const {s,file}=await site(t,{count:3,mockCareDB:true,rejectQrWrite:fail,publicOrigin:origin});const old=await fs.readFile(file);
    const admin=await login(s);await s.rpc('db');const r=await s.req(photo(2),{headers:admin});assert.equal(r.status,fail?503:200);
    if(fail){assert.equal((await r.json()).code,'SAVE');assert.equal((await slot(s,2,1,admin)).status,409);}
    else {
      assert.equal((await slot(s,2,2,admin)).status,200);assert.match(await ogImage(s,2),/shared\.jpg/);
      const logs=await (await s.req(`/api/animals/${id(2)}/logs`)).json();assert.deepEqual(logs,{status:'adopting',logs:[]});
      const writes=(await s.rpc('get')).qrWrites;assert.deepEqual(writes.map(w=>Object.keys(w.patch)),[['qrMade'],['qrSlot']]);assert.deepEqual(await fs.readFile(file),old);
    }
  }
});

test('8번 원본도 선택 가능, 생성 중 공개 목록 정상, 로컬 원본/관리번호 없는 개체도 기존 케어 키에 기록', {timeout:18000},async t=>{
  const eight=Object.fromEntries(Array.from({length:8},(_,i)=>['popfile'+(i+1),'https://www.animal.go.kr/files/shelter/test-'+(i+1)+'.jpg']));
  const {s,dir,file}=await site(t,{count:3,holdPhoto:'test-8.jpg',qrPictures:true,rows:[eight,{}, {desertionNo:'',popfile1:'/img/test.jpg',popfile2:''}]});
  const admin=await login(s);await fs.mkdir(path.join(dir,'img'),{recursive:true});await fs.writeFile(path.join(dir,'img/test.jpg'),await jpg(800,600));
  const data=(await(await s.req('/api/admin/animals',{headers:admin})).json()).items;const last=data.find(a=>a.desertionNo===id(1)).qrPhotos[7];assert(last.thumb.includes('test-8.jpg'));
  const job=s.req(photo(1)+'?slot=8&v='+last.v,{headers:admin});await until(async()=>(await s.rpc('get')).qrWait);
  try{assert.equal((await s.req('/api/admin/qr-photos.zip',{headers:admin})).status,409);assert.equal((await s.req('/api/animals')).status,200);}finally{await s.rpc('qrImage');}
  assert.equal((await job).status,200);const key='인천-강화-'+share(3);
  const r=await s.req('/api/admin/qr-photo/'+encodeURIComponent(key),{headers:admin});assert.equal(r.status,200);assert.equal((await scan(Buffer.from(await r.arrayBuffer()))).data,s.base+'/q/'+code(3));
  const db=JSON.parse(await fs.readFile(file));assert(db.animals[key].qrMade);assert(!db.animals['']);
});
