import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
const source=readFileSync(new URL('./notification-activation.cs',import.meta.url),'utf8');
const script=readFileSync(new URL('./notification-activation.ps1',import.meta.url),'utf8');
export function ensureWindowsNotificationActivation({launch=spawn,systemRoot=process.env.SystemRoot??'C:\\Windows',timeoutMs=15000}={}) {
 return new Promise((resolve,reject)=>{
  const child=launch(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
   ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
   {shell:false,windowsHide:true,stdio:['pipe','ignore','ignore']});
  let settled=false;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error){try{child.kill();}catch{}}error?reject(error):resolve(true);};
  const timer=setTimeout(()=>finish(new Error('notification activation registration timed out')),timeoutMs);
  child.once('error',finish);child.once('close',code=>finish(code===0?null:new Error('notification activation registration failed')));
  child.stdin.on('error',finish);
  try{child.stdin.end(JSON.stringify({source,fingerprint:createHash('sha256').update(source).digest('hex')}));}catch(error){finish(error);}
 });
}
