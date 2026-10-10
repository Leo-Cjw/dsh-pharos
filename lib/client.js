// dsh-pharos — browser half (v0.5.0 · M2 per-turn stats: cache-hit rate + TPS from official projections).
//
// 法罗斯灯塔 —— 你不在时替你守望 DSH：
//   1. "需要你操作" — approval / plan-review / question via uiSession
//      pending interactions -> toast + distinct chime + "🔔 需要你 ·" marker;
//      unanswered requests re-alert once after reAlertMs ("仍未处理").
//   2. "回复完成" — a session's run ends (running true->false, or
//      completionUnread) -> toast + chime + duration summary.
//   3. v0.4 (M1) 新增 — 消费 host 半的 PharosEvent 帧（SSE，同源
//      /pharos/api/stream）：done / error / interrupted / limit / job /
//      remote / test；error 用重低音与"出错"文案，interrupted/limit 用中音
//      警示；通知不可用时以页内 toast（#dsh-pharos-toast-box，上限 4 条）
//      兜底，外加 ⏳ 标题闪烁；quiet hours 跨午夜静默；skipSubagents 过滤
//      子代理帧；双源（uiSession + SSE）done 去重共享会话级节流；服务端
//      /pharos/api/config 优先、localStorage 回退；设置页挂在
//      settings.section（顶级「设置 → 消息通知」分区；视图来自
//      lib/settings-view.js，内联于本文件尾部的 region 块，规范源保持独立文件，
//      见 tools/sync-settings-view.mjs）。迁移依据见 settings-view.js 文件头 ②。
//
// Design notes (lessons from dsh-notify-me / dsh-turn-notify / dsh-my-notify /
// dsh-session-notify):
//   - cordis 上下文代理：未声明在插件 inject 里的服务，ctx.get 返回空、直接
//     属性读（ctx.sessions / ctx.uiSession / ctx.slots）会抛
//     "cannot get property X without inject"。插件必须把 apply 与设置页读取的
//     全部服务声明进 inject：["sessions", "uiSession", "slots"]。
//   - 服务按树序激活，uiSession 可能比本条目晚——apply 采用延迟接管 + 500ms
//     重试（照 dsh-notify-me），缺服务不炸、就绪即接管；apply 自身永不外抛
//     （cordis 会把失败条目上报为 web boot 失败，触发 fail-loud 恢复流程）。
//   - Error/interrupt/limit events live in the host turn stream; the browser
//     receives them as SSE frames (browser sessionStatus store alone cannot
//     derive them).
//   - Alert rendering stays hand-rolled (Notification / WebAudio / title);
//     zero dependency requires in this factory body — React is only needed by
//     the settings view and is resolved lazily when the tab renders.
window.__ModuleLoader__.load({
	id: "dsh-pharos",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const API_KEY = "__dshPharos";
		const CONFIG_KEY = "dshPharos.config";
		const MARKER = "🔔 需要你 · ";
		const BLINK_PREFIX = "⏳ ";
		const BLINK_TICKS = 12;        // 12 x 500ms = 6s
		const SSE_URL = "/pharos/api/stream";
		const CONFIG_URL = "/pharos/api/config";
		const SSE_DEDUPE_MS = 2000;    // per-frame dedupe window（host 另有一层 3000ms）
		const TOAST_MAX = 4;
		const TOAST_LIFETIME_MS = 6000;

		const DEFAULT_CONFIG = {
			enabled: true,          // master switch (kills toast, sound, marker)
			toast: true,            // system notification
			sound: true,            // WebAudio chime
			volume: 0.5,            // chime volume 0..1
			autoFocus: true,        // click on toast brings DSH to front
			attentionHiddenOnly: false, // "需要你": only when page hidden/background
			doneHiddenOnly: true, // 向后兼容（由 doneNotifyMode 取代）
			// v0.6.1：完成提醒三档 off | hidden(默认，同竞品) | always
			doneNotifyMode: "hidden",   // "回复完成": only when page hidden/background
			currentQuiet: true,     // "需要你" on the focused session: marker only
			minIntervalMs: 6000,    // per-session throttle for "完成"
			reAlertMs: 600000,      // unanswered "需要你" re-alert delay
			blinkFallback: true,    // ⏳ title blink when notifications unavailable
			language: "auto",       // 'auto' | 'zh' | 'en'
			quietHours: { enabled: false, start: "23:00", end: "08:00" },
			skipSubagents: true,    // drop host frames with agentType==='subagent'
			jobEvents: true,        // host may produce job frames (jobs service)
			hostNotify: false,      // reserved (host-native osascript) — M1.5
			apiToken: "",           // token echoed from server config (masked)
			webhooks: []            // mirrored list (server is authoritative)
		};

		const TEXT = {
			zh: {
				attentionTitle: "需要你操作",
				attentionBody: (sessionTitle, detail, reAlert) =>
					`会话「${sessionTitle}」需要你操作${detail ? `：${detail}` : ""}${reAlert ? "（仍未处理）" : ""}。`,
				doneTitle: "任务已完成",
				doneBody: (sessionTitle, summary) =>
					`会话「${sessionTitle}」已完成${summary ? ` · ${summary}` : ""}，点击回到 DSH 查看。`,
				errorTitle: "运行出错",
				errorBody: (sessionTitle, note) =>
					`会话「${sessionTitle}」运行出错${note ? `：${note}` : ""}，点击回去看看。`,
				interruptedTitle: "已被中断",
				interruptedBody: (sessionTitle, note) =>
					`会话「${sessionTitle}」被中断${note ? `：${note}` : ""}。`,
				limitTitle: "已达上限",
				limitBody: (sessionTitle, note) =>
					`会话「${sessionTitle}」已触达上限${note ? `：${note}` : ""}，可能需要调整参数或等待冷却。`,
				jobTitle: "后台任务",
				jobBody: (sessionTitle, note) =>
					`后台任务变更「${sessionTitle}」${note ? `：${note}` : ""}。`,
				remoteTitle: "远程触发",
				remoteBody: (note) =>
					`收到远程通知${note ? `：${note}` : ""}。`,
				// M2.5 workflow：host 的 note 只产片段，「工作流『…』」前缀统一在这里加
				// （两边都加会渲染成「工作流『工作流…』」）。
				workflowTitle: "工作流进展",
				workflowBody: (sessionTitle, note) =>
					`工作流「${sessionTitle}」${note ? note : "有进展"}。`,
				testTitle: "测试提醒",
				duration: (ms) => {
					if (ms >= 60000) return `耗时 ${Math.round(ms / 60000)} 分钟`;
					return `耗时 ${Math.max(0.1, Math.round(ms / 100) / 10)} 秒`;
				},
				testBody: "测试提醒"
			},
			en: {
				attentionTitle: "Action needed",
				attentionBody: (sessionTitle, detail, reAlert) =>
					`「${sessionTitle}」needs your input${detail ? `: ${detail}` : ""}${reAlert ? " (still pending)" : ""}.`,
				doneTitle: "Task done",
				doneBody: (sessionTitle, summary) =>
					`「${sessionTitle}」finished${summary ? ` · ${summary}` : ""} — click to go back to DSH.`,
				errorTitle: "Agent error",
				errorBody: (sessionTitle, note) =>
					`「${sessionTitle}」hit an error${note ? `: ${note}` : ""} — click to inspect.`,
				interruptedTitle: "Interrupted",
				interruptedBody: (sessionTitle, note) =>
					`「${sessionTitle}」was interrupted${note ? `: ${note}` : ""}.`,
				limitTitle: "Limit reached",
				limitBody: (sessionTitle, note) =>
					`「${sessionTitle}」hit a limit${note ? `: ${note}` : ""} — consider tuning parameters.`,
				jobTitle: "Background job",
				jobBody: (sessionTitle, note) =>
					`Background job «${sessionTitle}»${note ? `: ${note}` : ""}.`,
				remoteTitle: "Remote notice",
				remoteBody: (note) =>
					`Remote notice received${note ? `: ${note}` : ""}.`,
				workflowTitle: "Workflow progress",
				workflowBody: (sessionTitle, note) =>
					`Workflow «${sessionTitle}»${note ? ` ${note}` : " progressed"}.`,
				testTitle: "Test alert",
				duration: (ms) => {
					if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
					return `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
				},
				testBody: "test alert"
			}
		};

		function language() {
			const lang = state.config.language;
			if (lang === "zh") return "zh";
			if (lang === "en") return "en";
			try {
				const base = String(document.documentElement?.lang ?? (typeof navigator !== "undefined" ? navigator.language : "") ?? "");
				return base.toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				return "zh";
			}
		}

		let permission = "unknown";
		function ensurePermission() {
			if (typeof Notification === "undefined") return;
			try {
				if (Notification.permission === "granted") permission = "granted";
				else if (Notification.permission === "denied") permission = "denied";
				else if (typeof Notification.requestPermission === "function") {
					Notification.requestPermission().then(
						(p) => { permission = p; },
						() => { permission = Notification.permission; }
					);
				}
			} catch {
				permission = "unknown";
			}
		}
		function livePermission() {
			try { return typeof Notification === "undefined" ? "denied" : Notification.permission; }
			catch { return "denied"; }
		}

		// ---- config ----
		const state = { config: { ...DEFAULT_CONFIG }, configSource: "local" };
		function loadConfig() {
			try {
				const raw = window.localStorage?.getItem(CONFIG_KEY);
				if (raw) state.config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
			} catch { /* defaults */ }
		}
		function saveConfig() {
			try { window.localStorage?.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch { /* non-persistent session */ }
		}
		function setConfig(partial) { state.config = { ...state.config, ...(partial ?? {}) }; saveConfig(); return state.config; }
		function resetConfig() { state.config = { ...DEFAULT_CONFIG }; saveConfig(); return state.config; }
		// 服务端配置优先：GET /pharos/api/config 成功时深合并覆盖 localStorage 偏好。
		// （密钥字段打码视图会原样缓存——浏览器侧不使用 token/secret。）
		function mergeServerConfig(serverCfg) {
			if (!serverCfg || typeof serverCfg !== "object") return;
			const merged = { ...state.config, ...serverCfg };
			if (serverCfg.quietHours && typeof serverCfg.quietHours === "object") {
				merged.quietHours = { ...(state.config.quietHours ?? {}), ...serverCfg.quietHours };
			}
			if (Array.isArray(serverCfg.webhooks)) merged.webhooks = serverCfg.webhooks;
			state.config = merged;
			state.configSource = "server";
			saveConfig();
		}

		// ---- quiet hours（跨午夜）----
		function quietHoursActive() {
			const qh = state.config.quietHours;
			if (!qh || !qh.enabled || !qh.start || !qh.end) return false;
			const hm = (s) => {
				const [h, m] = String(s).split(":").map(Number);
				return (h || 0) * 60 + (m || 0);
			};
			const start = hm(qh.start);
			const end = hm(qh.end);
			if (start === end) return false;
			let now;
			try { now = new Date(); } catch { return false; }
			const cur = now.getHours() * 60 + now.getMinutes();
			return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
		}

		// ---- chime: WebAudio, per-kind patterns ----
		function playChime(kind) {
			const cfg = state.config;
			if (!cfg.sound) return;
			try {
				const AudioCtx = window.AudioContext || window.webkitAudioContext;
				if (!AudioCtx) return;
				const vol = Math.max(0, Math.min(1, cfg.volume));
				const ac = new AudioCtx();
				const note = (freq, at, dur, v) => {
					const osc = ac.createOscillator();
					const gain = ac.createGain();
					osc.type = "sine";
					osc.frequency.value = freq;
					const t0 = ac.currentTime + at;
					gain.gain.setValueAtTime(0.0001, t0);
					gain.gain.exponentialRampToValueAtTime(v * vol, t0 + 0.03);
					gain.gain.setValueAtTime(v * vol, t0 + dur - 0.05);
					gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
					osc.connect(gain);
					gain.connect(ac.destination);
					osc.start(t0);
					osc.stop(t0 + dur + 0.06);
				};
				if (ac.state === "suspended") ac.resume();
				if (kind === "attention") {
					note(988, 0, 0.14, 0.14);    // B5
					note(784, 0.13, 0.14, 0.14);  // G5
					note(659, 0.26, 0.26, 0.14);  // E5
				} else if (kind === "error") {
					note(220, 0, 0.22, 0.16);     // A3 重低音
					note(165, 0.2, 0.34, 0.16);   // E3
					note(131, 0.5, 0.40, 0.14);   // C3
				} else if (kind === "interrupted") {
					note(523, 0, 0.14, 0.13);     // C5 中音警示
					note(494, 0.13, 0.14, 0.13);  // B4
					note(440, 0.26, 0.3, 0.13);   // A4
				} else if (kind === "limit") {
					note(587, 0, 0.16, 0.14);     // D5
					note(440, 0.15, 0.16, 0.14);  // A4
					note(349, 0.3, 0.34, 0.14);   // F4
				} else {
					// 默认/兜底音（含 M2.5 的 workflow 与 job）——M2.5 刻意不给 workflow
					// 专属音型：工作流事件语义是「进度」，与 done 的完成音同属常规提示，
					// 复用上行二音即可；真要区分可复用 limit 的下行三音。
					note(880, 0, 0.16, 0.12);     // A5
					note(1318.51, 0.14, 0.26, 0.12); // E6
				}
				setTimeout(() => ac.close().catch(() => {}), 1000);
			} catch { /* audio unavailable */ }
		}

		// ---- helpers bound per apply ----
		let bindings = null; // { ctx, uiSession, statusStore, sessions }
		function sessionTitle(sessionId) {
			try {
				const row = bindings.sessions.list.getSnapshot().byId[sessionId];
				return row && row.displayTitle ? row.displayTitle : sessionId;
			} catch { return sessionId; }
		}
		function currentSessionId() {
			try { return bindings.uiSession.current.value?.key; } catch { return void 0; }
		}
		function pendingDetail(interaction) {
			try {
				if (!interaction) return "";
				if (interaction.kind === "approval") {
					const parts = [];
					if (interaction.toolName) parts.push(interaction.toolName);
					if (interaction.reason) parts.push(interaction.reason);
					else if (interaction.displayReason) parts.push(interaction.displayReason);
					return parts.join(" · ");
				}
				if (interaction.questions && interaction.questions.length > 0) {
					const q = interaction.questions[0];
					return typeof q === "string" ? q : (q?.question ?? "");
				}
				if (interaction.reason) return interaction.reason;
				return "";
			} catch { return ""; }
		}
		function interactionKey(sessionId, interaction) {
			try { return String(interaction?.key ?? `${sessionId}:${interaction?.kind ?? "pending"}`); }
			catch { return `${sessionId}:pending`; }
		}
		function baseTitleOf() {
			try {
				let t = document.title;
				if (t.startsWith(BLINK_PREFIX)) t = t.slice(BLINK_PREFIX.length);
				if (t.startsWith(MARKER)) t = t.slice(MARKER.length);
				return t;
			} catch { return ""; }
		}

		// ---- title marker (🔔) ----
		let markerActive = false;
		let markerBase = "";
		let markerTimer = null;
		function paintTitle() {
			try {
				const title = document.title;
				if (markerActive) {
					if (!title.startsWith(MARKER) && !title.startsWith(BLINK_PREFIX)) document.title = MARKER + title;
				} else if (markerBase && title === MARKER + markerBase) {
					document.title = markerBase;
				}
			} catch { /* ignore */ }
		}
		function ensureMarkerTimer() {
			if (markerTimer !== null) return;
			markerTimer = setInterval(paintTitle, 800);
		}
		function stopMarkerTimer() {
			if (markerTimer !== null) { clearInterval(markerTimer); markerTimer = null; }
		}
		function setMarker(on) {
			const cfg = state.config;
			on = on && cfg.enabled;
			if (on === markerActive) return;
			markerActive = on;
			try {
				if (on) {
					const cur = baseTitleOf();
					markerBase = cur;
					document.title = MARKER + cur;
					ensureMarkerTimer();
				} else {
					if (markerBase) document.title = markerBase;
					markerBase = "";
					stopMarkerTimer();
				}
			} catch { /* ignore */ }
		}

		// ---- blink fallback (⏳), 6s ----
		let blink = null;
		function stopBlink() {
			if (blink === null) return;
			clearInterval(blink.timer);
			if (blink.on) { try { document.title = blink.base; } catch { /* ignore */ } }
			blink = null;
		}
		function blinkStart() {
			if (blink !== null) return;
			try {
				blink = { ticks: 0, on: false, base: baseTitleOf(), timer: null };
				blink.timer = setInterval(() => {
					if (blink === null) return;
					blink.ticks++;
					if (blink.ticks >= BLINK_TICKS) { stopBlink(); return; }
					blink.on = !blink.on;
					document.title = blink.on ? BLINK_PREFIX + blink.base : blink.base;
				}, 500);
			} catch { blink = null; }
		}

		// ---- DOM toast fallback（系统通知不可用/被拒时）----
		let toastBox = null;
		/**
		 * 把 style 对象应用到元素。
		 * ⚠️ 不能写 `el.style = { ... }` —— 真实 DOM 里 `el.style` 是只读的
		 * CSSStyleDeclaration（没有 setter），赋值在非严格模式下**静默失败**：
		 * 元素被创建、append 了，却没有任何样式（透明、无固定定位），
		 * 表现为「点了测试按钮什么都没出现」。v0.4 引入、一直没被发现。
		 * 测试桩的 DOM 元素是普通对象（style 可写），故测试通过而真机失败。
		 */
		function applyStyle(el, obj) {
			if (!el) return;
			try {
				if (el.style && typeof el.style.setProperty === "function") {
					// 真实 CSSStyleDeclaration：el.style 只读，只能逐条 setProperty
					for (const [k, v] of Object.entries(obj)) {
						el.style.setProperty(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(v));
					}
					return;
				}
				// 测试桩的普通对象：style 可写，直接合并
				el.style = { ...(el.style || {}), ...obj };
			} catch { /* 样式失败不应影响通知本身 */ }
		}

		function toastBoxEl() {
			try {
				if (toastBox && toastBox.parent) return toastBox;
				toastBox = document.getElementById("dsh-pharos-toast-box");
				if (!toastBox) {
					toastBox = document.createElement("div");
					toastBox.id = "dsh-pharos-toast-box";
					toastBox.className = "dsh-pharos-toast-box";
					applyStyle(toastBox, { position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483647 });
					document.body.appendChild(toastBox);
				}
				return toastBox;
			} catch { return null; }
		}
		function showDomToast(sessionId, kind, title, body, opts) {
			const box = toastBoxEl();
			if (!box) return;
			try {
				const els = box.children ?? [];
				while (els.length >= TOAST_MAX && els.length > 0) {
					const oldest = els[0];
					if (oldest && typeof oldest.remove === "function") oldest.remove();
					else els.shift();
				}
				const el = document.createElement("div");
				el.className = "dsh-pharos-toast";
				applyStyle(el, { padding: "10px 14px", margin: "8px 0", background: kind === "error" ? "#7a1f1f" : (kind === "limit" || kind === "interrupted" ? "#7a5a1f" : "#1f3a5f"), color: "#fff", borderRadius: "8px", boxShadow: "0 2px 10px rgba(0,0,0,.3)", cursor: "pointer", maxWidth: "320px", font: "13px/1.5 system-ui, sans-serif" });
				const titleEl = document.createElement("div");
				titleEl.textContent = title;
				applyStyle(titleEl, { fontWeight: 600, marginBottom: "2px" });
				const bodyEl = document.createElement("div");
				bodyEl.textContent = body;
				applyStyle(bodyEl, { opacity: 0.9 });
				el.appendChild(titleEl);
				el.appendChild(bodyEl);
				const didFocus = (opts && opts.autoFocus) !== false;
				el.addEventListener("click", () => {
					if (didFocus) focusWindow();
					openSession(sessionId);
					try { el.remove(); } catch { /* ignore */ }
				});
				box.appendChild(el);
				setTimeout(() => { try { el.remove(); } catch { /* ignore */ } }, TOAST_LIFETIME_MS);
			} catch { /* DOM 不可用时静默 */ }
		}

		// ---- deliver ----
		function pageFocused() {
			try { return typeof document !== "undefined" && document.visibilityState !== "hidden" && document.hasFocus(); } catch { return true; }
		}
		function focusWindow() { try { window.focus(); } catch { /* ignore */ } }
		function openSession(sessionId) {
			try {
				const session = bindings.sessions.binding?.(sessionId)?.session;
				if (session && typeof session.open === "function") session.open();
			} catch { /* best effort */ }
		}
		function notificationFor(kind, sessionId, note, opts) {
			const t = TEXT[language()];
			const title = sessionTitle(sessionId);
			opts = opts ?? {};
			let notifTitle, notifBody;
			if (kind === "attention") {
				notifTitle = t.attentionTitle;
				notifBody = t.attentionBody(title, note, opts.reAlert === true);
			} else if (kind === "done") {
				notifTitle = t.doneTitle;
				notifBody = t.doneBody(title, opts.summary) + (note ? `\n${note}` : "");
			} else if (kind === "error") {
				notifTitle = t.errorTitle;
				notifBody = t.errorBody(title, note);
			} else if (kind === "interrupted") {
				notifTitle = t.interruptedTitle;
				notifBody = t.interruptedBody(title, note);
			} else if (kind === "limit") {
				notifTitle = t.limitTitle;
				notifBody = t.limitBody(title, note);
			} else if (kind === "job") {
				notifTitle = t.jobTitle;
				notifBody = t.jobBody(title, note);
			} else if (kind === "remote") {
				notifTitle = t.remoteTitle;
				notifBody = t.remoteBody(note);
			} else if (kind === "test") {
				notifTitle = t.testTitle;
				notifBody = t.testBody + (note ? `\n${note}` : "");
			} else if (kind === "workflow") {
				// M2.5：优先用帧里的 sessionTitle（host 填的是工作流名），
				// 否则回退查会话表 —— phase/log 的 sessionId 是 runId，查不到会显示裸 id。
				const wfTitle = opts.frameSessionTitle || title;
				notifTitle = t.workflowTitle;
				notifBody = t.workflowBody(wfTitle, note);
			} else {
				notifTitle = t.attentionTitle;
				notifBody = note;
			}
			return { title: notifTitle, body: notifBody };
		}
		// 只记录渠道结果和策略，不记录正文/密钥。构造成功仅表示 requested。
		const recentNotifications = [];
		function recordNotification(kind, sessionId, source, result, reason) {
			const entry = { kind, sessionId, source, result, reason, ts: Date.now(),
				permission: livePermission(), pageFocused: pageFocused(),
				visibilityState: typeof document !== "undefined" ? document.visibilityState : undefined };
			recentNotifications.push(entry);
			while (recentNotifications.length > 20) recentNotifications.shift();
			return entry;
		}
		function deliver(kind, sessionId, detail, opts) {
			const cfg = state.config;
			opts = opts ?? {};
			// bypass（仅设置页「测试」按钮走）：测试就是测试，不该被真实策略静默 ——
			// 否则用户点「完成」却什么都没发生，无法分辨是坏了还是被 quietHours/doneHiddenOnly 拦了。
			const bypass = opts.bypass === true;
			if (!bypass) {
				if (!cfg.enabled) { recordNotification(kind, sessionId, opts.source, "suppressed", "disabled"); return; }
				if (quietHoursActive()) { recordNotification(kind, sessionId, opts.source, "suppressed", "quiet-hours"); return; }
			}
			const note = opts.note ?? detail ?? "";
			const { title, body } = notificationFor(kind, sessionId, note, opts);
			let toasting = false;
			const attempt = recordNotification(kind, sessionId, opts.source, "unavailable");
			// bypass 跳过 Notification 直发：测试时页面就在眼前，系统通知既不可见又可能
			// 被横幅/专注模式吞掉，页内 toast 才是可靠反馈。
			if (bypass) {
				showDomToast(sessionId, kind, title, body, { autoFocus: false, bypass: true });
				toasting = true; // 已走页内 toast —— 必须置位，否则下方 !toasting 兜底分支会**再弹一条**
				attempt.result = "dom-test";
			} else if (cfg.toast && livePermission() !== "denied" && typeof Notification !== "undefined") {
				try {
					// 去重在策略层做。不要把会话 ID 塞进 tag：Electron 在 Windows
					// 用它生成原生标识，长会话 ID 可能超过系统允许的 tag 长度。
					const n = new Notification(title, { body, silent: true });
					attempt.result = "requested";
					n.onshow = () => { if (attempt.result === "requested") attempt.result = "shown"; };
					n.onerror = () => {
						if (attempt.result === "error") return;
						attempt.result = "error";
						// 异步失败不在构造器 try/catch 内；只补一次，不重复响铃。
						if (!state.config.enabled || !state.config.toast || quietHoursActive()) return;
						showDomToast(sessionId, kind, title, body, { autoFocus: state.config.autoFocus });
						if (state.config.blinkFallback && !pageFocused()) blinkStart();
					};
					n.onclick = () => {
						if (opts.autoFocus !== false && cfg.autoFocus) focusWindow();
						if (kind === "attention") openSession(sessionId);
						try { n.close(); } catch { /* ignore */ }
					};
					toasting = true;
				} catch { toasting = false; attempt.result = "constructor-error"; }
			} else {
				attempt.result = !cfg.toast ? "toast-disabled" : livePermission() === "denied" ? "denied" : "unavailable";
			}
			if (!toasting && cfg.toast) showDomToast(sessionId, kind, title, body, { autoFocus: cfg.autoFocus });
			if (!toasting && cfg.blinkFallback && !pageFocused()) blinkStart();
			if (toasting || cfg.sound) playChime(kind);
		}

		// ---- tracking state ----
		const track = {
			prevRunning: new Map(),
			prevUnread: new Set(),
			prevPending: new Map(),       // sessionId -> interaction key
			pendingKeys: new Set(),       // active interaction keys
			runStarted: new Map(),        // sessionId -> epoch ms when run began
			reAlertTimers: new Map(),     // interaction key -> timeout id
			baseline: true,
			lastDoneAt: new Map()
		};
		// M2.5/v0.6.1：**子代理** sessionId 集合，用于过滤「本地 done 路径」。
		// 该路径由 uiSession 的 running→false 边沿驱动，而 uiSession 只有 3 字段、
		// sessions.list 行也没有 origin/parentSession → 浏览器半判不出子代理，只能靠 host 下发。
		// 两个来源（写进同一个 Set）：
		//   ① workflow/agent-start 帧的 childId（M2.5）—— 工作流的子 agent
		//   ② agents 元信息帧的 subagentSessionIds（v0.6.1）—— **普通** subagent 委派
		//      （agent/* 工具派生的子会话；不经 workflow，无 childId 可捎带，v0.6.0 识别不了）
		const childAgentIds = new Set();
		const sseSeen = new Map();        // dedupeKey -> ts（SSE 帧级去重 2s）

		function scheduleReAlert(key, sessionId, interaction) {
			const cfg = state.config;
			if (!cfg.enabled || cfg.reAlertMs <= 0) return;
			if (track.reAlertTimers.has(key)) return;
			const timerId = setTimeout(() => {
				track.reAlertTimers.delete(key);
				if (track.pendingKeys.has(key)) {
						deliver("attention", sessionId, pendingDetail(interaction), { reAlert: true, source: "ui-realert" });
				}
			}, cfg.reAlertMs);
			track.reAlertTimers.set(key, timerId);
		}
		function clearReAlert(key) {
			const timerId = track.reAlertTimers.get(key);
			if (timerId !== void 0) { clearTimeout(timerId); track.reAlertTimers.delete(key); }
		}
		function notifyAttention(id, interaction) {
			const cfg = state.config;
			const pageActive = pageFocused();
			const current = currentSessionId();
			// 当前会话 + 前台：静默只留标记（审批卡片本来就在眼前）
			if (cfg.currentQuiet && id === current && pageActive) return;
			if (cfg.attentionHiddenOnly && pageActive) return;
			const key = interactionKey(id, interaction);
			deliver("attention", id, pendingDetail(interaction), { source: "ui-pending" });
			scheduleReAlert(key, id, interaction);
		}
		function notifyDone(id, durationMs, note, source) {
			const cfg = state.config;
			// 子代理过滤（默认丢弃）：id 来自 host 下发的 childId（workflow 子代理）。
			// 所有 done 触发路径都经 maybeNotifyDone；保留最内层子代理守卫。
			if (cfg.skipSubagents && childAgentIds.has(id)) return;
			const summary = durationMs >= 0 ? TEXT[language()].duration(durationMs) : "";
			const n = typeof note === "string" && note ? note : "";
			deliver("done", id, n, { summary, note: n, source });
		}
		// uiSession 边沿与 SSE done 共用：session 级节流 + doneHiddenOnly 门（双源去重）
		/**
		 * 「任务完成」的提醒时机（v0.6.1 三档，对齐竞品 VS Code / Codex / ChatGPT 的语义）：
		 *   'off'    —— 从不提醒
		 *   'hidden' —— 仅页面隐藏/未聚焦时（默认）
		 *   'always' —— 始终提醒（含正盯着页面时）
		 * 兼容：`doneNotifyMode` 缺失时按旧的 `doneHiddenOnly` 布尔映射
		 *   （true→hidden、false→always），使 0.6.0 之前的老配置行为不变。
		 */
		function doneNotifyModeOf(cfg) {
			const m = cfg.doneNotifyMode;
			if (m === "off" || m === "hidden" || m === "always") return m;
			// 老配置：只有 doneHiddenOnly
			return cfg.doneHiddenOnly === false ? "always" : "hidden";
		}

		function maybeNotifyDone(id, durationMs, note, source) {
			const cfg = state.config;
			const mode = doneNotifyModeOf(cfg);
			let reason;
			if (!cfg.enabled) reason = "disabled";
			else if (quietHoursActive()) reason = "quiet-hours";
			else if (cfg.skipSubagents && childAgentIds.has(id)) reason = "subagent";
			else if (mode === "off") reason = "done-off";
			else if (mode === "hidden" && pageFocused()) reason = "done-focused";
			if (reason) { recordNotification("done", id, source, "suppressed", reason); return; }
			const now = Date.now();
			const last = track.lastDoneAt.get(id) ?? 0;
			if (now - last < cfg.minIntervalMs) { recordNotification("done", id, source, "suppressed", "throttled"); return; }
			track.lastDoneAt.set(id, now);
			notifyDone(id, durationMs, note, source);
		}

		// ---- SSE: host 半帧消费 ----
		// agents = v0.6.1 元信息帧（host 下发子代理 sessionId 列表），silent 不打扰用户
		const SSE_KINDS = { done: 1, error: 1, interrupted: 1, limit: 1, job: 1, remote: 1, test: 1, workflow: 1, agents: 1 };
		// M2.5：SSE 帧内容环形队列，供 debug() 观察「到底收到了什么帧」。
		// ⚠️ 记录**所有**帧（含非静默帧），且入队点在 onSseFrame 的各类过滤**之前** ——
		//   否则「提醒没来」这类最该排查的场景（enabled 关 / 静默期 / kind 未登记）
		//   恰好什么都看不到。只存摘要字段、不存整帧（避免体积与敏感信息）；容量 20 条。
		const DEBUG_FRAME_RING = 20;
		const debugFrameRing = [];
		function pushDebugFrame(frame) {
			debugFrameRing.push({
				kind: typeof frame.kind === "string" ? frame.kind : "",
				subtype: typeof frame.subtype === "string" ? frame.subtype : undefined,
				silent: frame.silent === true ? true : undefined,
				sessionTitle: typeof frame.sessionTitle === "string" ? frame.sessionTitle : "",
				note: typeof frame.note === "string" ? frame.note.slice(0, 200) : "",
				ts: typeof frame.ts === "number" ? frame.ts : Date.now(),
			});
			while (debugFrameRing.length > DEBUG_FRAME_RING) debugFrameRing.shift();
		}
		let sse = null;
		let sseState = "closed";
		let sseFramesReceived = 0; // 可观测性：解析成功的 SSE 帧数（sse open 但恒 0 = R1 信号）
		let sseLastFrameAt = null; // 最近一帧毫秒时间戳（无帧则 null）
		// M2：最近一轮当轮统计（host 半投影 delta），供 stats() 访问器 + 设置页卡片读取。
		let lastStats = null;
		function publishStats(stats) {
			if (!stats || typeof stats !== "object") return;
			lastStats = stats;
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					window.localStorage.setItem("dshPharos.stats", JSON.stringify(stats));
				}
			} catch { /* storage unavailable */ }
			try {
				const doc = typeof document !== "undefined" ? document : null;
				if (doc && typeof doc.dispatchEvent === "function") {
					const Ctor = typeof CustomEvent === "function" ? CustomEvent : Event;
					doc.dispatchEvent(new Ctor("pharos:stats", { detail: stats }));
				}
			} catch { /* CustomEvent unavailable */ }
		}
		function readStoredStats() {
			if (lastStats) return lastStats;
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					const raw = window.localStorage.getItem("dshPharos.stats");
					if (raw) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return parsed; }
				}
			} catch { /* ignore */ }
			return null;
		}
		function statsFromFrame(frame) {
			// 仅当帧带任一统计字段时才算「有统计」；否则返回 null（不覆盖已有 lastStats）。
			if (!frame || typeof frame !== "object") return null;
			const hasTokens = typeof frame.tokens === "number" && frame.tokens > 0;
			const hasDuration = typeof frame.durationMs === "number" && frame.durationMs >= 0;
			const hasCache = typeof frame.cacheHitRate === "number" && Number.isFinite(frame.cacheHitRate);
			const hasTps = typeof frame.tps === "number" && Number.isFinite(frame.tps);
			if (!hasTokens && !hasDuration && !hasCache && !hasTps) return null;
			return {
				kind: frame.kind,
				sessionId: frame.sessionId ?? "",
				sessionTitle: frame.sessionTitle ?? "",
				durationMs: hasDuration ? frame.durationMs : undefined,
				tokens: hasTokens ? frame.tokens : undefined,
				cacheHitRate: hasCache ? frame.cacheHitRate : undefined,
				tps: hasTps ? frame.tps : undefined,
				ts: typeof frame.ts === "number" ? frame.ts : Date.now(),
			};
		}
		// M2：把 stats 对象拼成「耗时 X · N tokens · 缓存命中 X% · X tok/s」文本，
		// 供 test(kind, stats) 的 done 分支织进通知正文（与 host 侧 noteFor 语义对齐）。
		function statsSummaryOf(stats) {
			if (!stats || typeof stats !== "object") return "";
			const parts = [];
			if (typeof stats.durationMs === "number" && stats.durationMs >= 0) parts.push(TEXT[language()].duration(stats.durationMs));
			if (typeof stats.tokens === "number" && stats.tokens > 0) parts.push(`${stats.tokens} tokens`);
			if (typeof stats.cacheHitRate === "number" && Number.isFinite(stats.cacheHitRate)) parts.push(`缓存命中 ${Math.round(stats.cacheHitRate * 100)}%`);
			if (typeof stats.tps === "number" && Number.isFinite(stats.tps) && stats.tps > 0) parts.push(`${stats.tps.toFixed(1)} tok/s`);
			return parts.join(" · ");
		}
		function onSseFrame(frame) {
			if (!frame || typeof frame !== "object" || typeof frame.kind !== "string") return;
			sseFramesReceived += 1; // 可观测性：帧已到达（解析成功之后、各类过滤之前；区分 R1 与"被 enabled/quietHours/kind 吞掉"）
			sseLastFrameAt = Date.now();
			// M2：帧带统计字段即发布当轮统计（先于各类过滤，保证统计可见；不受 enabled 静默影响）
			const stats = statsFromFrame(frame);
			if (stats) publishStats(stats);
			// M2.5 可观测性：**任何**帧都入 debug 队列，且必须早于 enabled/quietHours/kind
			// 早退 —— 否则「提醒没来」这类最该排查的场景恰好什么都看不到。
			// recentFrames 含非静默帧，故名不叫 recentSilentFrames。
			pushDebugFrame(frame);
			const cfg = state.config;
			if (!cfg.enabled) return;
			if (quietHoursActive()) return;
			if (!Object.prototype.hasOwnProperty.call(SSE_KINDS, frame.kind)) return; // 未知 kind 静默
			// M2.5 登记子代理 sessionId（agent-start 帧捎带 childId）→ 供 notifyDone 过滤。
			if (typeof frame.childId === "string" && frame.childId !== "") childAgentIds.add(frame.childId);
			// v0.6.1 消费 agents 元信息帧：host 下发已判定的子代理 sessionId 列表
			//（覆盖**普通** subagent 委派 —— 不经 workflow、无 childId 可捎带的那一类）。
			if (frame.kind === "agents" && Array.isArray(frame.subagentSessionIds)) {
				for (const id of frame.subagentSessionIds) {
					if (typeof id === "string" && id !== "") childAgentIds.add(id);
				}
			}
			// M2.5 silent 帧：不弹通知/音效/标题/Toast。
			// （host 侧 emitWebhooks 也已按 silent 早退，故这里 return 即全渠道静默。）
			if (frame.silent === true) return;
			// 子代理过滤（默认丢弃）
			if (cfg.skipSubagents && frame.agentType === "subagent") return;
			const sessionId = frame.sessionId ?? "console";
			const note = typeof frame.note === "string" ? frame.note : "";
			const dk = typeof frame.dedupeKey === "string" && frame.dedupeKey
				? frame.dedupeKey
				: `${frame.kind}:${sessionId}`;
			const now = Date.now();
			// sseSeen 只写不删（原缺陷）：按 SSE_DEDUPE_MS 窗口修剪过期键，防长会话无界增长
			for (const [k, ts] of sseSeen) { if (now - ts > SSE_DEDUPE_MS) sseSeen.delete(k); }
			const last = sseSeen.get(dk);
			if (last !== void 0 && now - last < SSE_DEDUPE_MS) return;
			sseSeen.set(dk, now);
			if (frame.kind === "done") {
				maybeNotifyDone(sessionId, typeof frame.durationMs === "number" ? frame.durationMs : -1, note, "sse");
				return;
			}
			// M2.5：把帧的 sessionTitle 透传，workflow 分支优先用它（host 填的是工作流名；
			// phase/log 的 sessionId 是 runId，查会话表会落裸 id）。
			deliver(frame.kind, sessionId, note, { note, frameSessionTitle: frame.sessionTitle, source: "sse" });
		}
		function connectSse() {
			if (typeof EventSource === "undefined") return;
			try {
				sse = new EventSource(SSE_URL);
				sseState = "connecting";
				sse.onopen = () => { sseState = "open"; };
				sse.onerror = () => { sseState = sse && sse.readyState === 0 ? "connecting" : "error"; }; // EventSource 内建自动重连
				// host 只发命名事件（routes.js:146 `event: pharos`）；按 WHATWG SSE 规范，
				// 命名帧只派发给 addEventListener 监听器、绝不进 onmessage。两条路都挂：
				// 命名 = host 真实输出；onmessage = 防宿主未来发无名帧的兼容路。
				const onFrame = (ev) => {
					if (!ev || !ev.data) return;
					let frame;
					try { frame = JSON.parse(ev.data); } catch { return; }
					withCrossTabLock(() => onSseFrame(frame));
				};
				sse.onmessage = onFrame;
				sse.addEventListener("pharos", onFrame);
			} catch { sse = null; sseState = "closed"; }
		}
		function withCrossTabLock(fn) {
			try {
				if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
					navigator.locks.request("dshPharos", async () => { fn(); });
					return;
				}
			} catch { /* fallthrough */ }
			fn();
		}

		// ---- 服务端配置优先 ----
		function fetchServerConfig() {
			if (typeof fetch !== "function") return;
			try {
				fetch(CONFIG_URL, { headers: { accept: "application/json" } })
					.then((res) => (res && res.ok ? res.json() : null))
					.then((cfg) => { if (cfg) mergeServerConfig(cfg); })
					.catch(() => { /* host 半不在线：保持 localStorage */ });
			} catch { /* fetch unavailable */ }
		}

		// ---- tick（uiSession 状态机，v0.3 语义保留）----
		function tick() {
			const cfg = state.config;
			let snap;
			try { snap = bindings.statusStore.getSnapshot(); } catch { return; }
			const pageActive = pageFocused();
			const current = currentSessionId();
			let markerWanted = false;

			if (track.baseline) {
				track.baseline = false;
				for (const [id, st] of snap) {
					track.prevRunning.set(id, st.running);
					if (st.running) track.runStarted.set(id, Date.now());
					if (st.completionUnread) track.prevUnread.add(id);
					if (st.pendingInteraction) {
						const key = interactionKey(id, st.pendingInteraction);
						track.prevPending.set(id, key);
						track.pendingKeys.add(key);
						markerWanted = true;
						// 挂载时已存在的等待也提醒一次（并安排二次提醒）
						if (cfg.enabled) notifyAttention(id, st.pendingInteraction);
					}
				}
				setMarker(markerWanted);
				return;
			}

			const nextPending = new Map();
			for (const [id, st] of snap) {
				// --- 需要你：pending interaction 出现 ---
				const interaction = st.pendingInteraction;
				if (interaction) {
					const key = interactionKey(id, interaction);
					nextPending.set(id, key);
					markerWanted = true;
					if (!track.prevPending.has(id) || track.prevPending.get(id) !== key) {
						track.pendingKeys.add(key);
						notifyAttention(id, interaction);
					}
				}

				// --- 运行计时 ---
				if (st.running && !track.runStarted.has(id)) track.runStarted.set(id, Date.now());

				// --- 完成：unread 边沿 或 running 翻转 ---
				const wasUnread = track.prevUnread.has(id);
				const durationMs = track.runStarted.has(id) ? Date.now() - track.runStarted.get(id) : -1;
				if (st.completionUnread && !wasUnread) {
					track.prevUnread.add(id);
					track.prevRunning.set(id, st.running);
					track.runStarted.delete(id);
					maybeNotifyDone(id, durationMs, undefined, "ui-unread");
					continue;
				}
				if (!st.completionUnread && wasUnread) track.prevUnread.delete(id);

				const wasRunning = track.prevRunning.get(id) ?? false;
				if (wasRunning && !st.running) {
					track.runStarted.delete(id);
					maybeNotifyDone(id, durationMs, undefined, "ui-running");
				} else if (!wasRunning && st.running) {
					track.runStarted.set(id, Date.now());
				}
				track.prevRunning.set(id, st.running);
			}

			// 采纳本次快照的 pending 基线，清理消失的 key 与定时器
			track.prevPending = nextPending;
			const activePendingKeys = new Set(nextPending.values());
			for (const key of [...track.pendingKeys]) {
				if (!activePendingKeys.has(key)) { track.pendingKeys.delete(key); clearReAlert(key); }
			}
			for (const id of [...track.prevUnread]) if (!snap.has(id)) track.prevUnread.delete(id);
			for (const id of [...track.prevRunning.keys()]) if (!snap.has(id)) track.prevRunning.delete(id);
			for (const id of [...track.runStarted.keys()]) if (!snap.has(id)) track.runStarted.delete(id);

			if (!cfg.enabled) markerWanted = false;
			setMarker(markerWanted);
			if (pageActive) stopBlink();
		}

		// ---- console API ----
		// M2.5：ALL_TEST_KINDS 必须覆盖设置页 TEST_KINDS 的全部取值，
		// 否则设置页「测试通知」选到未登记的 kind 会落 else 分支、弹出别的文案（按钮骗人）。
		const ALL_TEST_KINDS = { attention: 1, done: 1, error: 1, interrupted: 1, limit: 1, remote: 1, job: 1, test: 1, workflow: 1 };
		function installApi() {
			window[API_KEY] = {
				version: "0.6.1",
				config: () => ({ ...state.config }),
				setConfig: (partial) => setConfig(partial),
				resetConfig: () => resetConfig(),
				stats: () => readStoredStats(),
				test: (kind, stats) => {
					const k = String(kind ?? "done");
					const sid = currentSessionId() ?? "console";
					// M2：test(kind, stats) 支持可选统计参——把 stats 派发出去并写进 lastStats，
					// 供设置页统计卡片与 smoke 确定性验证使用。
					if (stats && typeof stats === "object") publishStats(statsFromFrame({
						kind: k, sessionId: sid, sessionTitle: "", ...stats,
					}) || { kind: k, sessionId: sid, sessionTitle: "", ...stats });
					const summary = stats ? statsSummaryOf(stats) : TEXT[language()].duration(12345);
					// bypass: true —— 设置页「测试」按钮要的是**看得见的即时反馈**：
					//   ① 无视 quietHours（测试不受静默期策略影响）
					//   ② 强制页内 toast（系统通知不在页面上、还可能被横幅/专注模式吞掉）
					//   ③ 无视 doneHiddenOnly（「完成」类本在页面前台不弹，测试要弹）
					// ⚠️ 仍保留 sound 开关 —— 用户主动关掉音效时测试不该强制出声。
					const o = { bypass: true, autoFocus: false, source: "test" };
					if (k === "attention") deliver("attention", sid, TEXT[language()].testBody, o);
					else if (k === "done") deliver("done", sid, "", { ...o, summary });
					else if (Object.prototype.hasOwnProperty.call(ALL_TEST_KINDS, k)) {
						deliver(k, sid, "", { ...o, note: TEXT[language()].testBody });
					} else {
						deliver("done", sid, "", { ...o, summary });
					}
					return k; // 便于设置页 Debug 区回显「实际触发的 kind」
				},
				debug: () => ({
					config: { ...state.config },
					configSource: state.configSource,
					sse: sseState,
					framesReceived: sseFramesReceived,
					lastFrameAt: sseLastFrameAt,
					stats: readStoredStats(),
					recentFrames: [...debugFrameRing],
					recentNotifications: recentNotifications.map((entry) => ({ ...entry })),
					permission: livePermission(),
					pageFocused: pageFocused(),
					currentSessionId: currentSessionId(),
					baseline: track.baseline,
					pendingKeys: [...track.pendingKeys],
					runningTracked: [...track.runStarted.keys()],
					reAlertScheduled: [...track.reAlertTimers.keys()],
					titleMarker: markerActive,
					blinking: blink !== null
				})
			};
		}

		// ---- apply ----
		let mounting = null; // settings tab disposer
		let resumeTimer = null; // uiSession 未就绪时的 500ms 重试（照 dsh-notify-me：服务延迟就绪则延迟接管）
		function apply(ctx) {
			try {
				loadConfig();
				ensurePermission();
				installApi();
				fetchServerConfig();

				const sessions = ctx.get?.("sessions") ?? ctx.sessions;
				const cleanups = [];

				// 一次性注册整体清理（unsub / sse / 设置页 / 标题挂件）
				const teardownAll = () => {
					if (resumeTimer) { try { clearTimeout(resumeTimer); } catch { /* ignore */ } resumeTimer = null; }
					// statusStore 订阅等运行时清理（倒序执行；splice 取出即清空，重复调用安全）
					for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch { /* ignore */ } }
					if (sse) { try { sse.close(); } catch { /* ignore */ } sse = null; }
					if (mounting) { try { mounting(); } catch { /* ignore */ } mounting = null; }
					stopMarkerTimer();
					stopBlink();
					for (const key of [...track.reAlertTimers.keys()]) clearReAlert(key);
					if (markerActive) {
						markerActive = false;
						if (markerBase) document.title = markerBase;
					}
				};
				try { ctx.effect(() => teardownAll); } catch { /* root effect may not exist in all hosts */ }

				// 设置页挂载（slots 已声明在 inject；服务未就绪先探测、随重试循环补挂）
				const mountSettingsIfReady = () => {
					if (mounting) return; // 已尝试过
					let slots = null;
					try { slots = ctx.get?.("slots") ?? ctx.slots; } catch { /* guard 兜底 */ }
					if (!slots || typeof slots.register !== "function") return; // 未就绪
					try {
						mounting = pharosSettingsView.mountSettingsSection(ctx, { configApi: window[API_KEY] });
					} catch { mounting = null; }
				};
				mountSettingsIfReady();

				// SSE 独立于 uiSession，立即连接（帧消费不依赖状态机）
				connectSse();

				// 核心监视器：等服务就绪再接管（启动期服务按树序激活，uiSession 可能
				// 比本条目晚；缺了不炸、延迟接管——cordis 守卫对未声明直读会抛，
				// 见导出注释；inject 已声明 sessions/uiSession/slots 全部读取面）。
				let attempts = 0;
				const bootWhenReady = () => {
					mountSettingsIfReady();
					let uiSession = null;
					try { uiSession = ctx.get?.("uiSession") ?? ctx.uiSession; } catch { /* guard 兜底 */ }
					const statusStore = uiSession && typeof uiSession === "object" ? uiSession.sessionStatus : undefined;
					if (!statusStore) {
						if (attempts++ >= 60) return; // 30s 后放弃，保持静默运行
						resumeTimer = setTimeout(bootWhenReady, 500);
						return;
					}
					resumeTimer = null;
					bindings = { ctx, uiSession, statusStore, sessions };
					try {
						const unsub = statusStore.subscribe(tick);
						if (typeof unsub === "function") cleanups.push(unsub);
					} catch { return; }
					tick();
				};
				bootWhenReady();
			} catch (err) {
				// 永不外抛：apply 抛错会让 cordis 把条目标记 failed，触发应用 fail-loud
				// 恢复流程（会重写 profile 补丁）。任何子步失败都保持条目存活、核心降级。
				try { console.warn("[dsh-pharos] apply 内部错误：", err); } catch { /* ignore */ }
			}
		}

		//=====================================================================
//#region settings-view
	// 规范源：lib/settings-view.js —— 修改视图请改独立文件，然后运行
	// `node tools/sync-settings-view.mjs` 重新生成本 region（保证同步；pretest 自动执行）。
	var pharosSettingsView = (function (globalScope) { // eslint-disable-line no-unused-vars

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
				h("p", { className: "pharos-hint" }, "这些按钮测试页内提示和声音，不验证 Windows 系统通知。系统通知请用真实事件或 POST /pharos/api/trigger 验证，再点击 Debug 刷新查看 recentNotifications：requested 表示已请求，shown 表示宿主已报告显示；一直 requested 不算显示成功。"),
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
	return { mountSettingsSection: mountSettingsSection };
	})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
	//#endregion settings-view
		//=====================================================================

		module.exports = {
			name: "dsh-pharos",
			// cordis 上下文代理：服务未声明在 inject 时 ctx.get 返回空、直接属性读
			// （ctx.uiSession / ctx.slots）抛 "cannot get property X without
			// inject"。v0.3 只走 ctx.get 所以没炸；M1 加了 ?? ctx.X 回退后触发
			// 守卫。apply 与设置页读取的服务必须全部声明。
			inject: ["sessions", "uiSession", "slots"],
			apply
		};
		return module.exports;
	}
});
