// Optional DOM interaction checks. Not browser layout, screenshots or live Access acceptance.
import {readFile} from 'node:fs/promises';
import {setTimeout as tick} from 'node:timers/promises';
import assert from 'node:assert/strict';
const {parseHTML}=await import(process.env.DSH_DOM_TEST_MODULE||'linkedom');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const at='2026-10-02T00:00:00Z';
const snapshot={schemaVersion:'1',generatedAt:at,source:{kind:'explicit-import',label:'Synthetic source',observedAt:at,staleAfterMs:900000},tasks:[{taskId:'private',title:'Private task fixture',description:'Private body fixture',state:'running',kind:'observed',createdAt:at,updatedAt:at,tags:[]}],runs:[],reports:[],artifacts:[],events:[],templates:[]};
let count=0;
const check=(name,fn)=>{fn();count++;console.log(`PASS ${name}`);};
for(const scenario of ['unauthorized','redirect','html','expiry']){
 const {window,document}=parseHTML(html);const timers=new Map();let timerId=0,reads=0,reloads=0;
 const location={href:'https://tasks.example.test/',hash:'#tasks',reload:()=>reloads++};
 const expiry=Date.now()+60000;
 window.DSH_DASHBOARD_CONFIG={requireSessionExpiry:true};window.scrollTo=()=>{};
 let next=()=>new Response(JSON.stringify(snapshot),{headers:{'content-type':'application/json','x-dsh-session-expires-at':new Date(expiry).toISOString()}});
 Object.assign(globalThis,{window,document,location,fetch:async()=>{reads++;return next();},setInterval:()=>0,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
 await import(`../public/app.js?auth-scenario=${scenario}`);await tick(10);
 check(`${scenario}: initial authorized data is displayed`,()=>assert.match(document.querySelector('#main').textContent,/Private task fixture/));
 if(scenario==='unauthorized'){
  snapshot.runs=[{runId:'missing-key',taskId:'private',state:'uncertain',outcome:'unknown',validation:'not-submitted',createdAt:at,updatedAt:at,sessionIds:[]}];
  snapshot.events=[{eventId:'native-error',runId:'missing-key',taskId:'private',type:'run.settled',at,detail:{summary:'MISSING_CREDENTIAL'}},{eventId:'other-run-error',runId:'different-run',taskId:'private',type:'run.settled',at,detail:{summary:'NO_ADAPTER'}}];
  document.querySelector('#refresh-button').dispatchEvent(new window.Event('click',{bubbles:true}));await tick(10);
  location.hash='#runs';window.dispatchEvent(new window.Event('hashchange'));
  check('uncertain run with no report shows only its own safe native diagnostic',()=>{const text=document.querySelector('.run-item').textContent;assert.match(text,/结果待确认/);assert.match(text,/未提交/);assert.match(text,/0 份/);assert.match(text,/MISSING_CREDENTIAL/);assert.doesNotMatch(text,/NO_ADAPTER/);assert.equal(snapshot.reports.length,0);});
  location.hash='#tasks';window.dispatchEvent(new window.Event('hashchange'));
 }
 const click=selector=>document.querySelector(selector).dispatchEvent(new window.Event('click',{bubbles:true}));
 const success=next;next=()=>new Response('{}',{status:503});click('#refresh-button');await tick(10);
 check(`${scenario}: source outage retains visibly stale records and timestamp`,()=>{assert.match(document.querySelector('#main').textContent,/Private task fixture/);assert.match(document.querySelector('.error-banner').textContent,/非实时.*截至/);assert.match(document.querySelector('#connection-status').textContent,/非实时/);});
 next=success;click('#refresh-button');await tick(10);
 check(`${scenario}: recovery removes outage state`,()=>{assert.equal(document.querySelector('.error-banner'),null);assert.match(document.querySelector('#main').textContent,/Private task fixture/);});
 if(scenario==='expiry'){
  const originalNow=Date.now;Date.now=()=>expiry+1;window.dispatchEvent(new window.Event('pageshow'));Date.now=originalNow;
 }else{
  next=scenario==='unauthorized'?()=>new Response('{}',{status:401}):scenario==='redirect'?()=>({type:'opaqueredirect'}):()=>new Response('<html>Login</html>',{headers:{'content-type':'text/html'}});
  click('#refresh-button');await tick(10);
 }
 check(`${scenario}: authentication loss removes private content and counts`,()=>{assert.doesNotMatch(document.querySelector('#main').textContent,/Private task fixture|Private body fixture/);assert.equal(document.querySelector('#task-count').textContent,'—');assert.match(document.querySelector('#footer-source').textContent,/上次成功读取/);assert.match(document.querySelector('#main').textContent,/请重新验证身份/);});
 const previousReads=reads;document.dispatchEvent(new window.Event('visibilitychange'));await tick(10);
 check(`${scenario}: no retry loop; explicit login performs top-level reload`,()=>{assert.equal(reads,previousReads);click('[data-action="login"]');assert.equal(reloads,1);});
}
console.log(JSON.stringify({passed:count,total:21,method:'DOM-only; no visual or real Access acceptance claim'}));
