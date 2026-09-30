// dsh-pharos — 把规范源 lib/settings-view.js 内联进浏览器 bundle lib/client.js。
//
// 背景：浏览器半是单文件 bundle（__ModuleLoader__ 只服务一块 entry），
// 运行时无法按文件加载 lib/settings-view.js，因此视图以内联形式存在于
// lib/client.js 的 //#region settings-view … //#endregion settings-view 块
// （契约 §1 文件职责）。本脚本保持「独立文件为规范源」：视图改动只改
// settings-view.js，然后运行本脚本重新生成内联区（pretest 会自动执行）。
//
// 幂等：按 region 边界整体替换，重复运行输出一致（第二次跑不会再报错）。
//
// 用法：node tools/sync-settings-view.mjs   （幂等；输出已同步提示）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewFile = path.join(root, 'lib', 'settings-view.js');
const clientFile = path.join(root, 'lib', 'client.js');
const REGION_START = '//#region settings-view';
const REGION_END = '//#endregion settings-view';

const view = fs.readFileSync(viewFile, 'utf8');
const client = fs.readFileSync(clientFile, 'utf8');

// 按「行」定位 region 边界：trim 后精确等于标记的行。缩进无关、
// 也不怕文件头注释里的字面串（trim 后不相等，不会误匹配）。
const lines = client.split('\n');
let regionStartLine = -1;
let regionEndLine = -1;
for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();
  if (trimmed === REGION_START) { regionStartLine = i; break; }
}
if (regionStartLine >= 0) {
  for (let i = regionStartLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === REGION_END) { regionEndLine = i; break; }
  }
}
if (regionStartLine < 0 || regionEndLine < 0) {
  console.error(`[sync-settings-view] ${clientFile} 缺少 region 边界（${REGION_START} / ${REGION_END}，可能已被改写？）`);
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
body = body.replace(/\s*$/, '\n');
body = body.replace(/^\(function \(globalScope\) \{/, '');

const inline =
  '\t// 规范源：lib/settings-view.js —— 修改视图请改独立文件，然后运行\n' +
  '\t// `node tools/sync-settings-view.mjs` 重新生成本 region（保证同步；pretest 自动执行）。\n' +
  '\tvar pharosSettingsView = (function (globalScope) { // eslint-disable-line no-unused-vars\n' +
  body +
  '\treturn { mountSettingsTab: mountSettingsTab };\n' +
  '\t})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));\n';

const head = lines.slice(0, regionStartLine).join('\n');
const tailLines = lines.slice(regionEndLine + 1);
const next = head + '\n' + REGION_START + '\n' + inline + '\t' + REGION_END +
  (tailLines.length > 0 ? '\n' + tailLines.join('\n') : '');
fs.writeFileSync(clientFile, next);
console.log(`[sync-settings-view] 已内联 ${(inline.match(/\n/g) || []).length} 行视图代码 → ${clientFile}`);