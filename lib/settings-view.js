// dsh-pharos — settings view (browser half · M1).
//
// 本文件是「设置 → 消息通知」顶级分区的独立视图模块（scope: pharos-notifications）。
//
// ============================================================================
// ① React 获取方式冲刺定案（契约 docs/contract-m1.md §7.1，2026-09-30 源码级核实）
// ============================================================================
// 结论：(a) require('react') ——浏览器 bundle 的模块表内直接可用，**采用此方案**。
//       (b) runner 全局 React ——只对「动态包」（harness 路径）以闭包符号注入，
//           对标准 bundle（dshmarket / dsh-pharos 这类 __ModuleLoader__ 包）不成立，
//           故不作为取法；(c) 纯 DOM / register 收非 React 产物 ——不需要：槽合约
//           要求 React 组件（见下），(a) 已满足，无需降级。设置页**不降级 M1.5**。
//
// 证据（全部在目标运行时 0.2.0-rc.2 源码）：
//   - dshmarket/client/client.js:29   `let react = require("react");`
//     —— 已安装到 desktop profile 的 dshmarket 在其 __ModuleLoader__ factory 顶部
//        经模块表取 react，全包用 react.createElement 建视图（:14605/:14618/:14632）；
//        :14588-14590 注释原文 "this package's bundle resolves react through the
//        host's module table, so an element returned here mounts anywhere in that tree"。
//   - dsh-cordis-client-runner/lib/client.js:29   `let react = require("react");`
//     —— runner 自身同样经模块表取 react，并把它作为闭包符号传给动态包（:171）；
//        :55 动态包重定向文案 "React arrives as the `React` closure symbol"
//        ——注意这仅适用于动态包路径，标准 bundle 仍走 require("react")。
//   - dsh-client-ui-settings-plugins/lib/client.js:7-9
//     —— 官方设置页外壳 require("react") + require("react/jsx-runtime")。
//   - dsh-client-ui-settings-general/lib/client.js:338
//     —— 设置外壳用 renderSlot("settings.section", { close }, { only: active })
//        渲染本插件所注册槽位的分区组件（React 组件）。原引用的
//        renderSlot("settings.plugins.tab", {}, {only:id})
//        （settings-plugins/lib/client.js:68/:124）是标签页形态的渲染方，
//        槽位已于 2026-10-05 迁移，见文件头 ②。
//   - @deepseek-ai/dsh-client-modules/lib/client.js:697-706
//     —— 模块表 require(spec) 解析链：seed word（staticModules，含 react）→ 已
//        物化模块 → 已注册 factory；:548 this.seed = new Map(Object.entries(staticModules))。
//   - dsh-client-ui-slots/lib/index.js:163-243
//     —— slots.register(options, component) 槽合约：list 槽必须带 options.id
//        （:182 "list slot ... requires options.id"）；component 存于 entry 交渲染
//        机制以 React 组件方式渲染（hooks 可用，settings-plugins 的
//        PluginsSettingsSection 即用 useState/useEffect/useId/useRef）；
//        label 可为字符串或 thunk（resolveSlotLabel :27-29）。
//   - docs/research/notify-me-analysis.md:156 —— 第三方惯例同款：
//        "react 从 shell 模块表 require('react') 拿"。
//
// 取法实现：getReact()（本文件内）——模块表 require("react") 优先，window.React /
// globalThis.React 兜底；均不可用则抛带契约引用的错误（此时设置页降级为不可用，
// 通知核心不受影响）。require 只在函数体内延迟调用，保证本文件零执行副作用。
//
// ============================================================================
// ② 槽位挂载契约（pharos-client 接线用）
// ============================================================================
//   export mountSettingsSection(ctx, { configApi })
//     - ctx.get('slots', false) 惰性取 slots 服务（slots/uiSession/sessions 均已
//       声明在插件 inject 里——cordis 上下文代理对未声明的直接属性读
//       （ctx.slots / ctx.uiSession）会抛 "cannot get property X without inject"，
//       见 lib/client.js 导出注释；v0.3 只走 ctx.get 是没炸的原因）。
//     - slots.inject('settings.section', () =>
//         slots.register({ name:'settings.section', id:'pharos-notifications',
//                          order:30, label:'消息通知' }, PharosSettingsView))
//       （异步于声明期注册，照 dshmarket client/client.js / dsh-better-sidebar）
//
//   —— 为什么是 settings.section（0.2.0-rc.2 运行时源码核实，2026-10-05）——
//   M1 曾判定「settings.section 不存在」，据此选了 settings.plugins.tab。该判定
//   有误：当时查的是 @deepseek-ai/dsh-client-ui-settings（该包只提供底座与配置
//   表单），而槽位声明方是 @deepseek-ai/dsh-client-ui-settings-general：
//     - 声明  settings-general/lib/client.js:1137-1140
//             "settings.section": { kind: "list", scope: "root" }
//     - 导航  settings-general/lib/client.js:1017-1040
//             slots.entries("settings.section") → sort(order) → 左侧导航行
//     - 渲染  settings-general/lib/client.js:338
//             renderSlot("settings.section", { close }, { only: active })
//   → 本地 0.2.0-rc.2 上该槽一直可用。分区 ownerProps 会带 { close }，而本视图
//     签名不收 props，故无影响。
//
//   层级选择依据：settings.section = 功能/产品域设置（账号 · 通用 · 模型 · Agent
//   预设 · 插件市场 · 侧边卡片）；plugins.* = 插件管理域。本页配置的是通知行为
//   （音效 · 免打扰 · 过滤 · 推送渠道），属前者 —— 故不再占用「内置插件」分区的
//   settings.plugins.tab（该分区官方定位是「设置里只保留只读的插件列表」）。
//   同域先例：dsh-better-sidebar（第三方功能型插件，order 100）只用 settings.section。
//   dshmarket 之所以多占座位，是因为它的配置卡内容是「包自身运维」（版本 · 更新
//   通道 · 下载区域 · 卸载），那属于 plugins.bundle.config 的语义域；pharos 没有
//   这类内容，故不注册第二个座位。
//
//   自绘标题：顶级分区的壳不画标题（对照官方 PluginsSettingsSection 自绘 <h2>），
//   而标签页里标题由分区壳 + 标签标签提供 —— 所以本视图自己渲染 .pharos-title
//   （16px / weight 500 / line-height 24，对齐 ui-settings-models 的 .title 与
//   dshmarket 的 .title）。
//
//   order 取 30：本机实测既有分区为 general 0 / models 10 / plugins(内置插件) 15 /
//   agent-presets 20 / market(插件市场) 40 / better-sidebar(侧边卡片) 100 ——
//   20 与 40 之间为空窗。（原 settings.plugins.tab 用 order 60，与 dshmarket 同位，
//   而 slots 排序是 Array.sort(order)，同值退化为注册先后、契约未规定 tie-break。）
//
//   —— 图标（2026-10-05 起）——
//   两处，均已落地：
//   ① 插件卡片 / 组件行 / 组合包详情页：宿主读 `package.json` 的 `icon` 字段
//      （同机 dsh-better-sidebar / dsh-context / dsh-client-ui-skill-explorer 均如此），
//      以 `<img>` 渲染，CARD_ARTWORK_SIZE 36 / ROW_ARTWORK_SIZE 30，
//      `object-fit: contain` 不裁切 → 根目录 `icon.svg` 即我们的标记（彩色）。
//   ② 设置导航那一行：`settings.section` 只有 id/order/label，**没有 icon 字段**，
//      外壳的 navIcon(id) 只认 account/models/agent-presets/plugins，其余 fallback
//      齿轮 → 由本文件的 installSettingsNavIcon() 按标签文本认领该行并换节点。
//   形状语言必须与宿主一致：ui-primitives 的 artwork 统一是 16 网格 + fill:none +
//   stroke:currentColor + ICON_MEDIUM_STROKE 1.3 + round cap/join。故标记也按 16
//   网格描边绘制，灯头实心（16px 下描边圆心孔会塌成亚像素）。不画光束：发丝细条在
//   16px 下会糊成脏点。图标尺寸已用栅格化数值验证（/tmp/raster*.mjs 的做法）。
//   两处形状必须一致，唯一真源是 icon.svg，PHAROS_MARK_* 是其副本，由 smoke.mjs 断言。
//     - 返回清理函数（dispose inject effect + register disposer）；在宿主卸载时调用。
//     - configApi：浏览器半的既有全局 API（v0.3 window.__dshPharos →
//       { config, setConfig, resetConfig, test(kind), debug }），测试按钮与
//       debug 刷新用它；不传则回退 window.__dshPharos，再没有则测试仅记 debug。
//   viewFactory = PharosSettingsView：React 函数组件（React.createElement 手写，
//   无 JSX），经 renderSlot 渲染，hooks（useState/useEffect）可用。
//
// ============================================================================
// ③ 数据流与安全（与 pharos-host 契约 docs/contract-m1.md §3/§4 对齐）
// ============================================================================
//   - GET  /pharos/api/config   载入（服务端合并 DEFAULT_CONFIG；secret 打码 "***"）
//   - PUT  /pharos/api/config   保存（完整配置深合并；响应为打码视图，直接回填）
//   - GET  /pharos/api/webhooks 载入 webhook 行（secret 打码）
//   - POST /pharos/api/trigger  remote 测试兜底（configApi.test 不可用时）
//   - 全为同源 fetch；host 不可达（离线/未挂载）→ 顶部横幅"主机半未激活"，
//     回退 localStorage(dshPharos.config) 偏好层（仅本地生效，webhook 需 host）。
//   - 打码语义（host 侧必须实现，见报告）：GET 返回的 apiToken/webhook.secret 为
//     "***"；PUT 载荷里值为 "***" → host 保留原值（不覆盖），"" → 清除，其它 → 设置。
//
// ============================================================================
// ④ 内联/加载约束（pharos-client 任务 3 内联进 lib/client.js 时）
// ============================================================================
//   - 纯 factory 片段：无 import/export/JSX；顶层只定义常量与函数，绝不执行
//     DOM/fetch/网络（唯一"副作用"是文件尾部的导出赋值，幂等无害）。
//   - 内联进 client.js 的 __ModuleLoader__.load factory 后，`require` 即模块表
//     require（见①），getReact() 直接命中 react。
//   - 文件尾部 export Tail 向内联场景安全：只向 module.exports **追加**属性；
//     client.js 末尾会整体重绑 module.exports，故不影响其 {name, inject, apply}。
//   - 自检（/tmp/settings-view-check.mjs）以 vm 方式读取本文件文本 + stub
//     require/module/window/document/fetch 运行，与 smoke.mjs 手法一致。
// ============================================================================

(function (globalScope) {
	"use strict";

	// ---- 槽位与常量（契约 §4 / §7.3）----
	// 槽位：顶级设置分区。原为「内置插件」分区内的 settings.plugins.tab，迁移依据见文件头 ②。
	var SLOT_NAME = "settings.section";
	var SLOT_ID = "pharos-notifications";
	var SLOT_ORDER = 30;
	var SLOT_LABEL = "消息通知";
	// 标题行上显示的包名与版本（对标 dshmarket「插件市场 dsh-market v1.66.8」与
	// dsh-better-sidebar「DSH-better-sidebar v0.24.1」两家的标题行写法）。
	//
	// 版本是**编译期常量**而非运行时读 manifest —— 与 better-sidebar 同款做法
	//（其 bundle 内有字面量 VERSION = "0.24.1"）。DSH 没有任何 slot 把包版本传给
	// 浏览器半，settings.section 只投影 id/order/label，所以只能这样带。
	// 代价是可能与 package.json 漂移 → smoke.mjs 的 M1-J 段断言两者一致。
	var PKG_NAME = "dsh-pharos";
	var PKG_VERSION = "0.6.2";
	var CONFIG_URL = "/pharos/api/config";
	var WEBHOOKS_URL = "/pharos/api/webhooks";
	var TRIGGER_URL = "/pharos/api/trigger";
	var STORAGE_KEY = "dshPharos.config";      // 与浏览器半 client.js CONFIG_KEY 一致
	var MASK = "***";
	// v0.6.2：内置两个预设（简洁 / 详细）。判定方式：**template 归一化后全等**
	// —— 不新增字段，故零落盘风险，且老配置（自定义模板）自然被判为「自定义」。
	//
	// ⚠️ 钉钉 markdown 的换行规则（官方 FAQ）：「换行格式： \n 重要 \n前后两个空格」。
	//    行尾没有两个空格时，单换行会被折叠成空格 —— 裸行、`> ` 引用块逐行都救不了
	//    （真机三轮实测）。**硬换行的补齐在 lib/host/webhook.js 的 renderTemplate 里自动做**，
	//    所以这里写紧凑的单换行即可，不必在模板里手写尾随空格。
	// 简洁档**不放 {kindLabel}**：{note} 本身已是「任务完成 / 出错：xxx」这类结论，
	// 再叠一行「完成」在钉钉里会显示成两行重复（真机截图确认）。
	var TEMPLATE_PRESET_CONCISE = "### {title}\n\n**{note}**\n\n{summary}\n{time}";
	var TEMPLATE_PRESET_DETAIL = "### {title}\n\n**{note}**\n\n---\n\n⏱ {duration}\n🔢 {tokens}\n💾 {cache}\n⚡ {tps}\n🕐 {time}";
	// 自定义档的**初始内容**（不是第 3 个预设，仅作为「进入高级模式时的起手式」）。
	// 为什么不能沿用当前模板当 seed：用户从「详细」切过来时 seed = 详细原文 →
	// 内容与详细逐字相同 → 用户切完发现「详细和自定义没区别」（真机反馈）。
	// 故给一份**变量更全、结构明显不同**的起手式。{summary} 在无统计时为空串，整段自然消失。
	var TEMPLATE_PRESET_CUSTOM_SEED = "### {title}\n\n**{note}**\n\n会话 {sessionTitle}（{sessionId}）\n类型 {kind} · {kindLabel}\n{summary}\n时间 {time}";
	/**
	 * 模板归一化：消掉「换行写法」与「引用前缀」的差异后比对。
	 * 目的是**不再逐个列举历史版本**——改预设时只要内容不变、只是换行/前缀写法变了，
	 * 老配置就能被自动认出来并升级（列清单的办法每改一次就要补一条，已漏过一次）。
	 */
	function normalizeTemplate(tpl) {
		return String(tpl == null ? "" : tpl)
			.split("\n")
			.map(function (line) { return line.replace(/^\s*>\s?/, "").replace(/\s+$/, ""); })
			.join("\n")
			.replace(/\n{2,}/g, "\n")   // 空行折叠：`a\n\nb` 与 `a\nb` 视为同一内容
			.trim();
	}
	// 内容本身就变过的历史版本（归一化也认不出），只能显式列；kind 用 "seed" 表示自定义起手式
	var LEGACY_NORMS = [
		{ tpl: "### {title}\n\n**{kindLabel}**\n\n{note}\n\n{summary}\n{time}", kind: "concise" },
		{ tpl: "### {title}\n\n{note}\n\n会话 {sessionTitle}（{sessionId}）\n类型 {kind} / {kindLabel}\n耗时 {duration} · {tokens} tokens · 缓存 {cache} · {tps}\n时间 {time}", kind: "seed" },
		{ tpl: "### {title}\n\n**{note}**\n\n会话 {sessionTitle}\n会话 ID {sessionId}\n类型 {kind} · {kindLabel}\n耗时 {duration} · {tokens} tokens\n缓存 {cache} · {tps}\n时间 {time}", kind: "seed" },
	];
	var NORM_PRESET = {
		concise: normalizeTemplate(TEMPLATE_PRESET_CONCISE),
		detail: normalizeTemplate(TEMPLATE_PRESET_DETAIL),
		seed: normalizeTemplate(TEMPLATE_PRESET_CUSTOM_SEED),
	};
	var NORM_LEGACY = LEGACY_NORMS.map(function (l) { return { norm: normalizeTemplate(l.tpl), kind: l.kind }; });
	/** 归一化归类：concise / detail / seed（自定义起手式）/ custom（用户自己写的）。 */
	function presetKindOf(tpl) {
		var n = normalizeTemplate(tpl);
		if (n === "" || n === NORM_PRESET.concise) return "concise";
		if (n === NORM_PRESET.detail) return "detail";
		if (n === NORM_PRESET.seed) return "seed";
		for (var i = 0; i < NORM_LEGACY.length; i++) {
			if (n === NORM_LEGACY[i].norm) return NORM_LEGACY[i].kind;
		}
		return "custom";
	}
	/**
	 * 旧版预设原文 → 当前预设原文。**只动「本插件写过的预设」，绝不动用户自己写的内容**。
	 * 为什么必须升级：模板是插件维护的；不升级既会让 radio 显示错档，又会继续按旧格式推送。
	 */
	function migrateTemplate(tpl) {
		if (typeof tpl !== "string" || tpl.trim() === "") return tpl;
		var kind = presetKindOf(tpl);
		if (kind === "custom") return tpl;               // 用户内容：原样保留
		var cur = kind === "seed" ? TEMPLATE_PRESET_CUSTOM_SEED : templateOfPreset(kind);
		return tpl.trim() === cur ? tpl : cur;
	}
	/** 列表里是否有需要升级的旧预设原文（决定初载后要不要回写一次）。 */
	function hasLegacyTemplate(list) {
		return asArray(list).some(function (w) {
			var t = typeof (w && w.template) === "string" ? w.template : "";
			return t.trim() !== "" && t.trim() !== migrateTemplate(t);
		});
	}
	// 保持旧名可用（多处引用 DEFAULT_TEMPLATE）
	var DEFAULT_TEMPLATE = TEMPLATE_PRESET_CONCISE;
	/** 当前模板属于哪个预设：concise / detail / custom（空 → 默认 concise）。 */
	function templatePresetOf(tpl) {
		var k = presetKindOf(tpl);
		return k === "seed" ? "custom" : k;
	}
	function templateOfPreset(p) {
		if (p === "detail") return TEMPLATE_PRESET_DETAIL;
		if (p === "custom") return TEMPLATE_PRESET_CUSTOM_SEED;
		return TEMPLATE_PRESET_CONCISE;
	}
	var DEBUG_CAP = 200;
	// v0.6.2：自动保存的 debounce。改动停下 800ms 才落盘 —— 连续敲模板/URL 时
	// 只在最后写一次，避免每敲一个字符发一次 PUT。
	var AUTO_SAVE_MS = 800;
	var CHANNELS = [
		{ value: "wecom", label: "企业微信" },
		{ value: "feishu", label: "飞书" },
		{ value: "dingtalk", label: "钉钉" },
		{ value: "generic", label: "通用 Webhook" }
	];
	// M2.5：对齐 host 的 HOST_KINDS（补 job/test/workflow；保留 needs-you 以兼容既有
	// 用户配置——它在 host 侧产不出帧，选了不会误匹配，只是无效项）。
	var EVENTS = [
		{ value: "done", label: "完成" },
		{ value: "error", label: "出错" },
		{ value: "interrupted", label: "中断" },
		{ value: "limit", label: "上限" },
		{ value: "needs-you", label: "需要你" },
		{ value: "job", label: "后台任务" },
		{ value: "remote", label: "远程" },
		{ value: "test", label: "测试" },
		{ value: "workflow", label: "工作流" }
	];
	var TEST_KINDS = [
		{ value: "done", label: "完成" },
		{ value: "attention", label: "需要你" },
		{ value: "error", label: "出错" },
		{ value: "interrupted", label: "中断" },
		{ value: "limit", label: "上限" },
		{ value: "remote", label: "远程" },
		{ value: "workflow", label: "工作流" }
	];

	// 契约 §4 DEFAULT_CONFIG（缺省合并；hostNotify 预留不进本轮实现）
	function defaultConfig() {
		return {
			enabled: true,
			toast: true,
			sound: true,
			volume: 0.5,
			autoFocus: true,
			attentionHiddenOnly: false,
			doneHiddenOnly: true, // 向后兼容（由 doneNotifyMode 取代）
			// v0.6.1：完成提醒三档 off | hidden(默认，同竞品) | always
			doneNotifyMode: "hidden",
			currentQuiet: true,
			minIntervalMs: 6000,
			reAlertMs: 600000,
			blinkFallback: true,
			language: "auto",
			quietHours: { enabled: false, start: "23:00", end: "08:00" },
			skipSubagents: true,
			jobEvents: true,
			// M2.5 workflow（默认关；订阅在启动时建立 → 开启需重启 DSH，关闭即时生效）
			workflowEvents: false,
			workflowLog: false,
			hostNotify: false,
			apiToken: "",
			webhooks: []
		};
	}

	// ---- React 获取（任务 1 定案 (a)）----
	var reactSingleton = null;
	var reactTried = false;
	function getReact() {
		if (reactSingleton) return reactSingleton;
		if (!reactTried) {
			reactTried = true;
			try {
				if (typeof require === "function") reactSingleton = require("react");
			} catch (e) { /* 模块表未命中 → 继续探测 */ }
			if (!reactSingleton) {
				reactSingleton = (typeof window !== "undefined" && window.React) ||
					(typeof globalThis !== "undefined" && globalThis.React) ||
					(globalScope && globalScope.React) ||
					null;
			}
		}
		if (!reactSingleton || typeof reactSingleton.createElement !== "function") {
			throw new Error(
				"[pharos-settings] React 不可用：require('react') 未命中且无全局 React。" +
				"（契约 §7.1 定案 (a)：浏览器 bundle 应经模块表 require('react')，证据见文件头注释。）"
			);
		}
		return reactSingleton;
	}

	// ---- 工具 ----
	function uid() {
		return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}
	function asArray(v) {
		return Array.isArray(v) ? v : [];
	}
	function clampVolume(v) {
		var n = Number(v);
		if (!Number.isFinite(n)) return 0.5;
		return Math.min(1, Math.max(0, n));
	}
	function clampMs(v) {
		var n = Number(v);
		if (!Number.isFinite(n) || n < 0) return 0;
		return Math.round(n);
	}
	// 深合并（偏好补丁 / PUT 响应回填用；quietHours、webhooks 为对象/数组整体替换）
	function mergeConfig(base, patch) {
		var out = {};
		var defaults = defaultConfig();
		for (var k in defaults) {
			var b = base && typeof base[k] !== "undefined" ? base[k] : defaults[k];
			var p = patch && typeof patch[k] !== "undefined" ? patch[k] : undefined;
			out[k] = p !== undefined ? p : b;
		}
		// webhooks 数组逐个合并，保证行内默认字段齐全
		if (patch && Array.isArray(patch.webhooks)) {
			out.webhooks = patch.webhooks.map(function (w) {
				return {
					name: (w && w.name) || "",
					channel: (w && w.channel) || "generic",
					url: (w && w.url) || "",
					secret: (w && typeof w.secret === "string") ? w.secret : "",
					events: asArray(w && w.events),
					enabled: !(w && w.enabled === false),
					// 与 draftRows 保持一致：任何构造 webhook 行的路径都做旧预设升级，
					// 避免「某条路径漏迁移 → 又按旧折叠格式推送」。
					template: migrateTemplate((w && typeof w.template === "string" && w.template) || DEFAULT_TEMPLATE)
				};
			});
		} else {
			out.webhooks = asArray((patch && Array.isArray(patch.webhooks)) ? patch.webhooks : (base && Array.isArray(base.webhooks) ? base.webhooks : []));
		}
		return out;
	}
	function readLocalConfig() {
		try {
			var raw = (typeof globalScope !== "undefined" && globalScope.localStorage) ?
				globalScope.localStorage.getItem(STORAGE_KEY) : null;
			return raw ? mergeConfig(null, JSON.parse(raw)) : null;
		} catch (e) { return null; }
	}
	function writeLocalConfig(cfg) {
		try {
			if (typeof globalScope === "undefined" || !globalScope.localStorage) return false;
			var clean = {
				enabled: cfg.enabled, toast: cfg.toast, sound: cfg.sound,
				volume: cfg.volume, autoFocus: cfg.autoFocus,
				attentionHiddenOnly: cfg.attentionHiddenOnly, doneHiddenOnly: cfg.doneHiddenOnly,
				doneNotifyMode: cfg.doneNotifyMode,
				currentQuiet: cfg.currentQuiet, minIntervalMs: cfg.minIntervalMs,
				reAlertMs: cfg.reAlertMs, blinkFallback: cfg.blinkFallback,
				language: cfg.language, quietHours: {
					enabled: !!cfg.quietHours.enabled,
					start: cfg.quietHours.start || "23:00",
					end: cfg.quietHours.end || "08:00"
				},
				skipSubagents: cfg.skipSubagents, jobEvents: cfg.jobEvents,
				hostNotify: !!cfg.hostNotify, apiToken: cfg.apiToken,
				webhooks: webhooksPayload(cfg.webhooks)
			};
			globalScope.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
			return true;
		} catch (e) { return false; }
	}

	// ---- Webhook 行草案（带 _ 前缀的内部字段，保存时剔除）----
	function draftRows(list) {
		return asArray(list).map(function (w) {
			return {
				_key: uid(),
				name: (w && w.name) || "",
				channel: (w && w.channel) || "generic",
				url: (w && w.url) || "",
				secret: (w && typeof w.secret === "string") ? w.secret : "",
				_secretDirty: false,
				events: asArray(w && w.events),
				enabled: !(w && w.enabled === false),
				// 旧预设原文自动升级到当前版（模板由插件维护，不是用户内容；见 LEGACY_PRESETS）
				template: migrateTemplate((w && typeof w.template === "string" && w.template) || DEFAULT_TEMPLATE)
			};
		});
	}
	function webhooksPayload(rows) {
		return asArray(rows).map(function (r) {
			return {
				name: r.name || "",
				channel: r.channel || "generic",
				url: r.url || "",
				secret: r._secretDirty ? (r.secret || "") : (typeof r.secret === "string" ? r.secret : ""),
				events: asArray(r.events),
				enabled: !(r.enabled === false),
				template: (typeof r.template === "string" && r.template) || DEFAULT_TEMPLATE
			};
		});
	}

	// ---- 同源 fetch（含 JSON content-type 与错误细节）----
	function jsonFetch(url, init) {
		var headers = { Accept: "application/json" };
		if (init && init.body) headers["Content-Type"] = "application/json";
		var opts = Object.assign({}, init, { headers: Object.assign({}, init && init.headers, headers) });
		return (typeof globalScope !== "undefined" && globalScope.fetch ? globalScope.fetch(url, opts) : fetch(url, opts))
			.then(function (res) {
				if (!res || !res.ok) {
					var err = new Error("HTTP " + (res ? res.status : 0));
					err.status = res ? res.status : 0;
					err.statusText = res ? res.statusText : "";
					return res && res.json ? res.json().then(function (d) {
						err.detail = d;
						throw err;
					}, function () { throw err; }) : Promise.reject(err);
				}
				return res.json();
			});
	}

	// ---- 样式（幂等注入；data-plugin 标记，照 turn-notify / settings-plugins 做法）----
	var styleInjected = false;
	function ensureStyle() {
		if (styleInjected) return;
		styleInjected = true;
		try {
			var doc = typeof document !== "undefined" ? document : (globalScope && globalScope.document);
			if (!doc || !doc.head || typeof doc.querySelector !== "function") return;
			if (doc.querySelector("style[data-plugin-css=\"pharos-settings-view\"]")) return;
			var tag = doc.createElement("style");
			tag.setAttribute("data-plugin", "dsh-pharos");
			tag.setAttribute("data-plugin-css", "pharos-settings-view");
			tag.textContent = [
				".pharos-settings{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#24292f);color-scheme:light dark}",
				// 顶级分区自绘页面标题（壳不画标题）；字号/字重/行高对齐 ui-settings-models 的 .title
				// 与 dshmarket 的 .title（16px / 500 / 24），使本页在设置里不显得是外来者。
				".pharos-settings .pharos-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,#24292f)}",
				// 标题行：标题 + 包名 + 版本徽章（对标 dshmarket / dsh-better-sidebar 的标题行）
				".pharos-settings .pharos-titleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".pharos-settings .pharos-pkg{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8c959f)}",
				".pharos-settings .pharos-ver{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8c959f);border:1px solid var(--dsw-alias-border-l2,#d8dee4);border-radius:999px;padding:0 7px}",
				".pharos-settings b.pharos-h{display:block;font-size:13px;font-weight:600;margin:6px 0 8px;color:var(--dsw-alias-label-secondary,#57606a)}",
				".pharos-settings .pharos-field{display:flex;align-items:center;gap:8px;min-height:30px;font-size:13px;line-height:20px}",
				".pharos-settings .pharos-field input[type=text],.pharos-settings .pharos-field input[type=number],.pharos-settings .pharos-field input[type=time],.pharos-settings .pharos-field input[type=password],.pharos-settings .pharos-field select,.pharos-settings .pharos-field textarea{background:var(--dsw-alias-field-bg,#fff);color:var(--dsw-alias-label-primary,#24292f);border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;padding:4px 8px;font:inherit}",
				".pharos-settings .pharos-field input[type=range]{flex:0 0 140px}",
				// 标签不得被控件挤压：.pharos-field 是 flex，控件（尤其 option 文案长的 select）
				// 会撑大并把标签压成逐字竖排。v0.6.1 的「完成」提醒时机三档下拉即栽在此处。
				".pharos-settings .pharos-field>span:first-child{flex:0 0 auto}",
				".pharos-settings .pharos-field select{flex:0 0 auto;max-width:100%}",
				".pharos-settings .pharos-field label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}",
				".pharos-settings .pharos-hint{color:var(--dsw-alias-label-tertiary,#8c959f);font-size:12px;line-height:18px;margin:2px 0 0}",
				".pharos-settings .pharos-card{border:1px solid var(--dsw-alias-border-l2,#d8dee4);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
				".pharos-settings .pharos-card-head{display:flex;align-items:center;gap:10px}",
				".pharos-settings .pharos-card-head input[type=text]{flex:1}",
				".pharos-settings .pharos-events{display:flex;flex-wrap:wrap;gap:4px 12px}",
				".pharos-settings .pharos-events label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}",
				".pharos-settings button.pharos-btn,.pharos-settings button.pharos-btn-sm{background:var(--dsw-alias-button-primary-bg,var(--dsw-alias-state-business-primary,#0969da));color:#fff;border:0;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer}",
				".pharos-settings button.pharos-btn:hover,.pharos-settings button.pharos-btn-sm:hover{opacity:.9}",
				".pharos-settings button.pharos-btn[disabled],.pharos-settings button.pharos-btn-sm[disabled]{opacity:.5;cursor:default}",
				".pharos-settings button.pharos-btn-ghost,.pharos-settings button.pharos-btn-sm.pharos-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary,#24292f)}",
				".pharos-settings .pharos-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px}",
				".pharos-settings .pharos-status.ok{background:rgba(46,160,67,.15);color:var(--dsw-alias-state-success,#1a7f37)}",
				".pharos-settings .pharos-status.offline{background:rgba(248,81,73,.15);color:var(--dsw-alias-state-danger,#cf222e)}",
				".pharos-settings .pharos-status.loading{background:rgba(9,105,218,.12);color:var(--dsw-alias-state-business-primary,#0969da)}",
				".pharos-settings .pharos-banner{border:1px solid rgba(248,81,73,.4);background:rgba(248,81,73,.08);color:var(--dsw-alias-state-danger,#cf222e);border-radius:8px;padding:8px 12px;font-size:13px}",
				".pharos-settings .pharos-notice{font-size:13px;min-height:20px}",
				".pharos-settings .pharos-notice.ok{color:var(--dsw-alias-state-success,#1a7f37)}",
				".pharos-settings .pharos-notice.err{color:var(--dsw-alias-state-danger,#cf222e)}",
				".pharos-settings textarea.pharos-template{width:100%;min-height:56px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:vertical}",
				".pharos-settings pre.pharos-debug{background:var(--dsw-alias-field-bg,#f6f8fa);border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;padding:8px;font-size:11px;line-height:16px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0}",
				".pharos-settings .pharos-tests{display:flex;flex-wrap:wrap;gap:8px}",
				// v0.6.2 模板预设单选：三档横排 + 仅「自定义」才展开编辑区
				".pharos-settings .pharos-template-block{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:0}",
				".pharos-settings .pharos-radio-row{display:flex;gap:10px;flex:0 0 auto;align-items:center}",
				".pharos-settings .pharos-radio{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}",
				".pharos-settings .pharos-radio input{margin:0}",
".pharos-settings .pharos-tests button.pharos-btn-sm{background:transparent;color:var(--dsw-alias-label-primary,#24292f);border:1px solid var(--dsw-alias-border-l2,#d8dee4)}",
				".pharos-settings .pharos-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
				// 深色模式：--dsw-alias-* 缺省时表单控件不再回退白底（原回退 #fff/#24292f 导致
				// 深色下 select 白底、option 弹层无法辨识）；沿用变量名、换深色回退值。
				"@media (prefers-color-scheme:dark){.pharos-settings .pharos-field input[type=text],.pharos-settings .pharos-field input[type=number],.pharos-settings .pharos-field input[type=time],.pharos-settings .pharos-field input[type=password],.pharos-settings .pharos-field select,.pharos-settings .pharos-field textarea{background:var(--dsw-alias-field-bg,#1e2530);color:var(--dsw-alias-label-primary,#e3e8ef);border-color:var(--dsw-alias-border-l1,#38404e)}.pharos-settings .pharos-field select option{background:var(--dsw-alias-field-bg,#1e2530);color:var(--dsw-alias-label-primary,#e3e8ef)}.pharos-settings pre.pharos-debug{background:var(--dsw-alias-field-bg,#171c26);border-color:var(--dsw-alias-border-l1,#333c4a);color:var(--dsw-alias-label-secondary,#cdd3db)}}"
			].join("");
			doc.head.appendChild(tag);
		} catch (e) { /* 样式失败不阻塞表单 */ }
	}

	// ---- 视图组件（React 函数组件；renderSlot 渲染，hooks 可用）----
	function PharosSettingsView() {
		var React = getReact();
		var useState = React.useState;
		var useEffect = React.useEffect;

		var initial = readLocalConfig() || defaultConfig();
		var [cfg, setCfg] = useState(initial);
		var [webhooks, setWebhooks] = useState([]);
		var [hostState, setHostState] = useState("loading"); // loading | ok | offline
		var [notice, setNotice] = useState({ text: "", kind: "" });
		var [saving, setSaving] = useState(false);
		var [debugLines, setDebugLines] = useState([]);
		var [tokenMode, setTokenMode] = useState("keep"); // keep | set | clear
		var [tokenDraft, setTokenDraft] = useState("");
		// v0.6.2：显式点过「自定义」的 webhook 行 key 集合。
		// 为什么需要它：templatePresetOf 按**内容全等**判档，而「切到自定义」那一刻
		// row.template 内容仍等于某个预设 → 立刻被判回该预设 → 界面弹回简洁/详细，
		// 用户永远进不去自定义（真机 bug）。这里只记 UI 意图、不落盘；
		// 一旦用户真改了模板，内容不再是预设，判定自然接管。
		var [customRows, setCustomRows] = useState({});
		// v0.6.2：自定义模板草稿（行 key → 最后一次编辑的内容），仅存内存。
		// 为什么需要：切到「简洁/详细」会把 template 覆写成预设原文，若不留草稿，
		// 用户切去预设看一眼再切回来，自己写的模板就没了（与「配置丢失」同类体验问题）。
		var [customDraft, setCustomDraft] = useState({});
		var [stats, setStats] = useState(null); // M2：最近一轮当轮统计（{durationMs,tokens,cacheHitRate,tps,...}）

		function debugLog(line) {
			// ⚠️ 必须用**本地**时间：toISOString() 给的是 UTC，会比本地时间差一个时区
			// （东八区就差 8 小时）——用户看到 08:45 而实际是 16:45，误以为日志有问题。
			var now = new Date();
			var ts = String(now.getHours()).padStart(2, "0") + ":" +
				String(now.getMinutes()).padStart(2, "0") + ":" +
				String(now.getSeconds()).padStart(2, "0");
			setDebugLines(function (prev) {
				var next = prev.concat("[" + ts + "] " + line);
				return next.length > DEBUG_CAP ? next.slice(next.length - DEBUG_CAP) : next;
			});
		}
		function traceError(where, err) {
			var msg = err && err.message ? err.message : String(err);
			if (err && err.detail && typeof err.detail === "object") msg += " " + JSON.stringify(err.detail);
			debugLog(where + " 失败 → " + msg);
		}

		// ---- 初载：GET /config（host 权威）→ 失败回退 localStorage 偏好层 ----
		useEffect(function () {
			var alive = true;
			debugLog("载入 /pharos/api/config …");
			jsonFetch(CONFIG_URL)
				.then(function (server) {
					if (!alive) return;
					var merged = mergeConfig(null, server);
					setCfg(merged);
					setWebhooks(draftRows(merged.webhooks));
					setHostState("ok");
					debugLog("host 在线：config 载入（apiToken=" + (merged.apiToken ? MASK : "(空)") + "）");
					// 旧预设原文需回写一次：draftRows 只在内存里升级，而**实际推送用的是
					// host 落盘的那份**，不回写则仍按旧格式推送（用户会以为没修好）。
					if (hasLegacyTemplate(merged.webhooks)) {
						debugLog("检测到旧预设模板 → 自动升级并回写");
						scheduleSave();
					}
					// 刷新 webhook 独立端点（失败不影响表单）
					return globalScope && globalScope.fetch
						? jsonFetch(WEBHOOKS_URL).then(function (list) {
							if (!alive) return;
							setWebhooks(draftRows(list));
						}, function () { /* 独立端点可选 */ })
						: undefined;
				}, function (err) {
					if (!alive) return;
					traceError("GET " + CONFIG_URL, err);
					var local = readLocalConfig();
					setCfg(local || defaultConfig());
					setWebhooks([]);
					setHostState("offline");
					setNotice({ text: "主机半未激活：/pharos/api 不可达，改动仅保存在本地（localStorage 偏好层）；webhook 与 Token 需 host 在线生效。", kind: "err" });
					debugLog("host 离线 → 回退 localStorage 配置");
				})
				.catch(function () { /* 各分支已自行消费失败 */ });
			return function () { alive = false; };
		}, []);

		// ---- M2：当轮统计订阅（stats() 初读 + pharos:stats 事件 + localStorage 兜底）----
		useEffect(function () {
			function applyStats(next) {
				if (next && typeof next === "object") setStats(next);
			}
			// 初读：configApi.stats() 或 localStorage 兜底
			try {
				var api = globalScope && globalScope.__dshPharos;
				if (api && typeof api.stats === "function") applyStats(api.stats());
			} catch { /* ignore */ }
			var onStats = function (ev) { if (ev && ev.detail) applyStats(ev.detail); };
			try {
				if (globalScope && globalScope.document && globalScope.document.addEventListener) {
					globalScope.document.addEventListener("pharos:stats", onStats);
				}
			} catch { /* ignore */ }
			return function () {
				try {
					if (globalScope && globalScope.document && globalScope.document.removeEventListener) {
						globalScope.document.removeEventListener("pharos:stats", onStats);
					}
				} catch { /* ignore */ }
			};
		}, []);

		function patchConfig(patch) {
			setCfg(function (prev) { return mergeConfig(prev, patch); });
			scheduleSave();
		}

		function updateRow(key, partial) {
			setWebhooks(function (rows) {
				return rows.map(function (r) {
					if (r._key !== key) return r;
					var next = Object.assign({}, r, partial);
					if (Object.prototype.hasOwnProperty.call(partial, "secret")) next._secretDirty = true;
					return next;
				});
			});
			scheduleSave();
		}
		function removeRow(key) {
			setWebhooks(function (rows) {
				var next = rows.filter(function (r) { return r._key !== key; });
				debugLog("删除 webhook 行");
				return next;
			});
			scheduleSave();
		}
		function addRow() {
			setWebhooks(function (rows) {
				debugLog("新增 webhook 行");
				return rows.concat([{
					_key: uid(), name: "", channel: "generic", url: "",
					secret: "", _secretDirty: true, events: [], enabled: true,
					template: DEFAULT_TEMPLATE
				}]);
			});
			scheduleSave();
		}

		// ---- 令牌取值（v0.6.2 修隐患）----
		// 旧实现 `mode === "set" → return tokenDraft`：选中「设为新值」但还没输入时
		// draft 为空 → 载荷 apiToken="" → 把已存的 token **静默清空**。
		// 字段提示一直写的是「留空 = 保持原值」，此处对齐该语义。
		function tokenValueOf(cfgV, mode, draft) {
			if (mode === "clear") return "";
			if (mode === "set") return draft !== "" ? draft : (cfgV.apiToken || "");
			return cfgV.apiToken || "";
		}
		function tokenPayload() {
			return tokenValueOf(cfg, tokenMode, tokenDraft);
		}
		/** 一次保存的完整载荷（cfg + 令牌 + webhook 行）。纯函数，便于自动保存复用。 */
		function payloadOf(cfgV, rows, mode, draft) {
			return mergeConfig(cfgV, {
				apiToken: tokenValueOf(cfgV, mode, draft),
				webhooks: webhooksPayload(rows)
			});
		}

		// ---- v0.6.2：自动保存（底部「保存设置」按钮已移除）----
		// 改动的唯一出口是 scheduleSave()：用户每改一处就重置 800ms 计时器，
		// 停止操作后落盘一次。
		//
		// ⚠️ 为什么不用「监听 cfg/webhooks 变化就保存」：保存成功后服务端会回填
		//    setCfg/setWebhooks，那本身就是一次状态变化 → 又会触发保存 → **无限循环**。
		//    改为显式 dirty 标记后，只有**用户动作**才置脏；回填不置脏，循环从根上不存在。
		//
		// ⚠️ saveBox.latest 是「最新状态快照」：计时器回调在 800ms 后才跑，
		//    若闭包捕获旧 cfg 会写回过期数据（用户刚点的勾又被取消）。故每次渲染刷新它。
		var [saveBox] = useState(function () {
			return { timer: null, dirty: false, unmounted: false, latest: null };
		});
		saveBox.latest = { cfg: cfg, webhooks: webhooks, tokenMode: tokenMode, tokenDraft: tokenDraft, hostState: hostState };

		function scheduleSave() {
			saveBox.dirty = true;
			if (saveBox.timer) clearTimeout(saveBox.timer);
			saveBox.timer = setTimeout(function () {
				saveBox.timer = null;
				if (!saveBox.dirty || saveBox.unmounted) return;
				saveBox.dirty = false;
				persist("auto");
			}, AUTO_SAVE_MS);
		}

		/** 落盘：host 在线走 PUT，否则只写本地偏好层。 */
		function persist(trigger) {
			var L = saveBox.latest;
			if (!L) return;
			// 初载未完成时表单还没渲染，不存在用户改动；防御性跳过，避免把空初始态写出去
			if (L.hostState === "loading") { saveBox.dirty = true; return; }
			var payload = payloadOf(L.cfg, L.webhooks, L.tokenMode, L.tokenDraft);
			setSaving(true);
			function saveLocal(why) {
				var ok = writeLocalConfig(payload);
				debugLog((ok ? "已写入 localStorage" : "localStorage 写入失败") + "（" + why + "）");
				if (saveBox.unmounted) return;
				setSaving(false);
				setNotice({
					text: ok
						? "已保存到本地偏好层（webhook / Token 需 host 在线才生效）"
						: "本地保存失败",
					kind: ok ? "ok" : "err"
				});
			}
			if (L.hostState !== "ok") { saveLocal("host 离线分支"); return; }
			debugLog("PUT " + CONFIG_URL + " …");
			jsonFetch(CONFIG_URL, { method: "PUT", body: JSON.stringify(payload) })
				.then(function (resp) {
					if (saveBox.unmounted) return;
					var merged = mergeConfig(L.cfg, resp);
					setCfg(merged);
					setWebhooks(draftRows(merged.webhooks));
					writeLocalConfig(merged);
					setTokenMode("keep");
					setTokenDraft("");
					setSaving(false);
					setNotice({ text: "已自动保存 ✓", kind: "ok" });
					debugLog("PUT ok → 配置已落盘（触发：" + trigger + "）");
					// 刷新独立 webhooks 端点（best-effort，失败不影响表单）
					if (globalScope && globalScope.fetch) {
						jsonFetch(WEBHOOKS_URL).then(function (list) {
							if (!saveBox.unmounted) setWebhooks(draftRows(list));
						}, function () { /* 可选 */ });
					}
				}, function (err) {
					if (saveBox.unmounted) return;
					traceError("PUT " + CONFIG_URL, err);
					// host 或许中途掉线：退化为仅本地
					saveLocal("PUT 失败退化");
				})
				.catch(function () { if (!saveBox.unmounted) setSaving(false); });
		}

		// 卸载时清掉待落盘计时器，避免对已卸载组件 setState
		useEffect(function () {
			return function () {
				saveBox.unmounted = true;
				if (saveBox.timer) clearTimeout(saveBox.timer);
			};
		}, []);

		function onReset() {
			var defaults = defaultConfig();
			setCfg(defaults);
			setWebhooks([]);
			setTokenMode("keep");
			setTokenDraft("");
			debugLog("已重置为默认配置（将自动保存）");
			scheduleSave();
		}

		// ---- 测试按钮 ----
		function onTest(kind) {
			var api = currentConfigApi();
			debugLog("test(" + kind + ") …");
			if (api && typeof api.test === "function") {
				try {
					var ret = api.test(kind);
					if (ret && typeof ret.then === "function") {
						debugLog("configApi.test(" + kind + ") 已调用（等返回）");
						ret.then(function () {}, function (e) { traceError("configApi.test(" + kind + ")", e); });
					} else {
						// v0.6.1：test() 走 bypass（强制页内 toast + 无视静默策略），
						// 并回显实际触发的 kind —— 这行是「点到底有没有生效」的直接证据。
						debugLog("configApi.test(" + kind + ") 已触发" + (ret ? "，实际 kind=" + ret : "") + " → 看页面右下角页内提示（不走系统通知）");
					}
				} catch (e) { traceError("configApi.test(" + kind + ")", e); }
				return;
			}
			if (kind === "remote") {
				debugLog("configApi.test 不可用 → POST " + TRIGGER_URL);
				jsonFetch(TRIGGER_URL, {
					method: "POST",
					body: JSON.stringify({ title: "Pharos 测试", body: "来自设置页的远程测试", sessionId: "settings" })
				}).then(function () { debugLog("remote 测试已推送"); }, function (err) { traceError("POST " + TRIGGER_URL, err); });
				return;
			}
			debugLog("configApi.test 不可用，kind=" + kind + " 无法触发（浏览器半未挂载？尝试刷新 DSH 页面）");
		}
		function onDebugRefresh() {
			var api = currentConfigApi();
			try {
				if (api && typeof api.debug === "function") {
					debugLog("configApi.debug() → " + JSON.stringify(api.debug()));
				} else {
					debugLog("configApi.debug 不可用，仅输出表单状态");
				}
			} catch (e) { traceError("configApi.debug()", e); }
			debugLog("hostState=" + hostState + " cfg.webhooks=" + webhooks.length);
		}

		// ---- 渲染 ----
		if (hostState === "loading") {
			return React.createElement("div", { className: "pharos-settings" },
				React.createElement("h2", { className: "pharos-title" }, SLOT_LABEL),
				React.createElement("p", { className: "pharos-hint" }, "正在载入 Pharos 配置…"));
		}

		function h(tag, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			// 无 children 时必须**完全不传**第三参：传空数组也会被 React 当成
			//「有 children」，void 元素（input/img/br…）立刻抛 #137
			// 「input is a void element tag and must neither have children」。
			// 现有 checkbox/textField 都走 React.createElement 显式传参，只有无子节点的
			// input 走 h()，所以此前一直没暴露。
			if (children.length === 0) return React.createElement(tag, props || null);
			return React.createElement(tag, props || null, children.length === 1 ? children[0] : children);
		}
		function checkbox(labelText, checked, onChange, extra) {
			return h("label", extra || null,
				React.createElement("input", {
					type: "checkbox",
					checked: !!checked,
					onChange: function (e) { onChange(e.target.checked); }
				}),
				labelText);
		}
		function textField(labelText, value, onChange, placeholder) {
			return h("label", { className: "pharos-field" },
				React.createElement("span", null, labelText),
				React.createElement("input", {
					type: "text", value: value || "",
					onChange: function (e) { onChange(e.target.value); },
					placeholder: placeholder || ""
				}));
		}

		var statusLabel = hostState === "ok" ? "host 在线" : (hostState === "offline" ? "主机半未激活" : "连接中…");
		var statusClass = hostState === "ok" ? "ok" : (hostState === "offline" ? "offline" : "loading");

		// M2：当轮统计卡片（有 stats 才渲染；各字段按需显示）
		function fmtDuration(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return null;
			var s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60), r = s % 60;
			if (m < 60) return r > 0 ? m + "m " + r + "s" : m + "m";
			var hr = Math.floor(m / 60), mr = m % 60;
			return mr > 0 ? hr + "h " + mr + "m" : hr + "h";
		}
		function statsRows() {
			if (!stats || typeof stats !== "object") return [];
			var rows = [];
			if (typeof stats.sessionTitle === "string" && stats.sessionTitle !== "") rows.push(["会话", stats.sessionTitle]);
			if (typeof stats.durationMs === "number" && stats.durationMs >= 0) rows.push(["耗时", fmtDuration(stats.durationMs)]);
			if (typeof stats.tokens === "number" && stats.tokens > 0) rows.push(["tokens", String(stats.tokens)]);
			if (typeof stats.cacheHitRate === "number" && isFinite(stats.cacheHitRate)) rows.push(["缓存命中", Math.round(stats.cacheHitRate * 100) + "%"]);
			if (typeof stats.tps === "number" && isFinite(stats.tps) && stats.tps > 0) rows.push(["TPS", stats.tps.toFixed(1) + " tok/s"]);
			return rows;
		}
		var statRows = statsRows();

		return React.createElement("div", { className: "pharos-settings" },
			// 页面标题：顶级分区的壳不画标题（标签页形态下由分区壳 <h2> + 标签提供），
			// 故自绘；文案复用 SLOT_LABEL，避免导航项与本页标题漂移。
			// 标题行：对标 dshmarket / dsh-better-sidebar 的写法 —— 标题 + 包名 + 版本徽章。
			// 徽章的视觉（描边胶囊 / tertiary 文字 / 11px）照插件详情页卡片里的版本标签。
			h("div", { className: "pharos-titleRow" },
				h("h2", { className: "pharos-title" }, SLOT_LABEL),
				h("span", { className: "pharos-pkg" }, PKG_NAME),
				h("span", { className: "pharos-ver" }, "v" + PKG_VERSION)),

			// 顶部状态 + 横幅
			h("div", { className: "pharos-row" },
				h("span", { className: "pharos-status " + statusClass }, statusLabel),
				h("span", { className: "pharos-hint" }, "配置经 /pharos/api 同源接口持久化；改动自动保存，host 离线时回退本地偏好层。"),
				h("button", { className: "pharos-btn-sm pharos-btn-ghost", onClick: onReset }, "恢复默认")
			),
			hostState === "offline" ? h("div", { className: "pharos-banner" },
				"主机半未激活：无法访问 /pharos/api。以下改动仅保存在本机（localStorage 偏好层），webhook 与 apiToken 需 host 在线后才能持久化。")
				: null,

			// ⓪ M2：当轮统计卡片（有 stats 才渲染）
			statRows.length > 0 ? h("div", { className: "pharos-card", "data-pharos-stats": "" },
				h("b", { className: "pharos-h" }, "当轮统计"),
				statRows.map(function (row) {
					return h("div", { key: row[0], className: "pharos-field" },
						h("span", null, row[0] + " "),
						h("span", { className: "pharos-hint" }, row[1]));
				}),
				h("p", { className: "pharos-hint" }, "来自 host 半官方投影（当轮 delta 口径）；未完成一轮或无统计时隐藏。"))
				: null,

			// ① 主开关 + 通知/音效/音量/自动聚焦/语言
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "基本设置"),
				h("div", { className: "pharos-field" }, checkbox("启用 Pharos 提醒", cfg.enabled, function (v) { patchConfig({ enabled: v }); })),
				h("div", { className: "pharos-field" }, checkbox("系统通知 (toast)", cfg.toast, function (v) { patchConfig({ toast: v }); })),
				h("div", { className: "pharos-field" }, checkbox("提示音 (chime)", cfg.sound, function (v) { patchConfig({ sound: v }); })),
				h("div", { className: "pharos-field" },
					h("span", null, "音量 "),
					React.createElement("input", {
						type: "range", min: "0", max: "1", step: "0.05",
						value: String(cfg.volume || 0),
						onChange: function (e) { patchConfig({ volume: clampVolume(e.target.value) }); },
						disabled: !cfg.sound
					}),
					h("span", null, Math.round((cfg.volume || 0) * 100) + "%")),
				h("div", { className: "pharos-field" }, checkbox("点击通知自动聚焦 DSH", cfg.autoFocus, function (v) { patchConfig({ autoFocus: v }); })),
				h("div", { className: "pharos-field" },
					h("span", null, "语言 "),
					React.createElement("select", {
						value: cfg.language || "auto",
						onChange: function (e) { patchConfig({ language: e.target.value }); }
					},
						React.createElement("option", { value: "auto" }, "跟随系统 (auto)"),
						React.createElement("option", { value: "zh" }, "中文"),
						React.createElement("option", { value: "en" }, "English"))
				)
			),

			// ② 提醒时机
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "提醒时机"),
				h("div", { className: "pharos-field" }, checkbox("「需要你」仅页面隐藏时提醒", cfg.attentionHiddenOnly, function (v) { patchConfig({ attentionHiddenOnly: v }); })),
				h("div", { className: "pharos-field" },
				h("span", null, "「完成」提醒时机 "),
				h("select", {
						value: (function () {
							// 兼容旧配置：只有 doneHiddenOnly 时映射到三档
							var m = cfg.doneNotifyMode;
							if (m === "off" || m === "hidden" || m === "always") return m;
							return cfg.doneHiddenOnly === false ? "always" : "hidden";
						})(),
						onChange: function (e) {
							var v = e.target.value;
							// 同时写 doneHiddenOnly，保持旧版本/旧主机侧兼容读
							patchConfig({ doneNotifyMode: v, doneHiddenOnly: v !== "always" });
						}
					},
					h("option", { value: "off" }, "关闭"),
					h("option", { value: "hidden" }, "仅页面隐藏时提醒（默认）"),
					h("option", { value: "always" }, "始终提醒")),
				h("span", { className: "pharos-hint" }, "默认「仅页面隐藏时」与 VS Code / Codex / ChatGPT 一致：你在盯着这个页面时不必再被打断，切走或最小化才提醒。")),
				h("div", { className: "pharos-field" }, checkbox("当前会话 + 页面前台时静默「需要你」（只留标题标记）", cfg.currentQuiet, function (v) { patchConfig({ currentQuiet: v }); })),
				h("div", { className: "pharos-field" },
					h("span", null, "完成节流 minIntervalMs "),
					React.createElement("input", {
						type: "number", min: "0", step: "500", value: String(cfg.minIntervalMs),
						onChange: function (e) { patchConfig({ minIntervalMs: clampMs(e.target.value) }); }
					})),
				h("div", { className: "pharos-field" },
					h("span", null, "二次提醒 reAlertMs "),
					React.createElement("input", {
						type: "number", min: "0", step: "10000", value: String(cfg.reAlertMs),
						onChange: function (e) { patchConfig({ reAlertMs: clampMs(e.target.value) }); }
					})),
				h("p", { className: "pharos-hint" }, "minIntervalMs：同一会话「完成」类提醒的最小间隔（默认 6s）。reAlertMs：未处理的「需要你」补发一次（默认 10min）。")
			),

			// ③ quiet hours（跨午夜）
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "免打扰时段 (quiet hours)"),
				h("div", { className: "pharos-field" }, checkbox("启用", cfg.quietHours.enabled, function (v) { patchConfig({ quietHours: Object.assign({}, cfg.quietHours, { enabled: v }) }); })),
				h("div", { className: "pharos-field" },
					h("span", null, "开始 "),
					React.createElement("input", {
						type: "time", value: cfg.quietHours.start || "23:00", disabled: !cfg.quietHours.enabled,
						onChange: function (e) { patchConfig({ quietHours: Object.assign({}, cfg.quietHours, { start: e.target.value }) }); }
					}),
					h("span", null, "结束 "),
					React.createElement("input", {
						type: "time", value: cfg.quietHours.end || "08:00", disabled: !cfg.quietHours.enabled,
						onChange: function (e) { patchConfig({ quietHours: Object.assign({}, cfg.quietHours, { end: e.target.value }) }); }
					})),
				h("p", { className: "pharos-hint" }, "区间 [开始, 结束)。支持跨午夜：如 23:00 → 08:00 表示夜间静默。生效期静默屏幕渠道与 webhook 推送。")
			),

			// ④ 过滤
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "过滤"),
				h("div", { className: "pharos-field" }, checkbox("跳过子代理事件 (skipSubagents)", cfg.skipSubagents, function (v) { patchConfig({ skipSubagents: v }); })),
				h("div", { className: "pharos-field" }, checkbox("后台任务事件提醒 (jobEvents)", cfg.jobEvents, function (v) { patchConfig({ jobEvents: v }); })),
				// M2.5 workflow：默认关。订阅在启动时建立 → 开启需重启 DSH，关闭即时生效。
				h("div", { className: "pharos-field" }, checkbox("工作流提醒 (workflowEvents)", cfg.workflowEvents, function (v) { patchConfig({ workflowEvents: v }); })),
				h("div", { className: "pharos-field" }, checkbox("工作流日志 (workflowLog，高频·仅调试)", cfg.workflowLog, function (v) { patchConfig({ workflowLog: v }); })),
				h("p", { className: "pharos-hint" }, "两个开关互相独立：开启需重启 DSH 生效，关闭即时生效。「工作流日志」只进调试队列（不弹通知），可单独开启。仅多 agent 工作流任务会产生此类事件，普通对话不触发。详见 docs/sop-workflow-events.md。")
			),

			// ⑤ Webhook 列表（增删改）
			h("div", { className: "pharos-card" },
				h("div", { className: "pharos-row" },
					h("b", { className: "pharos-h" }, "Webhook 推送 (" + webhooks.length + ")"),
					h("button", { className: "pharos-btn-sm", onClick: addRow }, "+ 添加"),
					h("button", {
						className: "pharos-btn-sm pharos-btn-ghost",
						onClick: function () {
							setWebhooks(function (rows) { return rows.map(function (r) { return Object.assign({}, r, { enabled: true }); }); });
							debugLog("全部启用 webhook 行");
							scheduleSave();
						}
					}, "全部启用")
				),
				webhooks.length === 0 ?
					h("p", { className: "pharos-hint" }, "未配置 webhook。添加后事件将同时推送到该渠道（自动保存）。")
					: null,
				h("div", { className: "pharos-settings" },
					webhooks.map(function (row) {
						return h("div", { key: row._key, className: "pharos-card", "data-pharos-webhook": row._key },
							h("div", { className: "pharos-card-head" },
								React.createElement("input", {
									type: "text", placeholder: "名称，如 团队群", value: row.name || "",
									onChange: function (e) { updateRow(row._key, { name: e.target.value }); },
									"data-pharos-field": "name"
								}),
								React.createElement("select", {
									value: row.channel || "generic",
									onChange: function (e) { updateRow(row._key, { channel: e.target.value }); },
									"data-pharos-field": "channel"
								}, CHANNELS.map(function (c) {
									return React.createElement("option", { key: c.value, value: c.value }, c.label);
								})),
								checkbox("启用", row.enabled, function (v) { updateRow(row._key, { enabled: v }); }),
								h("button", { className: "pharos-btn-sm pharos-btn-ghost", onClick: function () { removeRow(row._key); } }, "删除")
							),
							textField("URL", row.url, function (v) { updateRow(row._key, { url: v }); }, "https://…"),
							h("div", { className: "pharos-field" },
								h("span", null, "Secret "),
								React.createElement("input", {
									type: "password",
									placeholder: row._secretDirty ? "" : MASK,
									value: row._secretDirty ? (row.secret || "") : "",
									onChange: function (e) { updateRow(row._key, { secret: e.target.value }); },
									"data-pharos-field": "secret"
								}),
								h("span", { className: "pharos-hint" },
									row._secretDirty ? "将替换原值" : (row.secret ? "已设置（" + MASK + "，输入新值以更换）" : "未设置"))),
							h("div", { className: "pharos-field pharos-events" },
								h("span", null, "事件 "),
								EVENTS.map(function (ev) {
									return h("label", { key: ev.value },
										React.createElement("input", {
											type: "checkbox",
											checked: row.events.indexOf(ev.value) !== -1,
											onChange: function (e) {
												var has = row.events.indexOf(ev.value) !== -1;
												var next = has
													? row.events.filter(function (x) { return x !== ev.value; })
													: row.events.concat(ev.value);
												updateRow(row._key, { events: next });
											}
										}),
										ev.label);
								})),
							h("p", { className: "pharos-hint" }, "事件留空 = 全部事件。可选：done / error / interrupted / limit / needs-you / job / remote / test / workflow。模板可用变量：{title}{note}{kind}{sessionId}{sessionTitle}{tokens}{duration}{cache}{tps}{time}(本地时间){isoTime}(UTC){ts}。{cache}/{tps}/{duration} 无值时留空。"),
						(function () {
							// v0.6.2：预设三档（简洁 / 详细 / 自定义）。自定义档才展开高级编辑区。
							// 用户显式点过「自定义」的行优先判 custom（见 customRows 注释），
							// 否则按内容全等判定；内容真被改过时 customRows 自动让位给内容判定。
							var preset = customRows[row._key] === "custom" ? "custom" : templatePresetOf(row.template);
							var PRESETS = [
								{ id: "concise", label: "简洁", hint: "标题 + 结论 + 统计摘要（推荐）" },
								{ id: "detail", label: "详细", hint: "耗时 / tokens / 缓存 / 速度逐项成行" },
								{ id: "custom", label: "自定义", hint: "自己写模板（下方高级模式）" }
							];
							// 标记切档：custom 只加标记；其余档同时写入预设原文并清标记。
							function markPreset(id) {
								setCustomRows(function (m) {
									var n = {};
									for (var k in m) n[k] = m[k];
									if (id === "custom") n[row._key] = "custom"; else delete n[row._key];
									return n;
								});
							}
							return h("div", { className: "pharos-template-block" },
								h("div", { className: "pharos-field", role: "radiogroup", "aria-label": "消息格式" },
									h("span", null, "格式 "),
									h("div", { className: "pharos-radio-row" }, PRESETS.map(function (p) {
										return h("label", {
											key: p.id,
											className: "pharos-radio",
											title: p.hint,
											"data-pharos-preset": p.id
										},
											React.createElement("input", {
												type: "radio",
												name: "pharos-tpl-" + row._key,
												checked: preset === p.id,
												onChange: function () {
													if (p.id === "custom") {
														// 切到自定义时的内容来源，优先级：
														//   ① 本次会话里用户写过的草稿（切去预设再切回来不丢稿）
														//   ② 当前内容（若用户尚未在本档写过、但内容已是自定义）
														//   ③ 专属起手式（内容为空或恰是某预设原文时）
														// 加 ③ 的原因：沿用预设原文会让「自定义」与刚离开的预设
														// 逐字相同 → 用户切完发现「详细和自定义没区别」（真机反馈）。
														var cur = String(row.template || "").trim();
														// 用归一化归类判断「这是不是某档预设原文」——比逐个比对常量
														// 更耐改：换行写法/引用前缀变了的老预设也能识别出来。
														var isPresetText = cur === "" || presetKindOf(cur) !== "custom";
														var draft = customDraft[row._key];
														var next = (typeof draft === "string" && draft !== "")
															? draft
															: (isPresetText ? TEMPLATE_PRESET_CUSTOM_SEED : row.template);
														updateRow(row._key, { template: next });
														markPreset("custom");
														debugLog("切换到自定义模板" + (next === TEMPLATE_PRESET_CUSTOM_SEED ? "（已填入起手式）" : "（恢复已有内容）"));
													} else {
														updateRow(row._key, { template: templateOfPreset(p.id) });
														markPreset(p.id);
														debugLog("模板预设 → " + p.id);
													}
												}
											}),
											h("span", null, p.label));
									})),
								h("span", { className: "pharos-hint" }, PRESETS.filter(function (p) { return p.id === preset; })[0].hint)),
								preset === "custom" ? h("div", { className: "pharos-field" },
									h("span", null, "模板 "),
									h("textarea", {
										className: "pharos-template",
										value: row.template || "",
										onChange: function (e) {
											updateRow(row._key, { template: e.target.value });
											// 记草稿：切去预设再切回自定义时用它还原（见 customDraft 注释）
											(function (key, val) {
												setCustomDraft(function (m) {
													if (m[key] === val) return m;   // 值没变就不建新对象，避免多余渲染
													var n = {};
													for (var k in m) n[k] = m[k];
													n[key] = val;
													return n;
												});
											})(row._key, e.target.value);
										},
										placeholder: TEMPLATE_PRESET_CUSTOM_SEED,
										"data-pharos-field": "template"
									})) : null,
								preset === "custom" ? h("p", { className: "pharos-hint" },
									"可用变量：{title}{note}{kind}{kindLabel}{summary}{duration}{tokens}{cache}{tps}{sessionId}{sessionTitle}{time}(本地){isoTime}(UTC){ts}。{summary} 无统计时为空；{note} 会按你排过的内容自动去掉重复部分。") : null);
						})()
						)
					})
				)
			),

			// ⑥ 高级：apiToken
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "高级"),
				h("div", { className: "pharos-field" },
					h("span", null, "apiToken "),
					h("span", { className: "pharos-hint" },
						cfg.apiToken ? "已设置（" + MASK + "，仅显示掩码）" : "未设置"),
					h("select", {
						value: tokenMode,
						onChange: function (e) { setTokenMode(e.target.value); if (e.target.value === "set") setTokenDraft(""); scheduleSave(); },
						"data-pharos-field": "tokenMode"
					},
						React.createElement("option", { value: "keep" }, "保持不变"),
						React.createElement("option", { value: "set" }, "设置新 Token"),
						React.createElement("option", { value: "clear" }, "清除 Token"))
				),
				tokenMode === "set" ?
					h("div", { className: "pharos-field" },
						h("span", null, "新 Token "),
						React.createElement("input", {
							type: "password", value: tokenDraft || "",
							onChange: function (e) { setTokenDraft(e.target.value); scheduleSave(); },
							placeholder: "输入新值（自动保存；留空 = 保持原值）",
							"data-pharos-field": "tokenDraft"
						}))
					: null,
				tokenMode === "clear" ?
					h("p", { className: "pharos-hint" }, "自动保存后将清除 apiToken，远程触发接口不再校验 x-pharos-token。")
					: null,
				h("p", { className: "pharos-hint" }, "apiToken 非空时，POST /pharos/api/trigger 须携带 x-pharos-token 请求头。")
			),

			// ⑦ 测试 + debug
			h("div", { className: "pharos-card" },
				h("b", { className: "pharos-h" }, "测试"),
				h("div", { className: "pharos-tests" },
					TEST_KINDS.map(function (k) {
						return h("button", {
							key: k.value, className: "pharos-btn-sm",
							onClick: function () { onTest(k.value); },
							"data-pharos-test": k.value
						}, k.label);
					})
				),
				h("p", { className: "pharos-hint" }, "测试按钮调用 configApi.test(kind)（浏览器半接线；remote 缺省时直接 POST /trigger）。主机半离线时 error/interrupted/limit/remote 无法产出真实事件，仅记入 debug。"),
				h("div", { className: "pharos-row" },
					h("b", { className: "pharos-h" }, "Debug"),
					h("button", { className: "pharos-btn-sm pharos-btn-ghost", onClick: onDebugRefresh }, "刷新"),
					h("button", { className: "pharos-btn-sm pharos-btn-ghost", onClick: function () { setDebugLines([]); } }, "清空")
				),
				statRows.length > 0 ? h("p", { className: "pharos-hint", "data-pharos-stats-debug": "" },
					"当轮统计：" + statRows.map(function (row) { return row[0] + " " + row[1]; }).join(" · "))
					: null,
				h("pre", { className: "pharos-debug", "data-pharos-debug": "" },
					debugLines.length ? debugLines.join("\n") : "（空）")
			),

			// 底部：自动保存状态（v0.6.2 移除了「保存设置」按钮 —— 它在最底下，
			// 改完没滚到底就切走会以为没生效；现在改动即存，这里只做状态回执）
			h("div", { className: "pharos-row", "data-pharos-autosave": "" },
				h("span", { className: "pharos-status " + (saving ? "loading" : (notice.kind === "err" ? "offline" : "ok")) },
					saving ? "保存中…" : "自动保存"),
				h("span", { className: "pharos-notice " + (notice.kind === "err" ? "err" : (notice.kind === "ok" ? "ok" : "")) },
					notice.text || "改动会在大约 1 秒后自动写入，无需手动保存。")
			)
		);
	}

	// ---- configApi 访问（mount 时注入，供测试按钮 / debug 使用）----
	var currentConfigApi_ = null;
	function currentConfigApi() {
		if (currentConfigApi_) return currentConfigApi_;
		if (typeof globalScope !== "undefined" && globalScope.__dshPharos) return globalScope.__dshPharos;
		return null;
	}

	// ---- 设置导航图标（settings.section 没有 icon 字段）----
	//
	// 宿主设置外壳只给三个 id 配了专用导航字形（account / models / agent-presets /
	// plugins），其余一律 fallback 到设置齿轮（见 ui-settings-general 的 navIcon(id)），
	// 而 settings.section 只投影 id / order / label —— 没有图标位可传。故自己认领
	// 那一行：按标签文本找到它，藏起齿轮、插入同形状的灯塔标记。
	//
	// 与 dshmarket 的差异：它注一张 CSS 样式表、用 ::before + mask 画标记；这里直接
	// 换节点 —— currentColor 由外壳的 .navCell color 继承而来，插入的 svg 无需自带
	// 颜色，少一个 <style> 注入点。副作用：React 仍持有原齿轮的引用，重渲染时更新
	// 的是已脱离的节点，视觉不变；行被卸载重挂时 observer 会重新认领。
	//
	// 形状按宿主图标契约重画（第一版栽在这两条上）：16 网格 + fill:none +
	// stroke:currentColor + 1.3 描边 + round cap/join，与 ui-primitives 的 artwork
	// 同语言。第一版用 36 网格填色剪影：① 没设 fill，SVG 默认填黑，深色下几乎不可见；
	// ② 缩到 16px 后灯头/灯台/塔身糊成一条竖线，且填色与邻座轮廓图标不搭。
	// 灯头仍用实心：16px 下 1.3 描边圆的心孔会塌成亚像素、糊成一坨。
	var NAV_MARK_ATTR = "data-pharos-nav-icon";
	var NAV_MARK_SVG_ATTR = "data-pharos-mark";
	var NAV_ICON_SIZE = 16;              // 与外壳 navIcon({ size: 16 }) 一致
	var PHAROS_MARK_VIEWBOX = "0 0 16 16";
	var PHAROS_MARK_STROKE = 1.3;        // = 宿主的 ICON_MEDIUM_STROKE
	var PHAROS_MARK_STROKE_HEAVY = 1.5;  // 灯台横条略重，16px 下才压得住
	// 下面三个形状是 icon.svg 的副本（唯一真源在 icon.svg；smoke.mjs M1-I 段有断言锁一致）。
	var PHAROS_MARK_LAMP = { cx: 8, cy: 3.1, r: 1.75 };
	var PHAROS_MARK_BALCONY = "M4.8 6.4H11.2";
	var PHAROS_MARK_TOWER = "M6.4 6.4L5 14H11L9.6 6.4";

	function navLabelText(button) {
		var spans = button.querySelectorAll("span");
		for (var i = 0; i < spans.length; i++) {
			var text = (spans[i].textContent || "").trim();
			if (text) return text;
		}
		return "";
	}

	function buildNavMark() {
		var ns = "http://www.w3.org/2000/svg";
		var svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", PHAROS_MARK_VIEWBOX);
		svg.setAttribute("width", String(NAV_ICON_SIZE));
		svg.setAttribute("height", String(NAV_ICON_SIZE));
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", String(PHAROS_MARK_STROKE));
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("focusable", "false");
		svg.setAttribute(NAV_MARK_SVG_ATTR, "1");
		svg.style.flex = "none";          // 对齐外壳 .navIcon { flex: none }
		var lamp = document.createElementNS(ns, "circle");
		lamp.setAttribute("cx", String(PHAROS_MARK_LAMP.cx));
		lamp.setAttribute("cy", String(PHAROS_MARK_LAMP.cy));
		lamp.setAttribute("r", String(PHAROS_MARK_LAMP.r));
		lamp.setAttribute("fill", "currentColor");
		lamp.setAttribute("stroke", "none");
		svg.appendChild(lamp);
		var balcony = document.createElementNS(ns, "path");
		balcony.setAttribute("d", PHAROS_MARK_BALCONY);
		balcony.setAttribute("stroke-width", String(PHAROS_MARK_STROKE_HEAVY));
		svg.appendChild(balcony);
		var tower = document.createElementNS(ns, "path");
		tower.setAttribute("d", PHAROS_MARK_TOWER);
		svg.appendChild(tower);
		return svg;
	}

	/** 认领导航里属于本插件的行；返回本次新认领的行数。 */
	function claimNavRow() {
		if (typeof document === "undefined" || !document.querySelectorAll) return 0;
		var navs = document.querySelectorAll('[role="dialog"] nav');
		var claimed = 0;
		for (var i = 0; i < navs.length; i++) {
			var buttons = navs[i].querySelectorAll("button");
			for (var j = 0; j < buttons.length; j++) {
				var button = buttons[j];
				if (button.getAttribute(NAV_MARK_ATTR)) continue;   // 已认领
				if (navLabelText(button) !== SLOT_LABEL) continue;   // 别人的行，不碰
				var gear = button.querySelector("svg");
				if (!gear || !gear.parentNode) continue;             // 结构不符，宁可不换
				try {
					gear.parentNode.insertBefore(buildNavMark(), gear);
					gear.style.display = "none";
					button.setAttribute(NAV_MARK_ATTR, "1");
					claimed++;
				} catch (e) { /* 标记失败只影响外观，不影响设置页可用性 */ }
			}
		}
		return claimed;
	}

	/**
	 * 认领设置导航中属于本插件的那一行。
	 * @returns {Function} 清理函数：摘掉标记、恢复齿轮。
	 */
	function installSettingsNavIcon() {
		if (typeof document === "undefined" || typeof MutationObserver !== "function") {
			return function () { return undefined; };
		}
		claimNavRow();
		// 设置对话框按需挂载，初次认领多半扑空，之后靠 observer 补。只订阅 childList
		// （不订阅 characterData）：SLOT_LABEL 是常量，标签文字不会变。
		var observer = new MutationObserver(function () {
			if (!document.querySelector('[role="dialog"] nav')) return;  // 对话框没开，不扫
			claimNavRow();
		});
		observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
		return function cleanup() {
			observer.disconnect();
			var rows = document.querySelectorAll("[" + NAV_MARK_ATTR + "]");
			for (var i = 0; i < rows.length; i++) {
				var svgs = rows[i].querySelectorAll("svg");
				for (var k = 0; k < svgs.length; k++) {
					if (svgs[k].getAttribute(NAV_MARK_SVG_ATTR)) {
						if (svgs[k].parentNode) svgs[k].parentNode.removeChild(svgs[k]);
					} else {
						svgs[k].style.display = "";   // 恢复齿轮
					}
				}
				rows[i].removeAttribute(NAV_MARK_ATTR);
			}
		};
	}

	/**
	 * 挂载「设置 → 消息通知」顶级设置分区（槽位 settings.section）。
	 *
	 * @param {object} ctx - 浏览器半插件上下文（cordis）。
	 * @param {object} [options] - 可选。
	 * @param {object} [options.configApi] - 浏览器半全局 API
	 *   ({ config, setConfig, resetConfig, test(kind), debug })；缺省取
	 *   window.__dshPharos。
	 * @returns {Function} 清理函数：卸载槽位注册与 inject effect。
	 *
	 * 幂等性：slots.inject 按槽位声明期只执行一次注册（runner 文档语义），
	 * 重复调用 mountSettingsSection 会各自持有 disposer，清理互不干扰。
	 */
	function mountSettingsSection(ctx, options) {
		options = options || {};
		if (options.configApi) currentConfigApi_ = options.configApi;
		ensureStyle();
		var disposers = [];

		var slots = null;
		try {
			slots = (ctx && typeof ctx.get === "function" ? ctx.get("slots", false) : undefined);
			if (!slots && ctx) slots = ctx.slots;
		} catch (e) { slots = undefined; }
		if (!slots || typeof slots.register !== "function") {
			if (typeof console !== "undefined" && console.warn) console.warn("[pharos-settings] slots 服务不可用，设置页跳过（通知核心不受影响）。");
			return function () { return undefined; };
		}
		disposers.push(installSettingsNavIcon());

		function registerView() {
			try {
				var off = slots.register({
					name: SLOT_NAME,
					id: SLOT_ID,
					order: SLOT_ORDER,
					label: SLOT_LABEL
				}, PharosSettingsView);
				if (typeof off === "function") disposers.push(off);
			} catch (e) {
				if (typeof console !== "undefined" && console.warn) console.warn("[pharos-settings] slots.register 失败：", e);
			}
		}

		if (typeof slots.inject === "function") {
			try {
				var offInject = slots.inject(SLOT_NAME, registerView);
				if (typeof offInject === "function") disposers.push(offInject);
			} catch (e) {
				// inject 不可用时退回直接注册（槽位已由 settings-plugins 声明）
				registerView();
			}
		} else {
			registerView();
		}

		return function cleanup() {
			for (var i = disposers.length - 1; i >= 0; i--) {
				try { disposers[i](); } catch (e) { /* 幂等 */ }
			}
			disposers.length = 0;
		};
	}

	// ---- 导出尾部（内联安全：仅追加属性，见文件头 ④）----
	// [settings-view:tail] pharos-client 内联进 client.js 时可整段移除本尾部；
	// 保留亦安全：只向 module.exports 追加 mountSettingsSection，client.js 末尾
	// 会整体重绑 module.exports，故不影响 {name, inject, apply}。
	var mod = typeof module === "object" && module !== null ? module : null;
	var exp = mod && mod.exports ? mod.exports : (typeof exports === "object" && exports !== null ? exports : null);
	if (exp && typeof exp === "object") {
		exp.mountSettingsSection = mountSettingsSection;
	}
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));