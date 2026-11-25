'use strict';
// T5: 이미 받은 사진을 합성한다. 이 모듈에서는 네트워크·통계·개체 DB를 건드리지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const caption = (() => {
  try { return fs.readFileSync(path.join(__dirname, '../public/assets/qr-caption.png')); }
  catch (_) { return null; } // 자산이 없어도 QR의 여백과 검증은 유지
})();
const ratios = [0.30, 0.34, 0.38, 0.42];
class QrError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
function noticeId(a) {
  const m = /(?:^|-)(20\d{2})-(\d{5})$/.exec(String(a?.noticeNo || '').trim());
  if (!m) throw new QrError(422,'NOTICE','공고번호에서 연도와 일련번호를 확인할 수 없습니다.');
  return { share:`${m[1]}-${m[2]}`, code:`${m[1].slice(2)}-${Number(m[2])}` };
}
function shareFromCode(code) {
  const m=/^(\d{2})-(\d{1,5})$/.exec(code);
  return m ? `20${m[1]}-${m[2].padStart(5,'0')}` : null;
}
function publicOrigin(raw) {
  try {
    const u=new URL(raw);
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw Error();
    return u.origin;
  } catch (_) { throw new QrError(503,'ORIGIN','사이트 공개 주소를 확인해 주세요. PUBLIC_ORIGIN에는 도메인까지만 입력합니다.'); }
}
function inNotice(a,today) {
  const date = v => { const s=String(v || '').replace(/[-.]/g,''); return /^\d{8}$/.test(s) ? s : ''; };
  const start=date(a.noticeSdt), end=date(a.noticeEdt), state=String(a.processState || '');
  if (/종료|입양|자연사|안락사|반환|기증/.test(state) || (start && start>today) || (end && end<today)) return false;
  return !!(start && end) || /공고\s*중/.test(state);
}
async function decodableAt(buf,width,expected) {
  const {data,info}=await require('sharp')(buf).resize({width}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pixels=new Uint8ClampedArray(data.buffer,data.byteOffset,data.length);
  // 원본에 다른 QR이 이미 있어도 그 QR을 우리 개체의 판독 성공으로 오인하지 않는다.
  return require('jsqr')(pixels,info.width,info.height,{inversionAttempts:'dontInvert'})?.data === expected;
}
async function makeQrPhoto(photoBuf,url,pos='br',{skipVerify=false}={}) {
  const sharp=require('sharp'), QRCode=require('qrcode');
  let base;
  try {
    base=await sharp(photoBuf,{limitInputPixels:64*1024*1024}).rotate().resize({width:1200,height:4800,fit:'inside',withoutEnlargement:true})
      .flatten({background:'#fff'}).jpeg({quality:92}).toBuffer({resolveWithObject:true});
  } catch (_) { throw new QrError(422,'IMAGE','원본 사진을 열 수 없습니다. 다른 사진을 골라 주세요.'); }
  const {width:W,height:H}=base.info, short=Math.min(W,H), pad=Math.round(short*0.03);
  if (short<4 || H/W>24) throw new QrError(422,'SIZE','사진의 가로·세로 크기가 QR 합성에 맞지 않습니다. 다른 사진을 골라 주세요.');
  const opts={errorCorrectionLevel:'M',margin:4,color:{dark:'#000000',light:'#FFFFFF'}};
  const min=QRCode.create(url,opts).modules.size+2*opts.margin;
  for(const ratio of ratios) {
    const q=Math.max(1,Math.round(short*ratio));
    if (q<min && !skipVerify) continue;
    let qr=await QRCode.toBuffer(url,{...opts,width:Math.max(q,min)});
    // 생성기가 요청 폭보다 큰 PNG를 반환할 수 있는 극소 사진(강제 생성)에서도 좌표를 지킨다.
    if (q<min) qr=await sharp(qr).resize(q,q,{kernel:'nearest'}).png().toBuffer();
    const left=pos==='bl'?pad:W-q-pad, top=H-q-pad;
    const layers=[{input:qr,left,top}];
    if(caption) {
      const cap=await sharp(caption).resize({height:Math.max(1,Math.round(q*0.26))}).png().toBuffer({resolveWithObject:true});
      const gap=Math.max(1,Math.round(pad/2)), x=pos==='bl'?left+q+gap:left-cap.info.width-gap;
      if(x>=0 && x+cap.info.width<=W) layers.push({input:cap.data,left:x,top:top+q-cap.info.height});
    }
    const buffer=await sharp(base.data).composite(layers).jpeg({quality:88}).toBuffer();
    if(skipVerify || await decodableAt(buffer,300,url)) return {buffer,ratio,verified:!skipVerify};
  }
  throw new QrError(422,'QR_UNREADABLE','가로 300px에서 이 개체의 QR을 읽지 못했습니다. 배경이 단순한 사진이나 다른 위치를 골라 주세요.');
}
module.exports={QrError,noticeId,shareFromCode,publicOrigin,inNotice,decodableAt,makeQrPhoto};
