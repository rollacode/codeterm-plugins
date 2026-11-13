const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {installTestHostIo} = require('../../scripts/host-io-fixture.cjs');
function fixture() {
  const calls=[], writes=[], secrets={session:'session-fixture'};
  let networkFailure=false, stopped=false;
  const item={id:'item-1',type:1,name:'fixture',login:{password:'SECRET-SENTINEL'},notes:null};
  const exec=raw=>{const opts=JSON.parse(raw);calls.push(opts);return JSON.stringify({code:0,stdout:JSON.stringify({success:true,data:item})});};
  exec.start=opts=>{calls.push(opts);stopped=false;return {jobId:'serve-job'};};
  exec.poll=()=>({done:stopped});
  exec.close=()=>{stopped=true;};
  const sandbox={module:{exports:{}},host:{
    dataDir:()=>'/instance', platform:()=> 'win32', exec,
    secretGet:key=>secrets[key]||null, secretSet:(key,value)=>{secrets[key]=value;return true;},secretDelete:key=>{delete secrets[key];return true;},
    fs:{makeDirs:()=>true,readJson:()=>({port:43210}),writeFile:(file,body)=>{writes.push(body);return true;},removeFile:()=>true},
    fetch:raw=>{calls.push(JSON.parse(raw));return JSON.stringify(networkFailure?{error:'SECRET-SENTINEL'}:{status:200,body:JSON.stringify({success:true,data:item})});},
  }};
  installTestHostIo(sandbox); vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin.js'),'utf8'),sandbox);
  return {plugin:sandbox.module.exports.default,calls,writes,secrets,host:sandbox.host,failNetwork(){networkFailure=true;},stopped:()=>stopped};
}
test('warm reads reuse one owned loopback service and write no values',()=>{
  const f=fixture();
  for(let i=0;i<2;i++)assert.equal(f.plugin.secretGetItem('fixture').ok.value,'SECRET-SENTINEL');
  assert.equal(f.calls.filter(c=>c.bin==='node').length,1);
  assert.equal(f.calls.filter(c=>c.bin==='bw').length,0);
  assert.equal(f.calls.filter(c=>c.url).length,2);
  assert(f.calls.filter(c=>c.url).every(c=>c.url==='http://127.0.0.1:43210/object/item/fixture'));
  assert(f.writes.every(body=>body==='{"port":43210}'));
  f.plugin.secretLock();assert.equal(f.stopped(),true);assert.equal(f.secrets.session,undefined);
  assert.equal(f.plugin.secretGetItem('fixture').error.kind,'locked');
});
test('a failed service uses async CLI fallback without surfacing response data',()=>{
  const f=fixture();f.failNetwork();
  assert.equal(f.plugin.secretGetItem('fixture').ok.value,'SECRET-SENTINEL');
  assert.equal(f.calls.filter(c=>c.bin==='bw').length,1);
  assert.equal(f.stopped(),true);
  assert(f.writes.every(body=>!body.includes('SECRET-SENTINEL')));
});
test('locking during a suspended HTTP read discards the late item',()=>{
  const f=fixture();const run=f.host.io.run;
  f.host.io.run=steps=>steps;
  const steps=f.plugin.secretGetItem('fixture');
  let next=steps.next();
  while(!next.done && next.value.op!=='fetch'){
    const r=next.value;let reply;
    if(r.op==='secretGet')reply=f.host.secretGet(r.name);
    else if(r.op==='execStart')reply=f.host.exec.start(r.options);
    else if(r.op==='execPoll')reply=f.host.exec.poll(r.job);
    else if(r.op==='writeFile')reply=f.host.fs.writeFile(r.path,r.contents);
    else reply=f.host.fs[r.op](r.path,...(r.args||[]));
    next=steps.next(reply);
  }
  assert.equal(next.value.op,'fetch');
  f.host.io.run=run;f.plugin.secretLock();
  next=steps.next({status:200,body:JSON.stringify({success:true,data:{id:'late',name:'fixture',login:{password:'SECRET-SENTINEL'}}})});
  while (!next.done) { const r=next.value; next=steps.next(r.op === "secretGet" ? f.host.secretGet(r.name) : undefined); }
  // runWithSession returns locked without a remembered master, never the late value.
  assert.equal(next.done,true);assert.equal(next.value.error.kind,'locked');
  assert(!JSON.stringify(next.value).includes('SECRET-SENTINEL'));
});
test('locking during a suspended CLI fallback also discards the late item',()=>{
  const f=fixture();delete f.host.dataDir;
  const run=f.host.io.run;f.host.io.run=steps=>steps;
  const steps=f.plugin.secretGetItem('fixture');let next=steps.next();
  while(!next.done && next.value.op!=='exec')next=steps.next(f.host.secretGet(next.value.name));
  assert.equal(next.value.op,'exec');
  f.host.io.run=run;f.plugin.secretLock();
  next=steps.next({code:0,stdout:JSON.stringify({success:true,data:{id:'late',name:'fixture',login:{password:'SECRET-SENTINEL'}}})});
  assert.equal(next.done,true);assert.equal(next.value.error.kind,'locked');
  assert(!JSON.stringify(next.value).includes('SECRET-SENTINEL'));
});
