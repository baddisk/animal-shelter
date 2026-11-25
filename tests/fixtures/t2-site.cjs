// Local integration fixtures. Never import the production instance or its data/. No cloud keys required.
'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');const root=path.resolve(__dirname,'../..');
const img='https://www.animal.go.kr/files/shelter/shared.jpg';
const id=n=>String(400000000000000+n);const share=n=>`${new Date(Date.now()+9*3600000).getUTCFullYear()}-${String(n).padStart(5,'0')}`;
const short=s=>BigInt('0x'+createHash('sha256').update(s).digest('hex').slice(0,10)).toString(36).slice(0,5).padStart(5,'0');
async function makeSite(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'carelink-t2-test-'));
 try{for(const name of ['server','lib','services','js','css','public','index.html','admin.html','sw.js','package.json','manifest.webmanifest','logo.svg'])await fs.cp(path.join(root,name),path.join(dir,name),{recursive:true});
 await fs.mkdir(path.join(dir,'data'));
 await fs.writeFile(path.join(dir,'data/db.json'),JSON.stringify({animals:{[id(1)]:{status:'foster',logs:[{type:'care',date:'20261101',title:'TEST_ONLY_FREE_TEXT'}]}}}));
 const events=[{ts:new Date().toISOString(),event:'page_view',id:null,meta:{}}];
 await fs.writeFile(path.join(dir,'data/events.json'),JSON.stringify(events));
 return dir;}catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
}
async function boot(dir,options={}){
 const password=randomUUID();const child=fork(path.join(__dirname,'t2-runner.cjs'),[],{cwd:dir,execArgv:[],silent:true,env:{...process.env,NODE_PATH:path.join(root,'node_modules'),TEST_DIR:dir,TEST_OPTIONS:JSON.stringify(options),NODE_ENV:options.noKey?'production':'test',RENDER:'',PUBLIC_ORIGIN:options.publicOrigin || '',MONGODB_URI:options.mockCareDB?'mongodb://fixture.invalid/test':'',MONGODB_DB:'',API_KEY:options.noKey?'':'local-fixture',ADMIN_PASSWORD:options.noPassword?'':password,DATA_DIR:path.join(dir,'cache'),PORT:'0'}});
 let id=0,logs='',pending=new Map();for(const st of [child.stdout,child.stderr])st.on('data',d=>{logs=(logs+d).slice(-1600)});
 let onReady,fail;const ready=new Promise((r,j)=>{onReady=r;fail=j});
 const exited=new Promise(r=>child.once('exit',r));child.once('error',fail);child.on('exit',()=>{const e=Error('fixture stopped: '+logs);fail(e);for(const p of pending.values())p.reject(e);pending.clear();});
 child.on('message',m=>{if(m.ready){onReady(m.ready);return;}const p=pending.get(m.rid);if(p){pending.delete(m.rid);p.resolve(m.value);}});
 const tm=setTimeout(()=>{child.kill();fail(Error('fixture startup timeout'));},9000);let port;try{port=await ready;}finally{clearTimeout(tm);}
 const base='http://127.0.0.1:'+port;const rpc=(op,value)=>new Promise((resolve,reject)=>{let rid=++id;pending.set(rid,{resolve,reject});child.send({rid,op,value});});
 return {dir,password,base,req:(url,init={})=>fetch(base+url,{signal:AbortSignal.timeout(15000),...init}),rpc,
   async close(){if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}}};
}
async function until(fn,ms=7000){const end=Date.now()+ms;let value;while(Date.now()<end){value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,15));}throw Error('fixture condition timeout');}
module.exports={makeSite,boot,until,id,share,short,img};
