const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const profile = { id:'coding',name:'Coding',endpoint:'local',model:'fixture',systemPrompt:'  exact\n',root:'/project',allow:['read_file','write_file','edit_file','shell','glob','search'],deny:[],budgets:{tokens:10000,turns:8,deadlineMs:10000} };
function fixture(replies = []) {
 const files = new Map(); const requests=[]; const writes=[]; let clock=100; let job=0;
 const config={endpoints:[{id:'local',baseUrl:'http://localhost:1234/v1',models:['fixture']}],profiles:[profile],defaultProfile:'coding'};
 const host={settingsJson:()=>JSON.stringify(config),unixNowMs:()=>clock,platform:()=> 'linux',secretGet:()=>null,
  projectWriteAllowed:()=>true,canonicalPath:p => p==='/project'||files.has(p) ? p : null,isSymlink:()=>false,fileExists:p=>files.has(p),
  readFile:p=>files.get(p)??null,readFileHead:(p,n)=>(files.get(p)??null)?.slice(0,n),
  writeFileAtomic:(p,s)=>{files.set(p,s);writes.push(p);return true},makeDirs:()=>true,lockFile:()=> 'lock',unlockFile:()=>true,
  fs:{expandHome:()=>'/state',readDir:()=>[]},shell:{quoteFor:s=>`'${s}'`},
  fetch:{stream:opts=>{requests.push(JSON.parse(opts.body));return {jobId:String(job++)}},streamPoll:()=>({done:true,status:200,chunks:[JSON.stringify(replies.shift())]}),streamClose:()=>{}},
  exec:{start:()=>({jobId:'exec'}),poll:()=>({done:true,code:0,stdout:'ok'}),close:()=>{}} };
 const context={host,module:{exports:{}},exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/plugin.js','utf8'),context);
 return {host,plugin:context.module.exports.default,files,requests,writes,config,advance:()=>clock+=20000};
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
test('chat_backend preserves session config, cursor, model and recovered history',()=>{
 const f=fixture([reply('answer')]);f.config.endpoints[0].models.push('other');
 const p=f.plugin;p.openSession({tabId:'chat',config:{profile:'coding',systemPrompt:''}});p.sendMessage('chat','hello');
 assert.throws(()=>p.sendMessage('chat','second'),/busy/);p.pump('chat');
 assert.equal(f.requests[0].messages[0].content,'');
 const first=p.poll('chat');assert.equal(first.done,true);assert.equal(p.poll('chat',first.cursor).messages.length,0);
 p.setModel('chat','other');assert.equal(p.sessionInfo('chat').model,'other');assert.throws(()=>p.setModel('chat','unknown'),/configured/);
 p.closeSession('chat');p.openSession({tabId:'chat',config:{profile:'coding'}});
 assert.equal(p.poll('chat').messages.at(-1).content,'answer');
 assert.equal(p.listPresets()[0].id,'coding');assert.equal(p.listModels().length,2);
});
test('predefined profiles separate read and operator capabilities',()=>{
 const t=fixture().plugin.__test, profiles=t.predefinedProfiles('local','fixture','/project');
 assert.equal(profiles.length,4);
 for(const p of profiles.filter(p=>p.readOnly)) for(const name of ['shell','write_file','send','report']) assert.equal(t.permitted(p,name),false);
 const operator=profiles[3];assert.throws(()=>t.domiosCommand(operator,'send',{tab:'outside',text:'hello'}),/scope/);
 const scoped={...operator,targets:{tabs:['inside']}};
 assert.equal(t.domiosCommand(scoped,'send',{tab:'inside',text:'$(unsafe)'}).stdin,'$(unsafe)');
 assert.equal(t.domiosCommand(scoped,'send',{tab:'inside',text:'hello'}).args.includes('sh'),false);
 assert.equal(t.domiosCommand(profiles[2],'tab_list',{}).args.join(' '),'tab list --json');
});
test('Inspector native tool runs the instance CLI without a shell',()=>{
 const f=fixture([reply('',[call('tabs','tab_list',{})]),reply('listed')]);
 delete f.config.profiles;f.config.model='fixture';f.config.root='/project';
 const p=f.plugin;p.openSession({tabId:'inspector',config:{profile:'domios-inspector'}});p.sendMessage('inspector','list tabs');
 for(let i=0;i<4;i++)p.pump('inspector');
 assert.equal(p.poll('inspector').done,true);
 assert.match(JSON.stringify(p.poll('inspector').messages),/stdout/);
});
test('Blueprint Agent entry returns structured output, executes native tools and never reruns a completed task',()=>{
 const f=fixture();const p=f.plugin;
 const replies=[reply('',[call('write','write_file',{path:'stage.txt',expected:'',content:'stage'})]),reply('{"created":true}')];
 const hostInput={runId:'stage',tabId:'owner',workspaceId:'workspace',profile:'coding',task:'create file',input:'',timeoutMs:10000,maxTokens:1000,maxTurns:4};
 // The fixture drives the same continuation bridge that QuickJS resumes on job completion.
 const context={host:{},module:{exports:{}},exports:{}};
 const files=f.files;
 Object.assign(context.host,{settingsJson:()=>JSON.stringify(f.config),unixNowMs:()=>100,platform:()=> 'linux',secretGet:()=>null,
  projectWriteAllowed:()=>true,canonicalPath:path=>path==='/project'||files.has(path)?path:null,isSymlink:()=>false,fileExists:path=>files.has(path),
  readFile:path=>files.get(path)??null,readFileHead:(path,n)=>(files.get(path)??null)?.slice(0,n),
  writeFileAtomic:(path,text)=>{files.set(path,text);return true},makeDirs:()=>true,lockFile:()=> 'lock',unlockFile:()=>true,
  fs:{expandHome:()=>'/state'},fetchStart:()=>JSON.stringify({jobId:'fetch'}),
  awaitJob:(job,then)=>then({status:200,body:JSON.stringify(replies.shift())}),exec:{close:()=>{}}});
 vm.runInNewContext(fs.readFileSync(__dirname+'/plugin.js','utf8'),context);
 const agent=context.module.exports.default;
 const result=agent.runAgentTask(hostInput);
 assert.equal(result.status,'done');assert.equal(result.output.created,true);assert.equal(files.get('/project/stage.txt'),'stage');
 assert.equal(agent.runAgentTask(hostInput).output.created,true);assert.equal(replies.length,0);
});

test('ungranted project omits and refuses writers and shell even for Coding',()=>{
 const f=fixture([reply('',[call('bad','write_file',{path:'a.txt',expected:'',content:'bad'})]),reply('refused')]);
 f.host.projectWriteAllowed=()=>false;
 const p=f.plugin;p.profileOpen('ungranted','coding');p.profileSend('ungranted','write');
 for(let i=0;i<3;i++)p.profilePump('ungranted');
 assert.equal(f.files.has('/project/a.txt'),false);
 for(const name of ['shell','write_file','edit_file']) assert.equal(f.requests[0].tools.some(t=>t.function.name===name),false);
 assert.match(JSON.stringify(p.profilePoll('ungranted').messages),/tool refused/);
});
test('failed history persistence prevents endpoint and tool effects',()=>{
 const f=fixture();f.host.writeFileAtomic=()=>false;
 assert.throws(()=>f.plugin.profileOpen('unpersisted','coding'),/persistence/);
 assert.equal(f.requests.length,0);assert.equal(f.files.size,0);
});
test('symlink paths and stale create are refused before lock mutation',()=>{
 const f=fixture([reply('',[call('bad','write_file',{path:'link/a.txt',expected:'',content:'bad'})]),reply('refused')]);
 f.host.isSymlink=p=>p==='/project/link';f.host.canonicalPath=p=>p==='/project'?p:null;
 const p=f.plugin;p.profileOpen('symlink','coding');p.profileSend('symlink','write');
 for(let i=0;i<3;i++)p.profilePump('symlink');
 assert.equal(f.files.has('/project/link/a.txt'),false);
});
test('aborting an awaiting Agent task persists cancellation and refuses late tool effects',()=>{
 const f=fixture();let continuation;const closed=[];
 f.host.fetchStart=()=>JSON.stringify({jobId:'pending'});
 f.host.awaitJob=(job,then)=>{continuation=then;return {pending:job}};
 f.host.exec.close=job=>closed.push(job);
 const input={runId:'cancelled',tabId:'owner',workspaceId:'workspace',profile:'coding',task:'write',input:'',timeoutMs:10000,maxTokens:1000,maxTurns:4};
 assert.equal(f.plugin.runAgentTask(input).pending,'pending');
 f.plugin.abortAgentTask('cancelled');
 assert.deepEqual(closed,['pending']);
 assert.equal(continuation({status:200,body:JSON.stringify(reply('',[call('late','write_file',{path:'late.txt',expected:'',content:'late'})]))}).status,'cancelled');
 assert.equal(f.files.has('/project/late.txt'),false);
 assert.equal(f.plugin.runAgentTask(input).status,'cancelled');
});
const decisionFixtures = JSON.parse(fs.readFileSync(__dirname+'/fixtures/decision/shared.json','utf8'));
function decisionFixture() {
 const f=fixture(); const fetches=[];
 let result={status:200,body:JSON.stringify({data:[{id:'live',name:'Live endpoint model'},{id:'live'},{id:7}]})};
 f.host.fetch.async=(opts,then)=>{fetches.push(opts);return then(result)};
 return {...f,fetches,result:value=>{result=value}};
}
function completion(answer, usage={prompt_tokens:123,completion_tokens:45}) {
 return {status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}],usage})};
}
test('decision capability and independently released metadata agree',()=>{
 const manifest=JSON.parse(fs.readFileSync(__dirname+'/plugin.json','utf8'));
 const pkg=JSON.parse(fs.readFileSync(__dirname+'/package.json','utf8'));
 const channel=JSON.parse(fs.readFileSync(__dirname+'/../channel.json','utf8')).plugins.find(p=>p.id==='rotterdom');
 assert.equal(manifest.capabilities.decisionModel.tokenMode,'none');
 assert.equal(manifest.version,pkg.version);assert.equal(manifest.version,channel.version);
 assert.equal(manifest.minCodeterm,channel.minCodeterm);
 const f=decisionFixture();assert.deepEqual(JSON.parse(JSON.stringify(f.plugin.primitives())),{choice:true,noul:true,score:true});
 assert.equal(f.plugin.supportsQuestionBatch(),true);assert.equal(f.plugin.supportsCalibratedChoiceConfidence(),false);
});
test('decision models come from the selected endpoint and secrets stay in headers',()=>{
 const f=decisionFixture();
 f.config.endpoints.push({id:'remote',baseUrl:'https://fixture.test/api/v1/',models:['configured-only'],secret:'key'});
 f.config.profiles.push({...profile,id:'decision',endpoint:'remote',model:'remote-configured'});
 f.config.decision={profile:'decision'};f.host.secretGet=id=>id==='key'?'opaque-secret':null;
 assert.deepEqual(JSON.parse(JSON.stringify(f.plugin.models())),[{id:'live',display_name:'Live endpoint model'}]);
 assert.equal(f.fetches[0].url,'https://fixture.test/api/v1/models');assert.equal(f.fetches[0].headers.authorization,'Bearer opaque-secret');
 assert.equal(f.plugin.selectModel('live'),true);assert.equal(f.plugin.modelId(),'live');assert.equal(f.plugin.selectModel(''),false);
 assert.equal(f.plugin.metadata().server_address,'https://fixture.test/api/v1/');
 f.result({status:500,body:'private error'});assert.equal(f.plugin.models().length,0);
 f.host.secretGet=()=>null;assert.equal(f.plugin.models().length,0);
 assert.equal(f.plugin.decide(decisionFixtures[0].request,1000).error,'unavailable');
});
test('all decision primitives preserve shared fixtures without tools or filesystem access',()=>{
 for(const item of decisionFixtures) {
  const f=decisionFixture();f.result(completion(item.answer));
  f.config.profiles[0]={...profile,root:'',params:{temperature:1.5,top_p:0.7,seed:5}};
  f.host.projectWriteAllowed=()=>{throw Error('decision touched project permission')};
  const result=f.plugin.decide(item.request,250);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),item.answer);
  const opts=f.fetches[0],wire=JSON.parse(opts.body);
  assert.equal(opts.url,'http://localhost:1234/v1/chat/completions');assert.equal(opts.timeoutMs,250);
  assert.equal(opts.headers.authorization,undefined);assert.equal(wire.model,'fixture');assert.equal(wire.temperature,0);
  assert.equal(wire.tools,undefined);assert.equal(wire.tool_choice,undefined);
  assert.deepEqual(JSON.parse(wire.messages[1].content),{state:item.request.state,questions:{single:{instructions:item.request.instructions,question:item.request.question}}});
  assert.equal(wire.response_format.type,'json_schema');assert.equal(wire.response_format.json_schema.strict,true);
  assert.equal(f.writes.length,0);
 }
});
test('named decision batch uses one physical request and carries usage',()=>{
 const f=decisionFixture();const questions={},answers={};
 for(const item of decisionFixtures){questions[item.request.question.type]={instructions:item.request.instructions,question:item.request.question};answers[item.request.question.type]=item.answer}
 f.result(completion({answers}));const result=f.plugin.decideQuestions({state:{shared:'opaque'},questions},2000);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{answers,usage:{input_tokens:123,output_tokens:45}});
 assert.equal(f.fetches.length,1);
 const wire=JSON.parse(f.fetches[0].body);assert.equal(JSON.parse(wire.messages[1].content).state.shared,'opaque');
 f.result(completion({answers:{noul:answers.noul}}));assert.equal(f.plugin.decideQuestions({state:{},questions},2000).error,'invalid_response');
});
test('decision deadlines reject expired work and late completions with no retry',()=>{
 const f=decisionFixture();const input=decisionFixtures[0].request;
 for(const ms of [0,-1,NaN,Infinity,0.5]) assert.equal(f.plugin.decide(input,ms).error,'timeout');
 assert.equal(f.fetches.length,0);
 f.result(completion(decisionFixtures[0].answer));f.plugin.decide(input,20000);assert.equal(f.fetches[0].timeoutMs,10000);
 f.host.fetch.async=(opts,then)=>{f.advance();return then(completion(decisionFixtures[0].answer))};
 assert.equal(f.plugin.decide(input,500).error,'timeout');
 f.host.fetch.async=(opts,then)=>then({error:'request timed out'});assert.equal(f.plugin.decide(input,500).error,'timeout');
});
test('decision malformed and transport failures fail closed',()=>{
 const f=decisionFixture();const input=decisionFixtures[1].request;
 for(const bad of [{type:'noul',p:0.8},{type:'choice',choice:'foreign',probabilities:{yes:0.8,no:0.2},confidence:0.8},
  {type:'choice',choice:'yes',probabilities:{yes:1},confidence:1},
  {type:'choice',choice:'yes',probabilities:{yes:0.8,no:0.8},confidence:0.8},
  {type:'choice',choice:'yes',probabilities:{yes:-1,no:2},confidence:0.8}]) {
  f.result(completion(bad));assert.equal(f.plugin.decide(input,500).error,'invalid_response');
 }
 f.result(completion({...decisionFixtures[2].answer,score:3}));assert.equal(f.plugin.decide(decisionFixtures[2].request,500).error,'invalid_response');
 for(const bad of [{status:200,body:'not-json'},{status:200,body:JSON.stringify({choices:[{message:{content:'not-json'}}]})},
  {status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify(decisionFixtures[1].answer),tool_calls:[{}]}}]})}]) {
  f.result(bad);assert.equal(f.plugin.decide(input,500).error,'invalid_response');
 }
 for(const bad of [{status:401,body:'private token details'},{error:'private network details'}]) {
  f.result(bad);assert.deepEqual(JSON.parse(JSON.stringify(f.plugin.decide(input,500))),{error:'transport'});
 }
 f.result(completion({type:'noul',p:1.1}));assert.equal(f.plugin.decide(decisionFixtures[0].request,500).error,'invalid_response');
 assert.equal(f.plugin.decide({...input,question:{type:'choice',options:{}}},500).error,'invalid_response');
});
