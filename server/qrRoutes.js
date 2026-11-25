'use strict';
const {once}=require('node:events');
const {pipeline}=require('node:stream/promises');
const {pathToFileURL}=require('node:url');
const {QrError,noticeId,publicOrigin,inNotice,makeQrPhoto}=require('../services/qrPhoto');

// 1개 노드에서 원본 다운로드/합성은 한 번에 하나. 방문자 목록·공유·관리자 상태 조회는 막지 않는다.
function registerQrRoutes({app,requireAdmin,dbReady,items,keyOf,adminItem,photos,sourceKey,original,getRec,writeFields,today}) {
  let working=false;
  const fail=(s,c,m)=>new QrError(s,c,m);
  const route=fn=>async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try { await dbReady; await fn(req,res); }
    catch(e) {
      if(res.destroyed) return;
      if(res.headersSent) { res.destroy(); return; }
      res.status(e instanceof QrError?e.status:500).json(e instanceof QrError?{error:e.message,code:e.code}:{error:'QR 사진 작업에 실패했습니다. 다시 시도해 주세요.'});
    }
  };
  const generation=fn=>route(async(req,res)=>{
    if(req.method!=='GET') { res.set('Allow','GET').sendStatus(405); return; } // HEAD로 생성 기록을 남기지 않음
    if(working) throw fail(409,'BUSY','다른 QR 사진을 만들고 있습니다. 완료 후 다시 시도해 주세요.');
    working=true;try { await fn(req,res); } finally { working=false; }
  });
  const find=async no=>{
    const a=(await items()).find(x=>keyOf(x)===no);
    if(!a)throw fail(404,'ANIMAL','개체를 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    return a;
  };
  const origin=req=>publicOrigin(process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`);
  async function build(a,base,slot,pos,force,expected) {
    const {share,code}=noticeId(a),src=photos(a)[slot-1];
    if(!src) throw fail(400,'SLOT',`${slot}번 원본 사진이 없습니다.`);
    if(expected!==undefined && expected!==sourceKey(src)) throw fail(409,'CHANGED','사진 목록이 바뀌었습니다. 목록을 새로고침한 뒤 다시 골라 주세요.');
    const url=`${base}/q/${code}`;
    let photo;try {photo=await original(src);} catch (_) {throw fail(502,'ORIGINAL','원본 사진을 받지 못했습니다. 다른 사진을 고르거나 나중에 다시 시도해 주세요.');}
    const {buffer,ratio,verified}=await makeQrPhoto(photo,url,pos,{skipVerify:force});
    return {buffer,name:`${share}_QR.jpg`,fields:{qrMade:{at:new Date().toISOString(),url,ratio,verified}}};
  }
  const attachment=(res,type,name)=>res.set({'Content-Type':type,'Content-Disposition':`attachment; filename="${name}"`,'X-Filename':name});
  app.get('/api/admin/animals',requireAdmin,route(async(_req,res)=>res.json({items:(await items()).map(adminItem)})));
  app.get('/api/admin/qr-photo/:desertionNo',requireAdmin,generation(async(req,res)=>{
    const {slot='1',pos='br',force='0',v}=req.query;
    if(typeof slot!=='string'||!/^([1-8])$/.test(slot)||!['br','bl'].includes(pos)||!['0','1'].includes(force)) throw fail(400,'OPTIONS','원본은 1~8번, 위치는 우하단 또는 좌하단을 선택해 주세요.');
    const a=await find(req.params.desertionNo), result=await build(a,origin(req),Number(slot),pos,force==='1',v);
    if(res.destroyed)return;
    await writeFields(keyOf(a),result.fields);
    attachment(res,'image/jpeg',result.name).send(result.buffer);
  }));
  app.put('/api/admin/animals/:desertionNo/qr-slot',requireAdmin,route(async(req,res)=>{
    const a=await find(req.params.desertionNo),key=keyOf(a),slot=req.body?.qrSlot;
    if(slot!==1 && slot!==2)throw fail(400,'QR_SLOT','실제 올린 자리는 1번 또는 2번이어야 합니다.');
    if(!getRec(key)?.qrMade) throw fail(409,'NOT_MADE','QR 사진을 만든 뒤 업로드 자리를 기록해 주세요.');
    await writeFields(key,{qrSlot:slot});res.json({ok:true,qrSlot:slot});
  }));
  app.get('/api/admin/qr-photos.zip',requireAdmin,generation(async(req,res)=>{
    const base=origin(req),day=today(), rows=(await items()).filter(a=>inNotice(a,day)&&!getRec(keyOf(a))?.qrMade&&!getRec(keyOf(a))?.qrSlot).slice(0,20);
    const {ZipArchive}=await import(pathToFileURL(require.resolve('archiver')).href);
    if(res.destroyed)return;
    const zip=new ZipArchive({store:true}), abort=new AbortController();
    const cancel=()=>{if(!res.writableFinished){abort.abort();zip.destroy();}};
    res.once('close',cancel);
    attachment(res,'application/zip',`QR-${day}.zip`);
    const sent=pipeline(zip,res);sent.catch(()=>abort.abort());
    async function add(data,name){
      abort.signal.throwIfAborted();const ready=once(zip,'entry',{signal:abort.signal});
      zip.append(data,{name});await ready; // 다음 원본을 받기 전에 이번 항목 배출: JPEG 20장을 RAM에 쌓지 않는다.
    }
    try {
      const report=[], names=new Set();
      await add('\uFEFF'+(rows.length?'공고 기간 중 QR 미생성 개체 중 최대 20마리를 처리합니다. JPG는 KAWIS 1·2번에 수동으로 올리고 관리자에서 자리를 기록해 주세요.':'현재 공고 중인 QR 미생성 개체가 없습니다.'),'안내.txt');
      for(const a of rows){
        abort.signal.throwIfAborted();let result;
        try {
          result=await build(a,base,1,'br',false);
          if(names.has(result.name))throw fail(409,'DUPLICATE','중복 공고번호입니다. 개별 사진 만들기를 이용해 주세요.');
          abort.signal.throwIfAborted();await writeFields(keyOf(a),result.fields);
        }catch(e){
          abort.signal.throwIfAborted();const no=String(a.noticeNo || a.desertionNo).replace(/[\r\n\t]/g,' ').slice(0,80);
          report.push(`${no} — ${e instanceof QrError?e.message:'사진을 만들지 못했습니다.'}`);continue;
        }
        names.add(result.name);await add(result.buffer,result.name);
      }
      if(report.length)await add('\uFEFF'+report.join('\r\n')+'\r\n','실패목록.txt');
      await zip.finalize();await sent;
    }finally{res.off('close',cancel);if(!res.writableFinished){abort.abort();zip.destroy();}await sent.catch(()=>{});}
  }));
}
module.exports={registerQrRoutes};
