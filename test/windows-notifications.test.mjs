import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createWindowsNotificationBroker as realBroker,validNativeNotification} from '../lib/host/windows-notifications.js';
import {registerRoutes} from '../lib/host/routes.js';

const fixture={clientId:'pharos-wf-client-instance',key:'pharos-wf-client-instance-0',kind:'workflow',sessionId:'child-long-original-id',title:'中文 <标题>',body:'内容 & "引用"',autoFocus:true};
const createWindowsNotificationBroker=options=>realBroker({activationPort:19387,ensureActivation:async()=>true,...options});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function transport(){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;};
 const commands=[],calls=[];let removeFails=false;
 child.stdin.on('data',bytes=>{const cmd=JSON.parse(bytes.toString());if(typeof cmd.source==='string')return;commands.push(cmd);queueMicrotask(()=>child.stdout.write(JSON.stringify({event:'ack',id:cmd.id,op:cmd.op,ok:!(removeFails&&cmd.op==='remove')})+'\n'));});
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
 const t=transport(),b=createWindowsNotificationBroker({platform:'win32',launch:t.launch});
 await b.show(fixture);const args=t.commands[0].activation;
 assert.match(args,/^19387\/[a-f0-9]{48}$/);assert(!args.includes('://'));
 const ticket=args.split('/').at(-1);assert(!JSON.stringify(b.debug()).includes(ticket));
 assert.equal(b.activate('0'.repeat(48)),false);
 assert.equal(b.activate(ticket).sessionId,fixture.sessionId);assert.equal(b.activate(ticket),false);
 await wait(10);assert.equal(b.size(),0);b.dispose();
}
{
 const t=transport(),b=createWindowsNotificationBroker({platform:'win32',launch:t.launch});
 const notifications=['parent-A','parent-B','child-C'].map((sessionId,i)=>({...fixture,kind:'remote',key:fixture.clientId+'-'+i,sessionId,title:'marker-'+i,body:'body-'+i}));
 const shown=await Promise.all(notifications.map(n=>b.show(n)));
 assert.equal(new Set(shown.map(n=>n.id)).size,3);
 const commands=t.commands.filter(c=>c.op==='show');
 assert.deepEqual(commands.map(c=>c.body),notifications.map(n=>n.body));
 for(const i of [2,0,1]) {
  const ticket=commands[i].activation.split('/')[1];
  assert.equal(b.peek(ticket).sessionId,notifications[i].sessionId);
  assert.equal(b.peek(ticket).sessionId,notifications[i].sessionId); // prepare cannot consume
  const entry=b.activate(ticket);
  assert.equal(entry.id,shown[i].id);assert.equal(entry.key,notifications[i].key);assert.equal(entry.sessionId,notifications[i].sessionId);
  assert.equal(b.activate(ticket),false);
  assert.equal(b.peek(ticket),false);
 }
 await wait(10);assert.equal(b.size(),0);b.dispose();
}
{
 const t=transport(),events=[],b=createWindowsNotificationBroker({platform:'win32',launch:t.launch,onEvent:e=>events.push(e)});
 const shown=await b.show({...fixture,event:'activated',retired:true,id:'forged'});t.emit('closed',shown.id);await wait(10);
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
 let handler,activation,shown=0,disposed=false,busEmits=0,restoreCalls=0;const config={enabled:true,toast:true,autoFocus:true};
 const usedTickets=new Set();
 const close=registerRoutes({webServer:{register:r=>{handler=r.handler;}},store:{getConfig:()=>config},bus:{subscribe:()=>()=>{},emit:()=>{busEmits++;}},restoreDesktop:async()=>{restoreCalls++;return true;},
 nativeBrokerFactory:({onEvent})=>{activation=onEvent;return {supported:true,peek:ticket=>ticket==='a'.repeat(48)&&!usedTickets.has(ticket)?fixture:false,activate:ticket=>{if(ticket!=='a'.repeat(48)||usedTickets.has(ticket))return false;usedTickets.add(ticket);return fixture;},show:async()=>{shown++;return {requested:true,id:'native'};},release:async()=>{},dispose:()=>{disposed=true;}};}});
 const request=async(method,body,headers={},url='/pharos/api/native-notifications')=>{
  const req=new EventEmitter();Object.assign(req,{method,url,remoteAddress:'127.0.0.1',headers:{host:'localhost:1234','content-type':'application/json','x-pharos-desktop':'1',...headers}});
  req[Symbol.asyncIterator]=async function*(){yield JSON.stringify(body);};
  const res=new EventEmitter();res.status=0;res.text='';res.writeHead=(s)=>{res.status=s;};res.end=s=>{res.text+=s??'';};res.write=s=>{res.text+=s;};
  handler(req,res);await wait(5);return res;
 };
 assert.equal((await request('POST',fixture)).status,200);assert.equal(shown,1);
 assert.equal((await request('POST',fixture,{origin:'https://evil.test'})).status,403);
 assert.equal((await request('POST',fixture,{'x-pharos-desktop':''})).status,403);
 assert.equal((await request('POST',{...fixture,sessionId:''})).status,400);
 assert.equal((await request('PATCH',fixture)).status,405);
 assert.equal((await request('GET',fixture)).status,200);
 config.enabled=false;assert.equal(JSON.parse((await request('POST',fixture)).text).requested,false);assert.equal(shown,1);
 config.enabled=true;config.autoFocus=false;
 const req=new EventEmitter();Object.assign(req,{method:'GET',url:'/pharos/api/stream',remoteAddress:'127.0.0.1',headers:{host:'localhost:1234'}});
 const res=new EventEmitter();res.text='';res.writeHead=()=>{};res.write=s=>{res.text+=s;};res.end=()=>{};handler(req,res);
 activation({event:'activated',...fixture});assert.match(res.text,/native-notification/);assert.match(res.text,/"autoFocus":false/);assert.equal(busEmits,0);
 config.autoFocus=true;
 const prepare=()=>request('POST',{ticket:'a'.repeat(48),phase:'prepare'},{},'/pharos/api/native-activation');
 assert.deepEqual(JSON.parse((await prepare()).text),{autoFocus:true});
 assert.equal(restoreCalls,0);assert.equal(usedTickets.size,0);
 config.autoFocus=false;assert.deepEqual(JSON.parse((await prepare()).text),{autoFocus:false});
 config.autoFocus=true;config.enabled=false;assert.deepEqual(JSON.parse((await prepare()).text),{autoFocus:false});config.enabled=true;
 assert.equal((await request('POST',{ticket:'b'.repeat(48),phase:'prepare'},{},'/pharos/api/native-activation')).status,410);
 assert.equal((await request('POST',{ticket:'a'.repeat(48),phase:'command'},{},'/pharos/api/native-activation')).status,400);
 assert.equal((await request('POST',{ticket:'a'.repeat(48),foregroundGranted:true},{},'/pharos/api/native-activation')).status,200);
 assert.equal(restoreCalls,1);assert.match(res.text,/"focusHandled":true/);
 assert.match(res.text,/"foregroundGranted":true/);
 assert.equal((await prepare()).status,410);
 assert.equal((await request('POST',{ticket:'a'.repeat(48)},{},'/pharos/api/native-activation')).status,410);
 assert.equal((await request('POST',{ticket:'wrong'},{},'/pharos/api/native-activation')).status,400);
 assert.equal((await request('POST',{ticket:'b'.repeat(48)},{origin:'https://evil.test'},'/pharos/api/native-activation')).status,403);
 // A click while the originating renderer is disconnected must survive SSE reconnect.
 req.emit('close');
 const reconnect=()=>{
  const connection=new EventEmitter();Object.assign(connection,{method:'GET',url:'/pharos/api/stream',remoteAddress:'127.0.0.1',headers:{host:'localhost:1234'}});
  const response=new EventEmitter();response.text='';response.writeHead=()=>{};response.write=s=>{response.text+=s;};response.end=()=>{};
  handler(connection,response);return {connection,response};
 };
 const replay=reconnect();assert.match(replay.response.text,/"sessionId":"child-long-original-id"/);assert.match(replay.response.text,/"focusHandled":true/);
 assert.equal(restoreCalls,1);replay.connection.emit('close');
 // Unloading that renderer releases its saved clicks, so a new renderer cannot replay them.
 assert.equal((await request('DELETE',{clientId:fixture.clientId})).status,200);
 const released=reconnect();assert(!released.response.text.includes('native-notification'));released.connection.emit('close');
 close();assert.equal(disposed,true);
}
if(process.platform==='win32'){
 const source=readFileSync(new URL('../lib/host/notification-activation.cs',import.meta.url),'utf8');
 const parseTest=`$ErrorActionPreference='Stop';$fixture=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition $fixture.source;foreach($case in $fixture.cases){$port=0;$ticket=$null;if([PharosNotificationActivation]::Parse($case.value,[ref]$port,[ref]$ticket) -ne $case.valid){throw 'activation argument parser mismatch'}};if(-not [PharosNotificationActivation]::ValidServerArgs(@('-ToastActivated','-Embedding')) -or [PharosNotificationActivation]::ValidServerArgs(@('-ToastActivated','command'))){throw 'COM server arguments mismatch'}`;
 const token='a'.repeat(48),cases=[{value:'19387/'+token,valid:true},...['0/'+token,'65536/'+token,'19387/'+token+'?command=x','http://127.0.0.1/19387/'+token,'19387/%61'].map(value=>({value,valid:false}))];
 const parsed=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parseTest,'utf16le').toString('base64')],{input:JSON.stringify({source,cases}),encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(parsed.status,0,parsed.stderr); // compile/parser only; does not register COM or send HTTP
 // Keep the JS event loop running while the actual C# transport calls a local fixture.
 // The grant delegate is fake; neither window activation nor ASFW is invoked in this test.
 const deliveries=[
  ...[1,2,3].map(i=>({ticket:String(i).repeat(48),autoFocus:true,granted:true,expected:true,grantCalls:1})),
  {ticket:'4'.repeat(48),autoFocus:false,granted:true,expected:true,grantCalls:0},
  {ticket:'5'.repeat(48),expired:true,granted:true,expected:false,grantCalls:0},
  {ticket:'6'.repeat(48),autoFocus:true,granted:false,expected:true,grantCalls:1},
  {ticket:'7'.repeat(48),malformed:true,granted:true,expected:false,grantCalls:0},
 ];
 const requests=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),entry=deliveries.find(e=>e.ticket===body.ticket);requests.push(body);
  assert.equal(req.headers['x-pharos-desktop'],'1');assert.equal(req.url,'/pharos/api/native-activation');
  res.setHeader('content-type','application/json');
  if(body.phase==='prepare'){
   res.statusCode=entry.expired?410:200;
   res.end(entry.expired?'{}':entry.malformed?'{}':JSON.stringify({autoFocus:entry.autoFocus}));
  }else res.end('{"activated":true}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const script=readFileSync(new URL('./windows-foreground-delivery.test.ps1',import.meta.url),'utf8');
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
   const timer=setTimeout(()=>{child.kill();reject(new Error('foreground fixture timed out'));},20000);
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
   child.stdin.end(JSON.stringify({source,port:server.address().port,cases:deliveries}));
  });
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: each click grants/);
  for(const entry of deliveries){
   const events=requests.filter(r=>r.ticket===entry.ticket);
   assert.equal(events[0].phase,'prepare');
   assert.equal(events.length,entry.expected?2:1);
   if(entry.expected)assert.equal(events[1].foregroundGranted,entry.autoFocus&&entry.granted);
  }
 }finally {await new Promise(resolve=>server.close(resolve));}
 const installer=readFileSync(new URL('../lib/host/notification-activation.ps1',import.meta.url),'utf8');
 const installerTest=readFileSync(new URL('./windows-activation-installer.test.ps1',import.meta.url),'utf8');
 const installed=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(installerTest,'utf16le').toString('base64')],{input:JSON.stringify({source,fingerprint:createHash('sha256').update(source).digest('hex'),installer}),encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(installed.status,0,installed.error?.message??installed.stderr);
 assert.match(installed.stdout,/PASS: installer preserves values/);
 const script=readFileSync(new URL('../lib/host/windows-notifications.ps1',import.meta.url),'utf8');
 const combined="$activationHash='"+createHash('sha256').update(source).digest('hex')+"';\n"+script;
 const result=spawnSync(process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(combined,'utf16le').toString('base64')],{input:JSON.stringify({source})+'\n',encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.error?.message??result.stderr); // compile/load/EOF; does not show or register a notification
}
console.log('windows-notifications: broker activation after timeout, capacity, failure, lifecycle, routes and native helper checks passed');
