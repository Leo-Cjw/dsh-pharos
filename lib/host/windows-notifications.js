import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { createInterface } from 'node:readline';

const SCRIPT = readFileSync(new URL('./windows-notifications.ps1', import.meta.url), 'utf8');
const KINDS = new Set(['done','attention','error','interrupted','limit','job','remote','test','workflow']);
export function validNativeNotification(body) {
  return body && typeof body === 'object' && !Array.isArray(body) &&
    typeof body.clientId === 'string' && /^pharos-wf-[a-z0-9]+-[a-z0-9]+$/.test(body.clientId) && body.clientId.length <= 48 &&
    typeof body.key === 'string' && body.key.startsWith(body.clientId + '-') && /^[a-z0-9-]+$/.test(body.key) && body.key.length <= 60 &&
    KINDS.has(body.kind) && typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 512 &&
    typeof body.title === 'string' && body.title.length > 0 && body.title.length <= 256 &&
    typeof body.body === 'string' && body.body.length <= 8192 && typeof body.autoFocus === 'boolean';
}

/** One lazily started native helper per host. A native timeout never releases its activation callback. */
export function createWindowsNotificationBroker({platform=process.platform,launch=spawn,systemRoot=process.env.SystemRoot??'C:\\Windows',timeoutMs=15000,onEvent=()=>{}}={}) {
  let child=null, reader=null, disposed=false;
  const pending=new Map(), entries=new Map(), events=[];
  let chain=Promise.resolve();
  const failAll=()=>{
    for(const entry of entries.values()){try{onEvent({event:'failed',...entry});}catch{}}
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('native notification helper stopped'));}
    pending.clear(); entries.clear();
    reader?.close();reader=null;
    const old=child;child=null;try{old?.kill();}catch{}
  };
  const start=()=>{
    if(child)return;
    if(disposed||platform!=='win32')throw new Error('native notifications unavailable');
    child=launch(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(SCRIPT,'utf16le').toString('base64')],
      {shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
    const owner=child;
    const failed=()=>{if(child===owner)failAll();};
    child.once('error',failed);child.once('close',failed);child.stdin.on('error',failed);
    reader=createInterface({input:child.stdout});
    reader.on('line',line=>{
      let event;try{event=JSON.parse(line);}catch{return;}
      events.push({event:event.event,id:event.id,op:event.op,reason:event.reason,ts:Date.now()});
      while(events.length>20)events.shift();
      if(event.event==='ack'){
        const key=event.op+':'+event.id,p=pending.get(key);if(!p)return;
        clearTimeout(p.timer);pending.delete(key);
        event.ok===true?p.resolve():p.reject(new Error('native notification command failed'));
      } else if(event.event==='activated'||event.event==='failed'||event.event==='closed') {
        const entry=entries.get(event.id);if(!entry||entry.retired)return;
        entries.delete(event.id);
        try{onEvent({event:event.event,...entry});}catch{}
        enqueue(()=>command({op:'remove',id:event.id})).catch(()=>{});
      }
    });
  };
  const command=payload=>new Promise((resolve,reject)=>{
    start();const key=payload.op+':'+payload.id;
    const timer=setTimeout(()=>{failAll();reject(new Error('native notification command timed out'));},timeoutMs);
    pending.set(key,{resolve,reject,timer});
    try{child.stdin.write(JSON.stringify(payload)+'\n');}catch{failAll();}
  });
  const enqueue=fn=>{const work=chain.then(fn);chain=work.catch(()=>{});return work;};
  const retire=async id=>{const entry=entries.get(id);if(entry)entry.retired=true;await command({op:'remove',id});entries.delete(id);};
  return {
    supported:platform==='win32',
    show(body){
      if(!validNativeNotification(body))return Promise.reject(new Error('invalid native notification'));
      return enqueue(async()=>{
        if(disposed)throw new Error('native notifications disposed');
        if([...entries.values()].some(e=>e.clientId===body.clientId&&e.key===body.key))throw new Error('duplicate native notification');
        if(body.kind==='workflow'){
          const workflow=[...entries].filter(([,e])=>e.clientId===body.clientId&&e.kind==='workflow');
          while(workflow.length>=3)await retire(workflow.shift()[0]);
        }
        if(entries.size>=512)throw new Error('native notification capacity reached');
        const id='pharos-native-'+randomBytes(12).toString('hex');
        // Request fields must never override native event names, IDs or retirement state.
        entries.set(id,{clientId:body.clientId,key:body.key,kind:body.kind,sessionId:body.sessionId,autoFocus:body.autoFocus,id});
        try{await command({op:'show',id,title:body.title,body:body.body});}catch(error){entries.delete(id);throw error;}
        return {id,requested:true};
      });
    },
    release(clientId){return enqueue(async()=>{for(const [id,e] of [...entries])if(e.clientId===clientId)await retire(id);});},
    dispose(){disposed=true;const owner=child;if(owner){try{owner.stdin.end();}catch{}setTimeout(()=>{if(child===owner)failAll();},2000).unref();}else failAll();},
    size:()=>entries.size,
    debug:()=>({pid:child?.pid??null,pending:pending.size,entries:entries.size,events:[...events]}),
  };
}
