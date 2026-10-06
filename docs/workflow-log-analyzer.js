/**
 * dsh-pharos 工作流日志分析器（v0.6.0）
 *
 * 用法：在 DSH 控制台（devtools console）整段粘贴执行。
 * 前置：已勾选「工作流提醒」+「工作流日志」并**重启过 DSH**。
 *
 * 它做什么：把 debug().recentFrames 里的工作流帧按时间线整理成人读摘要，
 *           并统计静默/漏报/去重是否符合设计预期。
 */
(function () {
  const API = window.__dshPharos;
  if (!API || !API.debug) {
    console.error('[pharos] __dshPharos 不可用 —— 插件未加载？先确认 DSH 已启动且插件启用');
    return;
  }

  const d = API.debug();
  const cfg = d.config || {};
  const frames = d.recentFrames || [];
  const wf = frames.filter((f) => f.kind === 'workflow');

  const pad = (s, n) => String(s ?? '').padEnd(n, ' ');
  const ts = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

  console.log('%c=== dsh-pharos 工作流日志分析 ===', 'color:#378ADD;font-weight:bold');
  console.log('配置：workflowEvents=%s  workflowLog=%s  skipSubagents=%s  quietHours=%s',
    cfg.workflowEvents, cfg.workflowLog, cfg.skipSubagents,
    cfg.quietHours && cfg.quietHours.enabled ? `${cfg.quietHours.start}-${cfg.quietHours.end}` : 'off');
  console.log('SSE：%s   累计收到帧：%d   recentFrames 容量：%d',
    d.sse, d.framesReceived, frames.length);

  if (wf.length === 0) {
    console.log('%c没有 workflow 帧。', 'color:#E24B4A;font-weight:bold');
    console.log('排查顺序：');
    console.log('  1) 两个开关是否都已勾选？开启后**必须重启 DSH**（订阅在加载时建立）');
    console.log('  2) 任务是否真的用了 workflow 工具？（普通对话 / 普通 subagent 不会产生事件）');
    console.log('  3) 脚本里是否真的调用了 phase() / agent() / log()？');
    console.log('  4) 全部 recentFrames（判断是否有其他 kind 的帧到达）：');
    console.table(frames);
    return;
  }

  // ---- 1. 时间线 ----
  console.log('%c--- 工作流帧时间线（共 %d 条）---', 'color:#378ADD;font-weight:bold', wf.length);
  const ICON = { phase: '◆', 'agent-start': '▶', 'agent-end': '■', log: '·' };
  const rows = wf
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((f) => ({
      时间: ts(f.ts),
      子类: f.subtype ?? '(无)',
      静默: f.silent === true ? '是' : '',
      工作流: f.sessionTitle || '(空)',
      内容: (f.note || '').slice(0, 60),
    }));
  console.table(rows);
  console.log('图例：◆ 进入阶段   ▶ agent 启动   ■ agent 结束   · 日志（静默）');

  // ---- 2. 分类统计 ----
  const by = {};
  for (const f of wf) by[f.subtype ?? '(无)'] = (by[f.subtype ?? '(无)'] ?? 0) + 1;
  console.log('%c--- 分类统计 ---', 'color:#378ADD;font-weight:bold');
  console.log(JSON.stringify(by));

  // ---- 3. 设计预期核对 ----
  console.log('%c--- 与设计预期核对 ---', 'color:#378ADD;font-weight:bold');
  const checks = [];
  const logFrames = wf.filter((f) => f.subtype === 'log');
  const notSilent = wf.filter((f) => f.subtype !== 'log');

  checks.push(['log 帧全部标 silent', logFrames.every((f) => f.silent === true),
    `log ${logFrames.length} 条，其中 silent=${logFrames.filter((f) => f.silent === true).length} 条`]);
  checks.push(['非 log 帧都不标 silent', notSilent.every((f) => f.silent !== true),
    `非 log ${notSilent.length} 条`]);
  checks.push(['工作流名非空（无「工作流『工作流』」）',
    wf.every((f) => f.sessionTitle !== '' && f.sessionTitle !== '工作流'),
    [...new Set(wf.map((f) => f.sessionTitle))].join(' / ') || '(全空)']);
  checks.push(['无重复 dedupeKey（3s 窗口内）',
    new Set(wf.map((f) => `${f.subtype}:${f.ts}`)).size === wf.length,
    '同键去重由 host 保证，此处只查时间线异常密集']);

  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? '✅' : '⚠️ '} ${name} —— ${detail}`);
  }

  // ---- 4. log 采样节奏 ----
  if (logFrames.length >= 2) {
    const ts2 = logFrames.map((f) => f.ts).sort((a, b) => a - b);
    const gaps = ts2.slice(1).map((t, i) => (t - ts2[i]) / 1000);
    console.log('%c--- log 采样节奏（设计：每 run 最多 1 帧 / 5 秒）---',
      'color:#378ADD;font-weight:bold');
    console.log('  相邻间隔（秒）：', gaps.map((g) => g.toFixed(1)).join(', '));
    const tooFast = gaps.filter((g) => g < 4.5).length;
    console.log(`  ${tooFast === 0 ? '✅' : '⚠️ '} 小于 4.5 秒的间隔：${tooFast} 个`,
      tooFast === 0 ? '（限流生效）' : '（限流可能未生效，检查 WORKFLOW_LOG_SAMPLE_MS）');
  }

  // ---- 5. 其他 kind（排查干扰）----
  const other = frames.filter((f) => f.kind !== 'workflow');
  if (other.length) {
    console.log('%c--- 同期其他帧（可能造成额外通知）---', 'color:#BA7517;font-weight:bold');
    console.table(other.map((f) => ({
      时间: ts(f.ts), kind: f.kind, 工作流: f.sessionTitle || '', 内容: (f.note || '').slice(0, 50),
    })));
    if (other.some((f) => f.kind === 'done')) {
      console.log('%c提示：出现 done 帧 = 宿主为子代理会话也发了「任务已完成」。', 'color:#BA7517');
      console.log('      这是 skipSubagents 的**已知缺口**（本地 done 路径无子代理判定），');
      console.log('      与 workflow 提醒无关：子代理 done 的过滤已在 v0.6.0 修复');
      console.log('      （若这里出现 done 帧，说明该子代理不是 workflow 场景的 agent）。');
    }
  }

  console.log('%c把上面整段输出贴给我，我可以逐条帮你核对。', 'color:#888780');
  return { config: cfg, sse: d.sse, framesReceived: d.framesReceived, workflowFrames: wf, allFrames: frames };
})();
