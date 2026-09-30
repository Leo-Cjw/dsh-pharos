// dsh-pharos — browser half.
//
// 法罗斯灯塔 —— 你不在时替你守望 DSH：
//   1. "需要你操作" — a pending interaction appears (approval / plan-review /
//      question via ctx.uiSession pending interactions) -> toast + distinct
//      chime + "🔔 需要你 ·" tab-title marker; 10 分钟后仍未处理则补发一次
//      （"仍未处理"）。当前会话 + 页面前台时静默只留标记（currentQuiet）。
//   2. "回复完成" — a session's run ends (running true->false, or
//      completionUnread) while you are not looking -> toast + chime + 耗时小结。
//   3. 通知不可用（权限被拒 / 窗口未聚焦）时，以 ⏳ 标题闪烁兜底 6 秒。
//   4. Click on a toast focuses the DSH window and best-effort opens the
//      owning conversation.
//   5. Config persisted in localStorage + `window.__dshPharos` console API
//      (config / setConfig / resetConfig / test / debug).
//
// Design notes (lessons from the community dsh-notify-me / dsh-turn-notify /
// dsh-my-notify / dsh-session-notify plugins):
//   - `sessions` is a hard-gated service (always present in this runtime);
//     `uiSession` is read lazily via ctx.get() so the entry never sticks in
//     "pending (waiting for services)" and survives service replacement.
//   - Error / interrupt / limit events live in the host-side turn event
//     stream and are NOT derivable from the browser-side sessionStatus store
//     ({ running, pendingInteraction, completionUnread } only) — out of scope
//     for this browser-only half.
//   - Zero host logic; zero dependency requires inside the factory.
window.__ModuleLoader__.load({
	id: "dsh-pharos",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const API_KEY = "__dshPharos";
		const CONFIG_KEY = "dshPharos.config";
		const MARKER = "🔔 需要你 · ";
		const BLINK_PREFIX = "⏳ ";
		const BLINK_TICKS = 12;       // 12 x 500ms = 6s

		const DEFAULT_CONFIG = {
			enabled: true,          // master switch (kills toast, sound, marker)
			toast: true,            // system notification
			sound: true,            // WebAudio chime
			volume: 0.5,            // chime volume 0..1
			autoFocus: true,        // click on toast brings DSH to front
			attentionHiddenOnly: false, // "需要你": only when page hidden/background
			doneHiddenOnly: true,   // "回复完成": only when page hidden/background
			currentQuiet: true,     // "需要你" on the session you are looking at: marker only, no toast/sound while page focused
			minIntervalMs: 6000,    // throttle per session for "完成" alerts
			reAlertMs: 600000,      // unanswered "需要你" re-alert delay (once per request)
			blinkFallback: true,    // ⏳ title blink when notifications unavailable
			language: "auto"        // 'auto' | 'zh' | 'en'
		};

		const TEXT = {
			zh: {
				attentionTitle: "需要你操作",
				attentionBody: (sessionTitle, detail, reAlert) =>
					`会话「${sessionTitle}」需要你操作${detail ? `：${detail}` : ""}${reAlert ? "（仍未处理）" : ""}。`,
				doneTitle: "任务已完成",
				doneBody: (sessionTitle, summary) =>
					`会话「${sessionTitle}」已完成${summary ? ` · ${summary}` : ""}，点击回到 DSH 查看。`,
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
		const state = { config: { ...DEFAULT_CONFIG } };
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
				} else {
					note(880, 0, 0.16, 0.12);     // A5
					note(1318.51, 0.14, 0.26, 0.12); // E6
				}
				setTimeout(() => ac.close().catch(() => {}), 900);
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

		// ---- deliver ----
		function pageFocused() {
			try { return typeof document !== "undefined" && document.hasFocus(); } catch { return true; }
		}
		function focusWindow() { try { window.focus(); } catch { /* ignore */ } }
		function openSession(sessionId) {
			try {
				const session = bindings.sessions.binding?.(sessionId)?.session;
				if (session && typeof session.open === "function") session.open();
			} catch { /* best effort */ }
		}
		function deliver(kind, sessionId, detail, opts) {
			const cfg = state.config;
			if (!cfg.enabled) return;
			opts = opts ?? {};
			const t = TEXT[language()];
			const reAlert = opts.reAlert === true;
			let title = kind === "attention" ? t.attentionTitle : t.doneTitle;
			let body = kind === "attention"
				? t.attentionBody(sessionTitle(sessionId), detail, reAlert)
				: t.doneBody(sessionTitle(sessionId), opts.summary);
			let toasting = false;
			if (cfg.toast && livePermission() !== "denied" && typeof Notification !== "undefined") {
				try {
					const n = new Notification(title, { body, tag: `dsh-pharos:${sessionId}:${kind}`, silent: true });
					n.onclick = () => {
						if (cfg.autoFocus) focusWindow();
						if (kind === "attention") openSession(sessionId);
						try { n.close(); } catch { /* ignore */ }
					};
					toasting = true;
				} catch { toasting = false; }
			}
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

		function scheduleReAlert(key, sessionId, interaction) {
			const cfg = state.config;
			if (!cfg.enabled || cfg.reAlertMs <= 0) return;
			if (track.reAlertTimers.has(key)) return;
			const timerId = setTimeout(() => {
				track.reAlertTimers.delete(key);
				if (track.pendingKeys.has(key)) {
					deliver("attention", sessionId, pendingDetail(interaction), { reAlert: true });
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
			deliver("attention", id, pendingDetail(interaction), {});
			scheduleReAlert(key, id, interaction);
		}
		function notifyDone(id, durationMs) {
			const cfg = state.config;
			const summary = durationMs >= 0 ? TEXT[language()].duration(durationMs) : "";
			deliver("done", id, "", { summary });
		}

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
					notifyDone(id, durationMs);
					continue;
				}
				if (!st.completionUnread && wasUnread) track.prevUnread.delete(id);

				const wasRunning = track.prevRunning.get(id) ?? false;
				if (wasRunning && !st.running) {
					track.runStarted.delete(id);
					if (!cfg.doneHiddenOnly || !pageActive) {
						const now = Date.now();
						const last = track.lastDoneAt.get(id) ?? 0;
						if (now - last >= cfg.minIntervalMs) {
							track.lastDoneAt.set(id, now);
							notifyDone(id, durationMs);
						}
					}
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
		function installApi() {
			window[API_KEY] = {
				version: "0.3.0",
				config: () => ({ ...state.config }),
				setConfig: (partial) => setConfig(partial),
				resetConfig: () => resetConfig(),
				test: (kind) => {
					const k = kind === "attention" ? "attention" : "done";
					const sid = currentSessionId() ?? "console";
					if (k === "attention") deliver("attention", sid, TEXT[language()].testBody, {});
					else deliver("done", sid, "", { summary: TEXT[language()].duration(12345) });
				},
				debug: () => ({
					config: { ...state.config },
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
		function apply(ctx) {
			loadConfig();
			ensurePermission();
			installApi();

			const sessions = ctx.get?.("sessions") ?? ctx.sessions;
			if (!sessions) return;
			let uiSession = ctx.get?.("uiSession") ?? ctx.uiSession;

			const rebind = () => {
				const next = ctx.get?.("uiSession") ?? ctx.uiSession;
				if (next && next !== uiSession) uiSession = next;
			};
			try { ctx.effect(() => () => { rebind(); }); } catch { /* root effect may not exist in all hosts */ }

			const statusStore = uiSession?.sessionStatus;
			bindings = { ctx, uiSession, statusStore, sessions };
			if (!statusStore) return; // 本运行时必有；缺时安静降级

			const unsub = statusStore.subscribe(tick);
			try {
				ctx.effect(() => () => {
					try { unsub(); } catch { /* already removed */ }
					stopMarkerTimer();
					stopBlink();
					for (const key of [...track.reAlertTimers.keys()]) clearReAlert(key);
					if (markerActive) {
						markerActive = false;
						if (markerBase) document.title = markerBase;
					}
				});
			} catch { /* ignore */ }

			tick();
		}

		module.exports = {
			name: "dsh-pharos",
			inject: ["sessions"],
			apply
		};
		return module.exports;
	}
});