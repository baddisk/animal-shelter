'use strict';
// 실제 공개 JS의 선택/화질 판단만 VM에서 검증한다. 브라우저 패키지나 외부 사진이 필요 없다.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const script = new vm.Script(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'));
const root = 'https://shelter.example/', raw = 'https://www.animal.go.kr/files/shelter/test-a.jpg';
const animal = {desertionNo:'1', popfile1:raw};
const proxy = w => `${root}api/image-proxy?url=${encodeURIComponent(raw)}&w=${w}`;
function scene() {
  const window = {location:{href:root}, devicePixelRatio:2, visualViewport:{scale:1}};
  const ctx = vm.createContext({window, URL, document:{addEventListener(){}}});
  script.runInContext(ctx);
  const image = {src:proxy(400), currentSrc:proxy(800), complete:true, naturalWidth:400, naturalHeight:300, dataset:{}};
  const card = {dataset:{animalKey:'1'}, querySelector:()=>image};
  const first = ctx.extractAllImages(animal)[0];
  return {ctx,window,image,card,first};
}
test('누른 카드의 실제 800px을 선택한다: 다른 개체/사진, QR, 미로딩, 오류 대체 그림은 거부',()=>{
  const {ctx,image,card,first} = scene();
  const read = (source=card) => ctx.readReadyCardPhoto(source,animal,first);
  const asset=read(); assert.equal(asset.src,proxy(800));assert.equal(asset.width,800);assert.equal(asset.aspect,4/3);
  assert.equal(read(null),null);card.dataset.animalKey='2';assert.equal(read(),null);card.dataset.animalKey='1';
  for(const src of [proxy(800).replace('test-a','test-b'),proxy(800).replace('shelter.example','other.example'),'data:image/svg+xml,test']){
    image.currentSrc=src;assert.equal(read(),null);
  }
  image.currentSrc=proxy(400);assert.equal(read().width,400);
  image.complete=false;assert.equal(read(),null);image.complete=true;image.dataset.fallback='1';assert.equal(read(),null);
  image.dataset.fallback='';image.naturalWidth=0;assert.equal(read(),null);
});
test('갤러리 병합·첫 썸네일 재생성 후에도 같은 카드 주소, 실제 사진 영역과 확대 배율로만 화질 결정',()=>{
  const {ctx,window,card,first}=scene();const asset=ctx.readReadyCardPhoto(card,animal,first);
  first.cardPhoto=asset;first.previewUrl=asset.src;
  const images=ctx.mergeAllImagesSmart([first],['https://www.animal.go.kr/files/shelter/extra.jpg']);
  assert.equal(images[0].cardPhoto,asset);assert(ctx.modalThumbStripHtml(images,0).includes(asset.src));
  const box={clientWidth:390,clientHeight:280};assert.equal(ctx.modalTargetUrl(images[0],box),proxy(800));
  assert.equal(ctx.modalTargetUrl(images[1],box),images[1].url);assert.equal(ctx.modalTargetUrl({url:'qr-full'},box),'qr-full');
  window.visualViewport.scale=2;assert.equal(ctx.modalTargetUrl(images[0],box),first.url);window.visualViewport.scale=1;
  assert.equal(ctx.modalTargetUrl(images[0],{clientWidth:720,clientHeight:420}),first.url);
  asset.fullReady=true;assert.equal(ctx.modalTargetUrl(images[0],box),first.url);
});
test('충분한 첫 사진은 1000px을 요청하지 않으며, 다음 사진에서 첫 장으로 돌아오는 선로딩도 생략',async()=>{
  const {ctx,window,card,first}=scene();const asset=ctx.readReadyCardPhoto(card,animal,first);first.cardPhoto=asset;first.previewUrl=asset.src;
  const main={src:asset.src,dataset:{},classList:{remove(){}},parentElement:{clientWidth:390,clientHeight:280}};
  const idle=[],loads=[];window.requestIdleCallback=fn=>{idle.push(fn);};ctx.document.getElementById=()=>main;
  ctx.loadModalFullImage=async(url,priority)=>{loads.push([url,priority]);};
  ctx.photos=[first,{url:'second-full'}];vm.runInContext('modalImages=photos; modalImageIndex=0; isModalOpen=true; activeAnimal={};',ctx);
  await ctx.upgradeModalMainImage(0);assert.deepEqual(loads,[]);assert.equal(main.dataset.fullSrc,asset.src);
  idle.shift()();assert.deepEqual(loads,[['second-full','low']]);
  vm.runInContext('modalImageIndex=1',ctx);ctx.preloadAdjacentModalImage(1);idle.shift()();assert.equal(loads.length,1);
});
test('큰 화면의 1000px은 준비된 뒤에만 교체하고, 기다리는 중 다른 장을 골랐다면 건드리지 않음',async()=>{
  const {ctx,card,first}=scene();const asset=ctx.readReadyCardPhoto(card,animal,first);first.cardPhoto=asset;first.previewUrl=asset.src;
  const main={src:asset.src,dataset:{},classList:{remove(){}},parentElement:{clientWidth:720,clientHeight:420}};
  ctx.document.getElementById=()=>main;let release;ctx.loadModalFullImage=url=>{assert.equal(url,first.url);return new Promise(r=>release=r);};
  ctx.photos=[first];vm.runInContext('modalImages=photos;modalImageIndex=0;isModalOpen=true;',ctx);
  let job=ctx.upgradeModalMainImage(0);assert.equal(main.src,asset.src);vm.runInContext('modalImageIndex=1;modalImageLoadToken++;',ctx);
  main.src='new-selection';release();await job;assert.equal(main.src,'new-selection');assert(!asset.fullReady);
  vm.runInContext('modalImageIndex=0',ctx);main.src=asset.src;job=ctx.upgradeModalMainImage(0);release();await job;
  assert.equal(main.src,first.url);assert(asset.fullReady);
});
