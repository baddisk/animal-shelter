'use strict';
const path=require('node:path'),{createRequire}=require('node:module'),http=require('node:http');
const dir=process.env.TEST_DIR;
if(!process.send || !dir || dir!==process.cwd() || !path.basename(dir).startsWith('carelink-t2-test-'))throw Error('test fixture only');
const local=createRequire(path.join(dir,'package.json')),axios=local('axios'),sharp=local('sharp'),{id,share,img}=require('./t2-site.cjs');
const opt=JSON.parse(process.env.TEST_OPTIONS||'{}');let count=opt.count||1005, fail=0;
const pd=n=>new Date(Date.now()+9*3600_000+n*86400_000).toISOString().slice(0,10).replaceAll('-','');
const log={pages:[],detail:[],animalsIn:0,orig:0,ranges:[],other:0,intervals:[]};let openList,openCrawl;
const list=opt.hold?new Promise(r=>openList=r):Promise.resolve(),crawl=opt.hold?new Promise(r=>openCrawl=r):Promise.resolve();
let allowDB;
if(opt.mockCareDB){
 const gate=new Promise(r=>allowDB=r);const modulePath=local.resolve('mongodb');
 const docs=new Map([[id(2),{_id:id(2),status:'adopting',logs:[]}]]);log.careWrites=[];
 const collection=name=>({
  find:()=>({toArray:async()=>name==='animals'?structuredClone([...docs.values()]):[]}),
  async updateOne(filter,update,options){
   if(name!=='animals'||!options?.upsert||!update.$set)throw Error('unexpected care fixture write');
   const saved=structuredClone(update.$set);docs.set(filter._id,{...saved,_id:filter._id});
   log.careWrites.push({key:filter._id,status:saved.status,logs:saved.logs.length});
  }
 });
 class FakeClient {async connect(){await gate;} db(){return {collection};}}
 require.cache[modulePath]={id:modulePath,filename:modulePath,loaded:true,exports:{MongoClient:FakeClient}};
}
const jpg=sharp({create:{width:820,height:610,channels:3,background:'#96c3aa'}}).withMetadata().jpeg().toBuffer();
const make=n=>({desertionNo:id(n),noticeNo:'인천-강화-'+share(n),orgNm:'강화군',careNm:'시험센터',happenPlace:'TEST_ONLY_PLACE',specialMark:'TEST_ONLY_MARK',officetel:'TEST_ONLY_PRIVATE',chargeNm:'TEST_ONLY_NAME',careTel:'032-000-0000',happenDt:pd(-1),noticeSdt:pd(-2),noticeEdt:pd(n<=2?1:-1),updTm:'2026-11-18 10:00:00',processState:'보호중',kindFullNm:n%5===0?'[고양이] 한국':'[개] 믹스',popfile1:img,popfile2:'https://www.animal.go.kr/files/shelter/second.jpg'});
axios.post=async()=>{throw Error('no live requests');};
axios.get=async(raw,opts={})=>{
 const u=new URL(raw);
 if(u.hostname==='apis.data.go.kr'){
  if(u.pathname.endsWith('sigungu_v2'))return {data:{response:{body:{items:{item:{orgdownNm:'강화군',orgCd:'3280000'}}}}}};
  if(u.pathname.endsWith('shelter_v2'))return {data:{response:{body:{items:{item:{careNm:'강화군 시험센터',careRegNo:'42'}}}}}};
  const p=Number(u.searchParams.get('pageNo'));log.pages.push(p);if(p===1)log.ranges.push([u.searchParams.get('bgnde'),u.searchParams.get('endde')]);await list;
  if(opt.offline||p===fail)throw Error('fixture offline');
  const rows=Array.from({length:Math.max(0,Math.min(50,count-50*(p-1)))},(_,i)=>make((p-1)*50+i+1));
  return {data:{response:{header:{resultCode:'00'},body:{totalCount:count,items:{item:rows}}}}};
 }
 if(u.hostname==='www.animal.go.kr'&&u.pathname.includes('/front/awtis/')){
  log.detail.push({no:opts.params.desertionNo,ua:opts.headers['User-Agent'],timeout:opts.timeout,time:Date.now()});await crawl;
  if(opt.offline)throw Error('fixture offline');
  return {data:'<html><img src="/files/shelter/fixture-extra.jpg"><button onclick="fn_fileDownload(123456,3)">사진</button></html>'};
 }
 if(u.hostname==='www.animal.go.kr'&&u.pathname.startsWith('/files/shelter/')){log.orig++;if(opt.offline)throw Error('fixture offline');return {data:await jpg,headers:{'content-type':'image/jpeg'}};}
 log.other++;throw Error('external access blocked in test');
};
process.on('message',({op,rid,value})=>{if(op==='list')openList?.();else if(op==='crawl')openCrawl?.();else if(op==='count')count=value;else if(op==='fail')fail=value;else if(op==='db')allowDB?.();process.send({rid,value:log});});
const realInterval=global.setInterval;global.setInterval=function(fn,ms,...args){log.intervals.push(ms);return realInterval(fn,ms,...args);};
const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.prependListener('request',req=>{if(req.url.startsWith('/api/animals'))log.animalsIn++;});this.once('listening',()=>process.send({ready:this.address().port}));return listen.call(this,0,'127.0.0.1',args.at(-1));};
local('./server/server.js');
