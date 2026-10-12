import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createWindowsNotificationBroker,validNativeNotification} from '../lib/host/windows-notifications.js';
import {registerRoutes} from '../lib/host/routes.js';

const fixture={clientId:'pharos-wf-client-instance',key:'pharos-wf-client-instance-0',kind:'workflow',sessionId:'child-long-original-id',title:'中文 <标题>',body:'内容 & "引用"',autoFocus:true};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function transport(){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;};
 const commands=[],calls=[];let removeFails=false;
 child.stdin.on('data',bytes=>{const cmd=JSON.parse(bytes.toString());commands.push(cmd);queueMicrotask(()=>child.stdout.write(JSON.stringify({event:'ack',id:cmd.id,op:cmd.op,ok:!(removeFails&&cmd.op==='remove')})+'\n'));});
 const launch=(...args)=>{calls.push(args);return child;};
 const emit=(event,id)=>child.stdout.write(JSON.stringify({event,id})+'\n');
 return {child,commands,calls,launch,emit,failRemovals:()=>{removeFails=true;}};
}
{
 const t=transport(),events=[];
 const b=createWindowsNotificationBroker({platform:'win32',launch:t.launch,onEvent:e=>events.push(e)});
 const first=await b.show(fixture);
 assert.equal(t.calls.length,1);assert.equal(t.calls[0][2].shell,false);assert.equal(t.calls[0][2].windowsHide,true);
 assert.match(t.calls[0][0],/WindowsPowerShell.*powershell.exe$/);
 assert.equal(t.commands[0].title,fixture.title);assert.equal(t.commands[0].body,fixture.body);
 assert.match(first.id,/^pharos-native-[a-f0-9]{24}$/);assert(!first.id.includes(fixture.sessionId));
 t.emit('dismissed',first.id);await wait(5);assert.equal(b.size(),1);assert.equal(events.length,0);
 t.emit('activated',first.id);t.emit('activated',first.id);await wait(10);
 assert.equal(events.length,1);assert.equal(events[0].sessionId,fixture.sessionId);assert.equal(b.size(),0);
 for(let i=1;i<=9;i++)await b.show({...fixture,key:fixture.clientId+'-'+i,sessionId:'child-'+i});
 assert.equal(b.size(),3);assert.equal(t.commands.filter(c=>c.op==='remove').length,7);
 const retired=t.commands.find(c=>c.op==='show'&&c.id!==first.id).id;
 t.emit('activated',retired);await wait(5);assert.equal(events.length,1);
 await b.release(fixture.clientId);assert.equal(b.size(),0);b.dispose();
}
{
 const t=transport(),events=[],b=createWindowsNotificationBroker({platform:'win32',launch:t.launch,onEvent:e=>events.push(e)});
 const shown=await b.show(fixture);t.emit('closed',shown.id);await wait(10);
 assert.equal(b.size(),0);assert.equal(events[0].event,'closed');b.dispose();
}
{
 const t=transport(),b=createWindowsNotificationBroker({platform:'win32',launch:t.launch});
 for(let i=0;i<3;i++)await b.show({...fixture,key:fixture.clientId+'-'+i});
 t.failRemovals();await assert.rejects(b.show({...fixture,key:fixture.clientId+'-3'}));
 assert.equal(t.commands.filter(c=>c.op==='show').length,3);assert.equal(b.size(),3);b.dispose();
}
{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;};
 const b=createWindowsNotificationBroker({platform:'win32',launch:()=>child,timeoutMs:20});
 await assert.rejects(b.show(fixture),/stopped|timed out/);assert.equal(child.killed,true);assert.equal(b.size(),0);b.dispose();
}
{
 const b=createWindowsNotificationBroker({platform:'darwin'});assert.equal(b.supported,false);await assert.rejects(b.show(fixture));b.dispose();
 for(const invalid of [{...fixture,key:'other-client-0'},{...fixture,title:''},{...fixture,sessionId:''},{...fixture,kind:'command'},{...fixture,body:'x'.repeat(8193)},{...fixture,autoFocus:'true'}])assert(!validNativeNotification(invalid));
}

// Route tests use the actual fence/stream; native events bypass the reminder/webhook bus.
{
 let handler,activation,shown=0,disposed=false,busEmits=0;const config={enabled:true,toast:true,autoFocus:true};
 const close=registerRoutes({webServer:{register:r=>{handler=r.handler;}},store:{getConfig:()=>config},bus:{subscribe:()=>()=>{},emit:()=>{busEmits++;}},
 nativeBrokerFactory:({onEvent})=>{activation=onEvent;return {supported:true,show:async()=>{shown++;return {requested:true,id:'native'};},release:async()=>{},dispose:()=>{disposed=true;}};}});
 const request=async(method,body,headers={})=>{
  const req=new EventEmitter();Object.assign(req,{method,url:'/pharos/api/native-notifications',remoteAddress:'127.0.0.1',headers:{host:'localhost:1234','content-type':'application/json','x-pharos-desktop':'1',...headers}});
  req[Symbol.asyncIterator]=async function*(){yield JSON.stringify(body);};
  const res=new EventEmitter();res.status=0;res.text='';res.writeHead=(s)=>{res.status=s;};res.end=s=>{res.text+=s??'';};res.write=s=>{res.text+=s;};
  handler(req,res);await wait(5);return res;
 };
 assert.equal((await request('POST',fixture)).status,200);assert.equal(shown,1);
 assert.equal((await request('POST',fixture,{origin:'https://evil.test'})).status,403);
 assert.equal((await request('POST',fixture,{'x-pharos-desktop':''})).status,403);
 assert.equal((await request('POST',{...fixture,sessionId:''})).status,400);
 assert.equal((await request('GET',fixture)).status,405);
 config.enabled=false;assert.equal(JSON.parse((await request('POST',fixture)).text).requested,false);assert.equal(shown,1);
 config.enabled=true;config.autoFocus=false;
 const req=new EventEmitter();Object.assign(req,{method:'GET',url:'/pharos/api/stream',remoteAddress:'127.0.0.1',headers:{host:'localhost:1234'}});
 const res=new EventEmitter();res.text='';res.writeHead=()=>{};res.write=s=>{res.text+=s;};res.end=()=>{};handler(req,res);
 activation({event:'activated',...fixture});assert.match(res.text,/native-notification/);assert.match(res.text,/"autoFocus":false/);assert.equal(busEmits,0);
 close();assert.equal(disposed,true);
}
if(process.platform==='win32'){
 const script=readFileSync(new URL('../lib/host/windows-notifications.ps1',import.meta.url),'utf8');
 const result=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:'',encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stderr); // compile/load/EOF; does not show a notification
}
console.log('windows-notifications: broker activation after timeout, capacity, failure, lifecycle, routes and native helper checks passed');
