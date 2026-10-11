const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const profile = { id:'coding',name:'Coding',endpoint:'local',model:'fixture',systemPrompt:'  exact\n',root:'/project',allow:['read_file','write_file','edit_file','shell','glob','search'],deny:[],budgets:{tokens:10000,turns:8,deadlineMs:10000} };
function fixture(replies = []) {
 const files = new Map(); const requests=[]; const writes=[]; let clock=100; let job=0;
 const config={endpoints:[{id:'local',baseUrl:'http://localhost:1234/v1',models:['fixture']}],profiles:[profile],defaultProfile:'coding'};
 const host={settingsJson:()=>JSON.stringify(config),unixNowMs:()=>clock,platform:()=> 'linux',secretGet:()=>null,
  canonicalPath:p => p==='/project'||files.has(p) ? p : null,isSymlink:()=>false,fileExists:p=>files.has(p),
  readFile:p=>files.get(p)??null,readFileHead:(p,n)=>(files.get(p)??null)?.slice(0,n),
  writeFileAtomic:(p,s)=>{files.set(p,s);writes.push(p);return true},makeDirs:()=>true,lockFile:()=> 'lock',unlockFile:()=>true,
  fs:{expandHome:()=>'/state',readDir:()=>[]},shell:{quoteFor:s=>`'${s}'`},
  fetch:{stream:opts=>{requests.push(JSON.parse(opts.body));return {jobId:String(job++)}},streamPoll:()=>({done:true,status:200,chunks:[JSON.stringify(replies.shift())]}),streamClose:()=>{}},
  exec:{start:()=>({jobId:'exec'}),poll:()=>({done:true,code:0,stdout:'ok'}),close:()=>{}} };
 const context={host,module:{exports:{}},exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/plugin.js','utf8'),context);
 return {plugin:context.module.exports.default,files,requests,writes,config,advance:()=>clock+=20000};
}
function reply(content, calls) {return {choices:[{message:{content,tool_calls:calls}}],usage:{total_tokens:10}}}
function call(id,name,args) {return {id,type:'function',function:{name,arguments:JSON.stringify(args)}}}
test('deny wins, reader gets no shell, unknown tools are refused',()=>{
 const t=fixture().plugin.__test;
 assert.equal(t.permitted({...profile,deny:['read_file']},'read_file'),false);
 assert.equal(t.permitted({...profile,readOnly:true},'shell'),false);
 assert.equal(t.permitted({...profile,readOnly:true},'write_file'),false);
 assert.equal(t.permitted({...profile,allow:['invented']},'invented'),false);
 assert.equal(t.offeredTools({...profile,deny:['*']}).length,0);
});
test('path and stale edit decisions',()=>{
 const t=fixture().plugin.__test;
 for(const p of ['../secret','/outside','a/../b','NUL','x:stream','a\\..\\b']) assert.throws(()=>t.relativePath('/root',p));
 assert.equal(t.inside('/root','/root2/x'),false);
 assert.equal(t.edited('a b','a b','b','$&'),'a $&');
 assert.throws(()=>t.edited('changed','old','x','y'),/stale/);
 assert.throws(()=>t.edited('aa','aa','a','b'),/unique/);
 assert.equal(t.globPattern('**/*.ts').test('a.ts'),true);
});
test('native wire preserves exact prompt and policy',()=>{
 const t=fixture().plugin.__test;
 const r=t.request({baseUrl:'http://localhost:1234/v1'}, {...profile,readOnly:true},[],null,123);
 const b=JSON.parse(r.body);
 assert.equal(b.messages[0].content,profile.systemPrompt);
 assert.equal(b.max_tokens,123);
 assert.equal(b.tools.some(t=>t.function.name==='shell'),false);
 assert.throws(()=>t.response(JSON.stringify({choices:[{message:{content:'x'}}]})),/usage/);
});
test('completed and unconfirmed ledger calls never replay',()=>{
 const t=fixture().plugin.__test, h={ledger:{},turns:[]};
 assert.equal(t.claim(h,'id','sig'),null);
 assert.match(t.claim(h,'id','sig'),/unconfirmed/);
 t.complete(h,'id','result');assert.equal(t.claim(h,'id','sig'),'result');
 assert.match(t.claim(h,'id','different'),/reused/);
 h.turns=[{role:'assistant',content:'',toolCalls:[{id:'lost',name:'write_file',arguments:'{}'}]}];
 t.recover(h);assert.match(h.turns[1].content,/unconfirmed/);t.recover(h);assert.equal(h.turns.length,2);
});
test('tool loop writes, edits, persists history and returns final response',()=>{
 const f=fixture([reply('',[call('write','write_file',{path:'a.txt',content:'one',expected:''})]),reply('',[call('edit','edit_file',{path:'a.txt',expected:'one',old:'one',new:'two'})]),reply('finished')]);
 const p=f.plugin;p.profileOpen('session','coding');p.profileSend('session','create then edit');
 for(let i=0;i<5;i++) p.profilePump('session');
 assert.equal(f.files.get('/project/a.txt'),'two');
 assert.equal(p.profilePoll('session').done,true);
 assert.equal(p.profilePoll('session').messages.at(-1).content,'finished');
 const h=JSON.parse(f.files.get('/state/session-session.json'));
 assert.equal(h.ledger.write.state,'completed');assert.equal(h.ledger.edit.state,'completed');
 assert.equal(f.requests[1].messages.at(-1).role,'tool');
 p.profileClose('session');p.profileOpen('session','coding',true);
 assert.equal(p.profilePoll('session').messages.at(-1).content,'finished');
});
test('dispatch refuses denied writes even if endpoint emits them',()=>{
 const f=fixture([reply('',[call('bad','write_file',{path:'a.txt',expected:'',content:'bad'})]),reply('refused')]);
 f.config.profiles=[{...profile,readOnly:true}];
 const p=f.plugin;p.profileOpen('reader','coding');p.profileSend('reader','write');
 for(let i=0;i<3;i++)p.profilePump('reader');
 assert.equal(f.files.has('/project/a.txt'),false);
 assert.match(JSON.stringify(p.profilePoll('reader').messages),/tool refused/);
});
test('deadline cancels before tool execution',()=>{
 const f=fixture([reply('',[call('bad','write_file',{path:'a.txt',expected:'',content:'bad'})])]);
 const p=f.plugin;p.profileOpen('deadline','coding');p.profileSend('deadline','write');f.advance();p.profilePump('deadline');
 assert.equal(f.files.has('/project/a.txt'),false);assert.equal(p.profilePoll('deadline').done,true);
});
