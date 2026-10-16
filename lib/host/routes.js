/**
 * dsh-pharos — host half: webServer routes for `/pharos/api` (contract §3).
 *
 * 注册：webServer.register({ kind: 'prefix', path: '/pharos/api', handler })
 * 路由表：
 *   GET  /pharos/api/stream    — SSE 广播（事件名 `pharos`，data: <帧 JSON>，25s ': ping'）
 *   POST /pharos/api/trigger   — 远程触发 → kind:'remote' 帧入 bus（apiToken 非空时校验 x-pharos-token）
 *   GET  /pharos/api/config    — 配置（secret 打码）+ PUT 深合并落盘
 *   GET  /pharos/api/webhooks  — webhooks 列表（secret 打码）
 *   POST /pharos/api/desktop-focus — Windows 点击恢复窗口（固定 dsh://open，自定义头+来源校验）
 *
 * 全部先过 loopback 围栏：remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} 且
 * Host header 必须是 loopback 权威名（127.0.0.1/localhost/[::1]）或与 webServer
 * 同源（host:port 归一比较）。写接口另校验 content-type: application/json。
 *
 * 参考：dshmarket/lib/http.js（sendJson / readJsonBody / loopbackAuthority /
 * sameOrigin 的实装语义）与 dsh-my-notify parts/stream.ts（SSE 心跳模式）。
 */

/** node:http 风格 req/res，与 dsh-host-webserver handler(req, res) 一致。 */

import { maskConfig } from './store.js';
import { restoreWindowsDesktop } from './desktop.js';
import { removeWindowsWorkflowHistory, validWorkflowTags } from './notification-history.js';
import { createWindowsNotificationBroker, validNativeNotification } from './windows-notifications.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:0:0:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const SSE_HEARTBEAT_MS = 25000;
const JSON_BODY_LIMIT = 16 * 1024;

/** req.headers.host → { hostname, port|null }（IPv6 字面量带括号处理）。 */
export function hostPortOf(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const value = hostHeader.trim().toLowerCase();
  if (value === '') return null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    return { hostname: value.slice(1, close), port: value.slice(close + 1).replace(/^:/, '') || null };
  }
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { hostname: value, port: null };
  if (idx !== value.indexOf(':')) return { hostname: value, port: null }; // bare IPv6 without brackets — refuse
  const hostname = value.slice(0, idx);
  if (hostname === '') return { hostname: value, port: null };
  return { hostname, port: value.slice(idx + 1) || null };
}

/**
 * loopback 围栏（契约 §3）。
 * @param req - node:http 请求。
 * @param expected - 可选的 "host:port" 权威（webServer.host + port）；null 时只做 loopback 主机名检查。
 */
export function isLoopback(req, expected = null) {
  const remote = req ? (req.remoteAddress ?? (req.socket && req.socket.remoteAddress)) ?? '' : '';
  if (!LOOPBACK_ADDRESSES.has(remote)) return false;
  const hp = hostPortOf(req && req.headers && req.headers.host);
  if (hp === null) return false; // Host 头缺失一律拒绝（防 DNS rebinding）
  const bare = hp.hostname.replace(/^\[|\]$/g, '');
  if (expected !== null) {
    const eh = hostPortOf(String(expected));
    if (eh !== null) {
      const hostBare = eh.hostname.replace(/^\[|\]$/g, '');
      // 通配绑定（0.0.0.0 / '::'）没有可比的 origin hostname：退化为
      // "Host 必须是 loopback 权威名"（remote 已限 loopback）。
      if (hostBare === '0.0.0.0' || hostBare === '::') {
        return LOOPBACK_HOSTNAMES.has(bare);
      }
      // host 同源：名字精确相等，或两侧都是 loopback 权威名（localhost↔127.0.0.1↔::1 属同源）
      const hostMatch = bare === hostBare
        || (LOOPBACK_HOSTNAMES.has(bare) && LOOPBACK_HOSTNAMES.has(hostBare));
      if (!hostMatch) return false;
      // 端口：两侧都带端口时必须相等（围栏按“当前 origin host”闭合）
      if (hp.port !== null && eh.port !== null && hp.port !== eh.port) return false;
      return true;
    }
  }
  return LOOPBACK_HOSTNAMES.has(bare);
}

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

/** 读取 size-capped JSON body（照 dshmarket readJsonBody）。 */
export async function readJsonBody(request, maxBytes = JSON_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const isJsonRequest = (req) => {
  const type = (req.headers && req.headers['content-type'] || '').toLowerCase();
  return type.includes('application/json');
};

/** Constant-time token comparison; lengths differ → false. */
export function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 未命中路由 → 404。 */
function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function forbidden(res, reason = 'forbidden') {
  sendJson(res, 403, { error: reason });
}

/**
 * 注册全部 /pharos/api 路由。
 * @param deps { webServer, store, bus, dispatch, log, origin? }
 *   - store: createStore 实例（getConfig/update）
 *   - bus:   帧总线（.subscribe(listener) 供 SSE 广播）
 *   - dispatch: (parts) => frame|null —— 构造并投递帧（trigger 用）
 *   - origin: 可选 "host:port"，围栏期望的权威
 * @returns disposer（含 SSE 客户端清理）。
 */
export function registerRoutes({ webServer, store, bus, dispatch, log = () => {}, origin, restoreDesktop = restoreWindowsDesktop, removeWorkflowHistory = removeWindowsWorkflowHistory, nativeBrokerFactory = createWindowsNotificationBroker }) {
  /** 活动 SSE 客户端。 */
  const clients = new Set();
  const nativeActivations = new Map();
  let stopped = false;

  const removeClient = (client) => {
    if (!clients.has(client)) return;
    clients.delete(client);
    clearInterval(client.heartbeat);
    try { client.res.end(); } catch { /* already closed */ }
  };

  const writeFrame = (client, frame) => {
    try {
      client.res.write(`event: pharos\ndata: ${JSON.stringify(frame)}\n\n`);
    } catch (error) {
      log(`stream write failed: ${String(error)}`);
      removeClient(client);
    }
  };

  const nativeEvent = async (event) => {
    if(stopped)return;
    const config=store.getConfig();
    if(event.event==='activated' && !config.enabled)return;
    let focusHandled=false;
    if(event.event==='activated' && event.autoFocus && config.autoFocus) {
      try{focusHandled=await restoreDesktop();}catch{log('native activation window restore failed');}
    }
    if(stopped)return;
    // Activation goes straight to the originating renderer, not to the reminder/webhook bus.
    const frame={kind:'native-notification',action:event.event,clientId:event.clientId,key:event.key,
      sessionId:event.sessionId,autoFocus:event.autoFocus && config.autoFocus,focusHandled,
      foregroundGranted:event.foregroundGranted===true};
    if(event.event==='activated') {
      nativeActivations.set(event.key,frame);
      while(nativeActivations.size>128)nativeActivations.delete(nativeActivations.keys().next().value);
    }
    for(const client of [...clients])writeFrame(client,frame);
  };
  const nativeBroker = nativeBrokerFactory({activationPort:Number(hostPortOf(origin)?.port),onEvent: event=>{nativeEvent(event).catch(()=>log('native activation dispatch failed'));}});

  const unsubscribe = bus.subscribe((frame) => {
    if (stopped) return;
    for (const client of [...clients]) writeFrame(client, frame);
  });

  const handleStream = (req, res) => {
    if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, heartbeat: null };
    client.heartbeat = setInterval(() => {
      if (stopped || !clients.has(client)) return;
      try { client.res.write(': ping\n\n'); } catch { removeClient(client); }
    }, SSE_HEARTBEAT_MS);
    if (typeof client.heartbeat.unref === 'function') client.heartbeat.unref();
    clients.add(client);
    for(const frame of nativeActivations.values())writeFrame(client,frame);
    req.on('close', () => removeClient(client));
    req.on('error', () => removeClient(client));
    res.on('close', () => removeClient(client));
  };

  const handleTrigger = async (req, res) => {
    if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    if (!isJsonRequest(req)) return sendJson(res, 400, { error: 'content-type must be application/json' });
    const config = store.getConfig();
    // 三态判定，避免任何一态被"混进"另一态：
    //   - 空串 / 未设置 → 不要求 token（默认关闭，保持既有语义）
    //   - 非空字符串   → 必须带匹配的 x-pharos-token
    //   - 其它任何类型（手改配置文件 / 旧畸形数据）→ **拒绝**（fail closed）。
    // 早期写法是负向判断（typeof !== 'string' 就跳过），非字符串值会让校验整段失效；
    // 后来把畸形值归一成 '' 又等于把「已配置」降级为「无需鉴权」——两者都是绕过路径
    // （issue #9 / PR #34 评审 D3）。这里显式区分，畸形一律 401。
    const configured = config.apiToken;
    if (configured !== undefined && configured !== null && configured !== '' && typeof configured !== 'string') {
      return sendJson(res, 401, { error: 'invalid or missing x-pharos-token' });
    }
    if (typeof configured === 'string' && configured !== '') {
      const token = req.headers && req.headers['x-pharos-token'];
      if (!safeTokenEqual(token, configured)) return sendJson(res, 401, { error: 'invalid or missing x-pharos-token' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: `invalid JSON body: ${String(error.message ?? error)}` });
    }
    if (!body || typeof body !== 'object' || typeof body.body !== 'string' || body.body === '') {
      return sendJson(res, 400, { error: 'body.payload required: {"body": string, "title"?, "sessionId"?}' });
    }
    const frame = dispatch({
      kind: 'remote',
      source: 'remote',
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      sessionTitle: typeof body.title === 'string' && body.title !== '' ? body.title : '远程通知',
      note: body.body,
    });
    sendJson(res, 200, { ok: true, id: frame ? frame.id : null });
  };

  const handleConfig = async (req, res) => {
    if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
    if (req.method === 'GET') {
      const config = store.getConfig();
      return sendJson(res, 200, { ...maskConfig(config), desktopNativeNotifications: nativeBroker.supported });
    }
    if (req.method === 'PUT') {
      if (!isJsonRequest(req)) return sendJson(res, 400, { error: 'content-type must be application/json' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: `invalid JSON body: ${String(error.message ?? error)}` });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'config body must be an object' });
      }
      const next = await store.update(body);
      return sendJson(res, 200, maskConfig(next));
    }
    res.writeHead(405, { allow: 'GET, PUT' });
    res.end();
  };

  const handleWebhooks = async (req, res) => {
    if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    const config = store.getConfig();
    const masked = maskConfig(config);
    return sendJson(res, 200, masked.webhooks);
  };

  const handleDesktopFocus = async (req, res) => {
    if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }); res.end(); return;
    }
    // DSH's protocol proxy strips Origin. A custom header prevents cross-site
    // forms/simple requests; if Origin survives, require the application origin.
    const source = req.headers?.origin;
    if (req.headers?.['x-pharos-desktop'] !== '1' ||
        (source && source !== 'dsh-app://app' && source !== `http://${req.headers.host}`)) {
      return forbidden(res, 'untrusted desktop request');
    }
    if (!isJsonRequest(req)) return sendJson(res, 400, { error: 'content-type must be application/json' });
    const config = store.getConfig();
    if (!config.enabled || !config.autoFocus) return sendJson(res, 200, { requested: false });
    // No URL/command from the request is consumed. Only the fixed dsh://open is launched.
    const requested = await restoreDesktop();
    return sendJson(res, requested ? 200 : 503, { requested });
  };

  const routeTable = {
    '/stream': handleStream,
    '/trigger': handleTrigger,
    '/config': handleConfig,
    '/webhooks': handleWebhooks,
    '/desktop-focus': handleDesktopFocus,
    '/native-activation': async (req,res) => {
      if(!isLoopback(req,origin))return forbidden(res,'untrusted origin');
      if(req.method!=='POST'){res.writeHead(405,{allow:'POST'});res.end();return;}
      const source=req.headers?.origin;
      if(req.headers?.['x-pharos-desktop']!=='1'||(source&&source!=='dsh-app://app'&&source!==`http://${req.headers.host}`))return forbidden(res,'untrusted desktop request');
      if(!isJsonRequest(req))return sendJson(res,400,{error:'content-type must be application/json'});
      let body;try{body=await readJsonBody(req);}catch{return sendJson(res,400,{error:'invalid activation body'});}
      if(typeof body?.ticket!=='string'||!/^[0-9a-f]{48}$/.test(body.ticket))return sendJson(res,400,{error:'invalid activation ticket'});
      if(body.phase==='prepare') {
        const entry=nativeBroker.peek(body.ticket);
        if(!entry)return sendJson(res,410,{activated:false});
        const config=store.getConfig();
        return sendJson(res,200,{autoFocus:config.enabled && config.autoFocus && entry.autoFocus});
      }
      if(body.phase!==undefined)return sendJson(res,400,{error:'invalid activation phase'});
      const entry=nativeBroker.activate(body.ticket,{foregroundGranted:body.foregroundGranted===true});
      if(!entry)return sendJson(res,410,{activated:false});
      await nativeEvent({event:'activated',...entry,foregroundGranted:body.foregroundGranted===true});return sendJson(res,200,{activated:true});
    },
    '/native-notifications': async (req,res) => {
      if(!isLoopback(req,origin))return forbidden(res,'untrusted origin');
      if(req.method!=='GET' && req.method!=='POST' && req.method!=='DELETE'){res.writeHead(405,{allow:'GET, POST, DELETE'});res.end();return;}
      const source=req.headers?.origin;
      if(req.headers?.['x-pharos-desktop']!=='1'||(source&&source!=='dsh-app://app'&&source!==`http://${req.headers.host}`))return forbidden(res,'untrusted desktop request');
      if(req.method==='GET')return sendJson(res,200,nativeBroker.debug?.()??{supported:nativeBroker.supported});
      if(!isJsonRequest(req))return sendJson(res,400,{error:'content-type must be application/json'});
      let body;try{body=await readJsonBody(req);}catch{return sendJson(res,400,{error:'invalid native body'});}
      if(!nativeBroker.supported)return sendJson(res,503,{error:'native notifications unavailable'});
      if(req.method==='DELETE'){
        if(typeof body?.clientId!=='string'||body.clientId.length>48||!/^pharos-wf-[a-z0-9]+-[a-z0-9]+$/.test(body.clientId))return sendJson(res,400,{error:'invalid native client'});
        await nativeBroker.release(body.clientId);
        for(const [key,frame] of nativeActivations)if(frame.clientId===body.clientId)nativeActivations.delete(key);
        return sendJson(res,200,{released:true});
      }
      if(!validNativeNotification(body))return sendJson(res,400,{error:'invalid native notification'});
      const config=store.getConfig();
      if(!config.enabled||!config.toast)return sendJson(res,200,{requested:false});
      const result=await nativeBroker.show(body);return sendJson(res,200,result);
    },
    '/workflow-history': async (req, res) => {
      if (!isLoopback(req, origin)) return forbidden(res, 'untrusted origin');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
      const source = req.headers?.origin;
      if (req.headers?.['x-pharos-desktop'] !== '1' ||
          (source && source !== 'dsh-app://app' && source !== `http://${req.headers.host}`)) {
        return forbidden(res, 'untrusted desktop request');
      }
      if (!isJsonRequest(req)) return sendJson(res, 400, { error: 'content-type must be application/json' });
      let body;
      try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'invalid history body' }); }
      if (!validWorkflowTags(body?.tags)) return sendJson(res, 400, { error: 'invalid workflow notification identifiers' });
      const removed = await removeWorkflowHistory(body.tags);
      return sendJson(res, removed ? 200 : 503, { removed });
    },
  };

  const handler = (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://pharos.local').pathname;
    } catch { /* fall through to 404 */ }
    const suffix = pathname.replace(/^\/pharos\/api/, '') || '/';
    const handle = routeTable[suffix];
    if (!handle) return notFound(res);
    Promise.resolve(handle(req, res)).catch((error) => {
      log(`route ${suffix} failed: ${String(error)}`);
      try {
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, { error: 'internal error' });
      } catch { /* already closed */ }
    });
  };

  const dispose = webServer.register({ kind: 'prefix', path: '/pharos/api', handler });
  return () => {
    stopped = true;
    nativeActivations.clear();
    nativeBroker.dispose();
    unsubscribe();
    for (const client of [...clients]) removeClient(client);
    if (typeof dispose === 'function') {
      try { dispose(); } catch { /* already removed */ }
    }
  };
}
