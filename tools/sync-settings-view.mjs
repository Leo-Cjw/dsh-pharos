// dsh-pharos — 把规范源 lib/settings-view.js 内联进浏览器 bundle lib/client.js。
//
// 背景：浏览器半是单文件 bundle（__ModuleLoader__ 只服务一块 entry），
// 运行时无法按文件加载 lib/settings-view.js，因此视图以内联形式存在于
// lib/client.js 的 //#region settings-view 块（契约 §1 文件职责）。
// 本脚本保持「独立文件为规范源」：视图改动只改 settings-view.js，
// 然后运行本脚本重新生成内联区（pretest 会自动执行）。
//
// 用法：node tools/sync-settings-view.mjs   （幂等；输出已同步提示）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewFile = path.join(root, 'lib', 'settings-view.js');
const clientFile = path.join(root, 'lib', 'client.js');
const MARKER = '//__SETTINGS_VIEW__//';

const view = fs.readFileSync(viewFile, 'utf8');
const client = fs.readFileSync(clientFile, 'utf8');

if (!client.includes(MARKER)) {
  console.error(`[sync-settings-view] ${clientFile} 缺少内联标记 ${MARKER}（可能已被改写？）`);
  process.exit(1);
}

// 提取 settings-view 的 IIFE 主体：`(function (globalScope) {` 之后到
// `// [settings-view:tail]` 之前（尾部的 module.exports 追加段不内联）。
const open = view.indexOf('(function (globalScope) {');
const tail = view.indexOf('// [settings-view:tail]', open);
if (open < 0 || tail < 0 || tail <= open) {
  console.error('[sync-settings-view] 无法定位 settings-view 的 IIFE 边界（文件结构变化？）');
  process.exit(1);
}
let body = view.slice(open, tail);
// 去掉末尾注释行与空行，保持干净
body = body.replace(/\s*$/, '\n');

// 主体以 `(function (globalScope) {` 开头，截掉它（由下面的包裹改回）
body = body.replace(/^\(function \(globalScope\) \{/, '');
const inline =
  'var pharosSettingsView = (function (globalScope) { // eslint-disable-line no-unused-vars\n' +
  body +
  '\treturn { mountSettingsTab: mountSettingsTab };\n' +
  '})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));\n';

const next = client.replace(MARKER, inline);
fs.writeFileSync(clientFile, next);
console.log(`[sync-settings-view] 已内联 ${(inline.match(/\n/g) || []).length} 行视图代码 → ${clientFile}`);