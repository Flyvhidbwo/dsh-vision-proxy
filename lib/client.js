/**
 * dsh-vision-proxy — browser half: the 「识图代理」page under Settings.
 *
 * How this file is delivered (verified against dsh-desktop-runtime 0.2.1-rc.3):
 *   - package.json declares `dsh.client` (platform web) and exports "./client";
 *   - the host turns that declaration into a browser bundle served under
 *     /plugins/dsh-vision-proxy/client.js and loads it as a classic script;
 *   - THIS script only registers a factory in the module table; module bodies
 *     (style injection, apply) run when the host materializes the module;
 *   - the exposed module exports `apply(ctx)` and `inject` (cordis services).
 *
 * The page uses the settings domain contract:
 *   - `ctx.slots.inject("settings.section", …)` registers a navigation entry in
 *     the Settings shell once that slot is declared;
 *   - `ctx.configForms.get(entryId)` returns the shared form for the Host loader
 *     entry `dsh-vision-proxy`. dsh serves exactly the `.volatile()` fields of
 *     the active entry as a settings namespace, so `set`/`unset`/`mutate` write
 *     through to the profile's cordis.patch.yml and reach the running plugin
 *     through the volatile references — no restart, no YAML editing;
 *   - `ctx.configForms.whileServed([entryId], …)` keeps the page invisible on a
 *     host that does not serve that namespace.
 */
window.__ModuleLoader__.load({
	id: "dsh-vision-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { jsx, jsxs } = require("react/jsx-runtime");
		const React = require("react");

		/** Package name: module id and /plugins/<id>/ route segment. */
		const PKG = "dsh-vision-proxy";
		/** Dictionary namespace owned by this page. */
		const NS = "settings.visionProxy";
		/** Host loader entry id; also the settings namespace id. */
		const ENTRY_ID = "dsh-vision-proxy";
		/** Settings navigation id. */
		const SECTION_ID = "vision-proxy";
		/** Navigation order: account -10, general 0, models 10, built-in plugins 15. */
		const SECTION_ORDER = 20;

		// ── dictionaries ────────────────────────────────────────────────────
		const zh = {
			nav: "识图代理",
			title: "识图代理",
			intro: "图片转文本代理（dsh-vision-proxy）。保存后写入本 profile 的 cordis.patch.yml，立即对后续对话生效，无需重启。",
			loading: "正在读取当前配置…",
			unavailable: "本机没有暴露 “dsh-vision-proxy” 设置命名空间：插件行可能未启用。",
			readOnly: "本部署的设置为只读，写入会被拒绝。",
			overridden: "已覆盖",
			save: "保存",
			saving: "保存中…",
			saved: "已保存，下一轮对话生效。",
			saveFailed: "Host 拒绝了这些值，已保留待你修改。",
			resetAll: "恢复全部默认",
			clean: "没有改动",
			dirty: "已改 {n} 项",
			invalidNumber: "请填数字",
			invalidRange: "超出允许范围",
			secretSetHint: "已保存的密钥不会回显。留空 = 不修改；填入新值 = 覆盖。",
			secretClear: "清除已保存的密钥",
			numberUnset: "留空并保存 = 恢复默认",
			restartOnly: "以下配置需要重启后生效，仍写在 profile 的 cordis.patch.yml：providerId、innerProvider、autoLocalOllama、fallbackModels。",
			privacy: "隐私：开启转译后，图片字节会发送到上面配置的 VLM 端点；只在 baseURL 指向本机服务（如 Ollama）时才不出本机。",
			footer: "模型选择器里的 “DeepSeek + 自动识图” 路由即本插件；选它才能让纯文本大脑收到图片。",
			"field.baseURL": "接口 Base URL",
			"field.apiKey": "VLM 密钥",
			"field.model": "识图模型",
			"field.anonymous": "免鉴权端点",
			"field.maxTokens": "输出上限（token）",
			"field.timeoutMs": "请求超时（毫秒）",
			"field.maxImagePixels": "超过此像素数先降采样（0 = 关闭）",
			"field.keepAlive": "本机模型常驻时长",
			"field.marker": "文本标记",
			"field.failureMode": "失败策略",
			"field.abortWithSession": "随会话取消转译",
			"field.deepseekVision": "优先用 DeepSeek 官方识图模型",
			"field.deepseekVisionModel": "DeepSeek 识图模型",
			"field.nativeVisionPassThrough": "原生识图直通",
			"field.localOllamaModel": "Ollama 模型",
			"hint.baseURL": "会自动拼接 …/chat/completions；本机地址不受 20 秒匿名上限约束。",
			"hint.model": "百炼如 qwen3.7-flash；Ollama 如 qwen3-vl:8b。",
			"hint.anonymous": "公网免费端点会强制 20 秒超时且不重试；本机地址始终按本地处理。",
			"hint.maxTokens": "思考型模型会先花推理 token，建议 ≥4096。",
			"hint.timeoutMs": "本机冷启动可给到 300000。",
			"hint.keepAlive": "仅本机端点：Ollama 在此时间内保持模型常驻，避免每张图重新加载。留空则不发送该字段。",
			"hint.marker": "每条转译文本前的前缀，便于模型区分。",
			"hint.failureMode": "placeholder：本回合继续并标注失败原因；error：整回合失败。",
			"hint.abortWithSession": "默认关闭：已完成的一次推理不会因为会话层取消而被丢弃。",
			"hint.deepseekVision": "用 DEEPSEEK_API_KEY 调官方视觉模型转译，无需额外 key。",
			"hint.deepseekVisionModel": "官方默认 deepseek-v4-flash-vision-exp。",
			"hint.nativeVisionPassThrough": "选中的模型本身支持图片时直接透传，不再二次转译。",
			"hint.localOllamaModel": "留空 = 自动取本机 Ollama 报告的第一个视觉模型。",
		};
		const en = {
			nav: "Vision proxy",
			title: "Vision proxy",
			intro: "Image-to-text proxy (dsh-vision-proxy). Saving writes this profile's cordis.patch.yml and applies to the next turn — no restart.",
			loading: "Reading the current configuration…",
			unavailable: 'This host does not serve the "dsh-vision-proxy" settings namespace; the plugin row may be disabled.',
			readOnly: "This deployment stores settings read-only; edits are rejected.",
			overridden: "Overridden",
			save: "Save",
			saving: "Saving…",
			saved: "Saved; effective on the next turn.",
			saveFailed: "The host rejected these values; they were left for you to correct.",
			resetAll: "Reset all to defaults",
			clean: "No changes",
			dirty: "{n} field(s) changed",
			invalidNumber: "Enter a number",
			invalidRange: "Out of range",
			secretSetHint: "A stored key is never sent back. Leave empty to keep it, type a new value to replace it.",
			secretClear: "Clear the stored key",
			numberUnset: "Clear and save to restore the default",
			restartOnly: "These need a restart and still live in the profile's cordis.patch.yml: providerId, innerProvider, autoLocalOllama, fallbackModels.",
			privacy: "Privacy: with transcription on, image bytes go to the VLM endpoint above; images stay on this machine only when baseURL points at a local service (e.g. Ollama).",
			footer: 'The "DeepSeek + auto vision" route in the model picker is this plugin; select it so a text-only brain receives images.',
			"field.baseURL": "Endpoint base URL",
			"field.apiKey": "VLM API key",
			"field.model": "Vision model",
			"field.anonymous": "Anonymous endpoint",
			"field.maxTokens": "Output cap (tokens)",
			"field.timeoutMs": "Request timeout (ms)",
			"field.maxImagePixels": "Downscale above (pixels, 0 = off)",
			"field.keepAlive": "Local model keep-alive",
			"field.marker": "Text marker",
			"field.failureMode": "Failure mode",
			"field.abortWithSession": "Abort with the session",
			"field.deepseekVision": "Prefer DeepSeek's vision model",
			"field.deepseekVisionModel": "DeepSeek vision model",
			"field.nativeVisionPassThrough": "Native vision pass-through",
			"field.localOllamaModel": "Ollama model",
			"hint.baseURL": "…/chat/completions is appended; loopback URLs are not subject to the 20 s anonymous cap.",
			"hint.model": "e.g. qwen3.7-flash at DashScope, qwen3-vl:8b on Ollama.",
			"hint.anonymous": "Public free endpoints are capped at 20 s and never retried; loopback is always local.",
			"hint.maxTokens": "Thinking models spend this on reasoning first; keep it ≥ 4096.",
			"hint.timeoutMs": "300000 is reasonable for a cold local model.",
			"hint.keepAlive": "Loopback only: Ollama keeps the model resident for this long. Empty sends no field.",
			"hint.marker": "Prefix on every transcription so the brain can tell it apart.",
			"hint.failureMode": "placeholder keeps the turn alive with the reason; error fails the whole turn.",
			"hint.abortWithSession": "Off by default: a finished inference is not thrown away by a session abort.",
			"hint.deepseekVision": "Transcribe with the official vision model through DEEPSEEK_API_KEY — no extra key.",
			"hint.deepseekVisionModel": "Official default: deepseek-v4-flash-vision-exp.",
			"hint.nativeVisionPassThrough": "Models that already accept images are passed straight through.",
			"hint.localOllamaModel": "Empty picks the first vision-capable model the local Ollama reports.",
		};

		/**
		 * Editable fields. Keys must match the Host Config's volatile fields
		 * byte-for-byte: a volatile field is the only thing dsh serves as a
		 * settings namespace entry.
		 */
		const FIELDS = [
			{ key: "baseURL", kind: "text", placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
			{ key: "apiKey", kind: "secret" },
			{ key: "model", kind: "text", placeholder: "qwen3.7-flash" },
			{ key: "anonymous", kind: "boolean" },
			{ key: "deepseekVision", kind: "boolean" },
			{ key: "deepseekVisionModel", kind: "text", placeholder: "deepseek-v4-flash-vision-exp" },
			{ key: "nativeVisionPassThrough", kind: "boolean" },
			{ key: "failureMode", kind: "select", options: ["placeholder", "error"] },
			{ key: "maxTokens", kind: "number", min: 1, max: 32768, step: 1 },
			{ key: "timeoutMs", kind: "number", min: 1000, max: 300000, step: 1 },
			{ key: "maxImagePixels", kind: "number", min: 0, max: 100000000, step: 1 },
			{ key: "keepAlive", kind: "text", placeholder: "30m" },
			{ key: "localOllamaModel", kind: "text", placeholder: "" },
			{ key: "marker", kind: "text", placeholder: "[图片转译]" },
			{ key: "abortWithSession", kind: "boolean" },
		];
		const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((field) => [field.key, field]));

		// ── styles (module body, so HMR unload reclaims them) ───────────────
		const CSS_TAG = PKG + "/client.css";
		const CSS = [
			".dshvp{padding:2px 2px 28px;display:flex;flex-direction:column;gap:10px;",
			"max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dshvp h2{margin:0;font-size:18px;font-weight:600;line-height:26px}",
			".dshvp p{margin:0}",
			".dshvp .intro,.dshvp .hint,.dshvp .note,.dshvp .msg{color:var(--dsw-alias-label-tertiary)}",
			".dshvp .note{font-size:12px;line-height:18px}",
			".dshvp .field{display:flex;flex-direction:column;gap:4px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".dshvp .row{display:flex;align-items:center;gap:8px}",
			".dshvp .label{font-weight:500;flex:1 1 auto;min-width:0}",
			".dshvp .badge{flex:0 0 auto;padding:0 6px;border-radius:4px;font-size:11px;line-height:18px;",
			"color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-fill-l3,rgba(77,107,254,.12))}",
			".dshvp input[type=text],.dshvp input[type=password],.dshvp input[type=number],.dshvp select{",
			"box-sizing:border-box;width:100%;max-width:460px;height:30px;padding:0 8px;font:inherit;color:inherit;",
			"background:var(--dsw-alias-fill-l2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}",
			".dshvp input[type=checkbox]{width:16px;height:16px;margin:0}",
			".dshvp .reset{font:inherit;font-size:12px;color:var(--dsw-alias-state-business-primary,#4d6bfe);background:none;border:0;padding:0;cursor:pointer}",
			".dshvp .foot{display:flex;align-items:center;gap:12px;padding-top:14px;flex-wrap:wrap}",
			".dshvp .btn{height:30px;padding:0 14px;border-radius:6px;border:0;font:inherit;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;cursor:pointer}",
			".dshvp .btn.ghost{background:var(--dsw-alias-fill-l3,rgba(0,0,0,.06));color:inherit}",
			".dshvp .btn[disabled]{opacity:.5;cursor:default}",
			".dshvp .err{color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".dshvp fieldset{margin:0;padding:0;border:0}",
		].join("");
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PKG;
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── draft helpers ───────────────────────────────────────────────────
		const hasOwn = (object, key) => object !== undefined && object !== null && Object.prototype.hasOwnProperty.call(object, key);

		/** Host value → editor value. Secrets never arrive, so they stay empty. */
		function toDraft(field, value) {
			if (field.kind === "boolean") return value === true;
			if (field.kind === "number") return value === undefined || value === null ? "" : String(value);
			return value === undefined || value === null ? "" : String(value);
		}

		/** Editor value → { value } | { unset } | { invalid }. */
		function fromDraft(field, draft) {
			if (field.kind === "boolean") return { value: draft === true };
			if (field.kind === "number") {
				const text = String(draft ?? "").trim();
				if (text === "") return { unset: true };
				const value = Number(text);
				if (!Number.isFinite(value)) return { invalid: "invalidNumber" };
				if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
					return { invalid: "invalidRange" };
				}
				return { value };
			}
			const text = draft === undefined || draft === null ? "" : String(draft);
			return { value: text };
		}

		// ── the page component ──────────────────────────────────────────────
		/** Settings section: a small form over the Host entry's volatile config. */
		function VisionProxySection(props) {
			const t = props.t;
			const form = props.form;
			const useForm = props.useForm;
			// Stable snapshot reference: useSyncExternalStore re-renders only on change.
			const snapshot = useForm((state) => state);

			const [drafts, setDrafts] = React.useState({});
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(undefined);
			const [notice, setNotice] = React.useState(undefined);

			const revision = snapshot.revision;
			React.useEffect(() => {
				// Another tab, a YAML edit, or a rejected write changed the document:
				// drop local drafts so stale values are never written back.
				setDrafts({});
				setError(undefined);
				setNotice(undefined);
			}, [revision]);

			if (snapshot.status === "loading" && snapshot.value === undefined) {
				return jsx("div", { className: "dshvp", children: jsx("p", { className: "intro", children: t("loading") }) });
			}
			if (snapshot.value === undefined) {
				return jsx("div", { className: "dshvp", children: jsx("p", { className: "msg", children: t("unavailable") }) });
			}

			const value = snapshot.value ?? {};
			const user = snapshot.user ?? {};
			const readOnly = snapshot.writable !== true;

			const currentDraft = (field) => (hasOwn(drafts, field.key) ? drafts[field.key] : toDraft(field, value[field.key]));
			const edit = (field, raw) => {
				setNotice(undefined);
				setError(undefined);
				setDrafts((previous) => ({ ...previous, [field.key]: raw }));
			};

			const dirty = Object.keys(drafts).filter((key) => {
				const field = FIELD_BY_KEY[key];
				if (field === undefined) return false;
				if (field.kind === "secret") return String(drafts[key] ?? "") !== "";
				const next = fromDraft(field, drafts[key]);
				if (next.invalid !== undefined) return true;
				if (next.unset === true) return true;
				if (field.kind === "boolean") return next.value !== (value[key] === true);
				if (field.kind === "number") return next.value !== value[key];
				return next.value !== (value[key] === undefined ? "" : String(value[key]));
			});

			const save = async () => {
				if (busy || readOnly || dirty.length === 0) return;
				const ops = [];
				for (const key of dirty) {
					const field = FIELD_BY_KEY[key];
					const parsed = fromDraft(field, drafts[key]);
					if (parsed.invalid !== undefined) {
						setError(t(parsed.invalid) + " · " + t("field." + key));
						return;
					}
					ops.push(parsed.unset === true
						? { op: "unset", path: [key] }
						: { op: "set", path: [key], value: parsed.value });
				}
				setBusy(true);
				setError(undefined);
				setNotice(undefined);
				try {
					// One atomic mutation: the host validates the whole config and rejects
					// with the latest document on any conflict, so drafts survive.
					const accepted = await form.mutate(ops);
					if (accepted === true) {
						setDrafts({});
						setNotice(t("saved"));
					} else {
						setError(t("saveFailed"));
					}
				} catch (thrown) {
					setError(thrown instanceof Error ? thrown.message : String(thrown));
				} finally {
					setBusy(false);
				}
			};

			const resetAll = async () => {
				const keys = FIELDS.filter((field) => hasOwn(user, field.key)).map((field) => field.key);
				if (keys.length === 0 || busy || readOnly) return;
				setBusy(true);
				setError(undefined);
				setNotice(undefined);
				try {
					const accepted = await form.mutate(keys.map((key) => ({ op: "unset", path: [key] })));
					if (accepted === true) {
						setDrafts({});
						setNotice(t("saved"));
					} else setError(t("saveFailed"));
				} catch (thrown) {
					setError(thrown instanceof Error ? thrown.message : String(thrown));
				} finally {
					setBusy(false);
				}
			};

			const renderControl = (field) => {
				const draft = currentDraft(field);
				const disabled = readOnly || busy;
				if (field.kind === "boolean") {
					return jsx("input", {
						type: "checkbox",
						checked: draft === true,
						disabled,
						onChange: (event) => edit(field, event.target.checked),
					});
				}
				if (field.kind === "select") {
					return jsx("select", {
						value: String(draft ?? ""),
						disabled,
						onChange: (event) => edit(field, event.target.value),
						children: (field.options ?? []).map((option) => jsx("option", { value: option, children: option }, option)),
					});
				}
				if (field.kind === "secret") {
					return jsx("input", {
						type: "password",
						value: String(draft ?? ""),
						disabled,
						placeholder: t("secretSetHint"),
						autoComplete: "new-password",
						onChange: (event) => edit(field, event.target.value),
					});
				}
				return jsx("input", {
					type: field.kind === "number" ? "number" : "text",
					value: String(draft ?? ""),
					disabled,
					placeholder: field.placeholder ?? "",
					min: field.min,
					max: field.max,
					step: field.step,
					onChange: (event) => edit(field, event.target.value),
				});
			};

			const renderField = (field) => {
				const hintKey = "hint." + field.key;
				const hint = t(hintKey) === hintKey ? undefined : t(hintKey);
				return jsxs("div", {
				className: "field",
				children: [
					jsxs("div", {
						className: "row",
						children: [
							jsx("label", { className: "label", children: t("field." + field.key) }),
							hasOwn(user, field.key)
								? jsx("span", { className: "badge", children: t("overridden") })
								: null,
							hasOwn(user, field.key) && !readOnly
								? jsx("button", {
									type: "button",
									className: "reset",
									title: t("resetAll"),
									disabled: busy,
									onClick: () => {
										setBusy(true);
										form.mutate([{ op: "unset", path: [field.key] }]).then((accepted) => {
											setBusy(false);
											if (accepted !== true) setError(t("saveFailed"));
											else setNotice(t("saved"));
										}, (thrown) => {
											setBusy(false);
											setError(thrown instanceof Error ? thrown.message : String(thrown));
										});
									},
									children: "↺",
								})
								: null,
						],
					}),
					renderControl(field),
					jsx("p", {
						className: "hint",
						children: field.kind === "secret"
							? t("secretSetHint")
							: field.kind === "number"
								? [hint, t("numberUnset")].filter((part) => part !== undefined).join(" · ")
								: hint,
					}),
				],
			}, field.key);
			};

			return jsxs("div", {
				className: "dshvp",
				children: [
					jsx("h2", { children: t("title") }),
					jsx("p", { className: "intro", children: t("intro") }),
					readOnly ? jsx("p", { className: "msg", children: t("readOnly") }) : null,
					jsxs("fieldset", {
						disabled: readOnly,
						children: FIELDS.map(renderField),
					}),
					error !== undefined ? jsx("p", { className: "err", children: error }) : null,
					notice !== undefined ? jsx("p", { className: "msg", children: notice }) : null,
					jsxs("div", {
						className: "foot",
						children: [
							jsx("button", {
								type: "button",
								className: "btn",
								disabled: busy || readOnly || dirty.length === 0,
								onClick: save,
								children: busy ? t("saving") : t("save"),
							}),
							jsx("button", {
								type: "button",
								className: "btn ghost",
								disabled: busy || readOnly || Object.keys(user).length === 0,
								onClick: resetAll,
								children: t("resetAll"),
							}),
							jsx("span", {
								className: "msg",
								children: dirty.length > 0 ? t("dirty").replace("{n}", String(dirty.length)) : t("clean"),
							}),
						],
					}),
					jsx("p", { className: "note", children: t("restartOnly") }),
					jsx("p", { className: "note", children: t("privacy") }),
					jsx("p", { className: "note", children: t("footer") }),
				],
			});
		}

		// ── plugin face ─────────────────────────────────────────────────────
		const inject = ["slots", "locale", "configForms"];

		/**
		 * Mount the Settings page.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			injectStyles();
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-vision-proxy: settings dictionaries");

			// Only register the page while the host actually serves the namespace:
			// a deployment without this entry shows no trace of the page.
			ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => {
				const form = ctx.configForms.get(ENTRY_ID);
				const useForm = (selector) => React.useSyncExternalStore(
					(listener) => form.subscribe(listener),
					() => selector(form.getSnapshot()),
				);
				const disposePage = ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: SECTION_ORDER,
					label: () => t("nav"),
					locale: NS,
					inject: () => ({ form, useForm }),
				}, VisionProxySection));
				return () => {
					disposePage();
					void form.dispose?.();
				};
			}), "dsh-vision-proxy: settings page");
		}

		exports.apply = apply;
		exports.inject = inject;
		/** Field table exposed for tests/tooling (not part of the dsh contract). */
		exports._fields = FIELDS;
		return module.exports;
	}
});
