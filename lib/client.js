/**
 * dsh-vision-proxy — browser half: the 「识图代理」page under Settings.
 *
 * Layout: a mode switch first, then only the controls that mode needs.
 *   - deepseek: the official deepseek-flash call, which reuses DEEPSEEK_API_KEY
 *     and https://api.deepseek.com — zero configuration.
 *   - custom: an OpenAI-compatible VLM endpoint or a local Ollama, which is
 *     where the endpoint/model/timeout fields become relevant.
 * Advanced knobs (token cap, pixels, failure policy, marker, …) live in one
 * collapsible section so the default path stays two clicks long.
 *
 * Delivery contract (verified against dsh-desktop-runtime 0.2.1-rc.3):
 * package.json declares `dsh.client` + `exports["./client"]`; the host serves
 * this file under /plugins and executes it as a classic script that only
 * registers a factory. The exported module face is `{ apply, inject }`.
 *
 * Data plane: `ctx.configForms.get("dsh-vision-proxy")` returns the shared form
 * for this Host entry (dsh serves the entry's `.volatile()` fields as a
 * settings namespace and persists writes into the profile's cordis.patch.yml).
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
		/** Built-in defaults that tell "custom configured" from "untouched". */
		const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
		const DEFAULT_MODEL = "qwen3.7-flash";
		const DEFAULT_DEEPSEEK_VISION_MODEL = "deepseek-flash";
		const MODE_DEEPSEEK = "deepseek";
		const MODE_CUSTOM = "custom";

		// ── dictionaries ────────────────────────────────────────────────────
		const zh = {
			nav: "识图代理",
			title: "识图代理",
			intro: "为纯文本模型补上识图能力：图片先转译成文字，再交给 DeepSeek 作答。设置保存后下一轮对话立即生效。",
			loading: "正在读取当前配置…",
			unavailable: "本机没有暴露 dsh-vision-proxy 设置命名空间：插件行可能未启用。",
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
			numberUnset: "留空并保存 = 恢复默认",
			restartOnly: "以下配置需要重启后生效，仍写在 profile 的 cordis.patch.yml：providerId、innerProvider、autoLocalOllama、fallbackModels。",
			privacy: "隐私：开启转译后，图片字节会发送到所用的识图端点；默认的 DeepSeek 官方识图会把图片发到 api.deepseek.com。仅本机 Ollama 模式完全不出本机。",
			footer: "模型选择器里的「DeepSeek + 自动识图」路由才是本插件的入口；选它才能让纯文本大脑收到图片。",
			modeTitle: "识图方式",
			modeDeepseek: "DeepSeek 官方识图",
			modeDeepseekBadge: "推荐 · 零配置",
			modeDeepseekDesc: "自动使用 deepseek-flash，复用你的 DEEPSEEK_API_KEY 与 api.deepseek.com，无需填写任何配置。",
			modeCustom: "自定义 VLM 端点",
			modeCustomDesc: "使用你自己的 OpenAI 兼容端点（百炼 / 智谱 / OpenRouter 等）或本机 Ollama。",
			deepseekActive: "当前生效：官方 deepseek-flash（自动复用 DeepSeek Key 与地址）",
			customHint: "自定义模式：下面填写你的端点信息；填本机地址（如 http://localhost:11434/v1）时自动按本地处理，不受 20 秒匿名限制。",
			advanced: "高级选项",
			"field.source": "识图方式",
			"field.deepseekVisionModel": "官方识图模型",
			"field.baseURL": "接口 Base URL",
			"field.apiKey": "VLM 密钥",
			"field.model": "识图模型",
			"field.anonymous": "免鉴权端点",
			"field.localOllamaModel": "Ollama 模型",
			"field.maxTokens": "输出上限（token）",
			"field.timeoutMs": "请求超时（毫秒）",
			"field.maxImagePixels": "超过此像素数先降采样（0 = 关闭）",
			"field.keepAlive": "本机模型常驻时长",
			"field.failureMode": "失败策略",
			"field.nativeVisionPassThrough": "原生识图直通",
			"field.marker": "文本标记",
			"field.abortWithSession": "随会话取消转译",
			"hint.deepseekVisionModel": "默认 deepseek-flash；一般无需修改。",
			"hint.baseURL": "会自动拼接 …/chat/completions；本机地址不受 20 秒匿名上限约束。",
			"hint.model": "百炼如 qwen3.7-flash；Ollama 如 qwen3-vl:8b。",
			"hint.anonymous": "公网免费端点会强制 20 秒超时且不重试；本机地址始终按本地处理。",
			"hint.localOllamaModel": "留空 = 自动取本机 Ollama 报告的第一个视觉模型。",
			"hint.maxTokens": "思考型模型会先花推理 token，建议 ≥4096。",
			"hint.timeoutMs": "本机冷启动可给到 300000。",
			"hint.maxImagePixels": "0 = 不降采样。",
			"hint.keepAlive": "仅本机端点：Ollama 在此时间内保持模型常驻。留空则不发送该字段。",
			"hint.failureMode": "placeholder：本回合继续并标注失败原因；error：整回合失败。",
			"hint.nativeVisionPassThrough": "选中的模型本身支持图片时直接透传，不再二次转译。",
			"hint.marker": "每条转译文本前的前缀，便于模型区分。",
			"hint.abortWithSession": "默认关闭：已完成的一次推理不会因为会话层取消而被丢弃。",
		};
		const en = {
			nav: "Vision proxy",
			title: "Vision proxy",
			intro: "Image-to-text bridge for text-only models: images are transcribed first, then DeepSeek answers. Saves apply to the next turn.",
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
			numberUnset: "Clear and save to restore the default",
			restartOnly: "These need a restart and still live in the profile's cordis.patch.yml: providerId, innerProvider, autoLocalOllama, fallbackModels.",
			privacy: "Privacy: image bytes go to the configured vision endpoint; the default DeepSeek vision path sends them to api.deepseek.com. Only a local Ollama keeps images on this machine.",
			footer: 'Select the "DeepSeek + auto vision" route in the model picker — that is this plugin\'s entry.',
			modeTitle: "Transcription source",
			modeDeepseek: "DeepSeek official vision",
			modeDeepseekBadge: "Recommended · zero config",
			modeDeepseekDesc: "Uses deepseek-flash with your existing DEEPSEEK_API_KEY and api.deepseek.com. Nothing to fill in.",
			modeCustom: "Custom VLM endpoint",
			modeCustomDesc: "Your own OpenAI-compatible endpoint (DashScope, Zhipu, OpenRouter, …) or a local Ollama.",
			deepseekActive: "In effect: official deepseek-flash (reusing the DeepSeek key and endpoint)",
			customHint: "Custom mode: fill in your endpoint below. A loopback URL (e.g. http://localhost:11434/v1) is treated as local and exempt from the 20 s anonymous cap.",
			advanced: "Advanced options",
			"field.source": "Transcription source",
			"field.deepseekVisionModel": "Official vision model",
			"field.baseURL": "Endpoint base URL",
			"field.apiKey": "VLM API key",
			"field.model": "Vision model",
			"field.anonymous": "Anonymous endpoint",
			"field.localOllamaModel": "Ollama model",
			"field.maxTokens": "Output cap (tokens)",
			"field.timeoutMs": "Request timeout (ms)",
			"field.maxImagePixels": "Downscale above (pixels, 0 = off)",
			"field.keepAlive": "Local model keep-alive",
			"field.failureMode": "Failure mode",
			"field.nativeVisionPassThrough": "Native vision pass-through",
			"field.marker": "Text marker",
			"field.abortWithSession": "Abort with the session",
			"hint.deepseekVisionModel": "deepseek-flash by default; rarely needs changing.",
			"hint.baseURL": "…/chat/completions is appended; loopback URLs are not subject to the 20 s anonymous cap.",
			"hint.model": "e.g. qwen3.7-flash at DashScope, qwen3-vl:8b on Ollama.",
			"hint.anonymous": "Public free endpoints are capped at 20 s and never retried; loopback is always local.",
			"hint.localOllamaModel": "Empty picks the first vision-capable model the local Ollama reports.",
			"hint.maxTokens": "Thinking models spend this on reasoning first; keep it ≥ 4096.",
			"hint.timeoutMs": "300000 is reasonable for a cold local model.",
			"hint.maxImagePixels": "0 disables downscaling.",
			"hint.keepAlive": "Loopback only: Ollama keeps the model resident for this long. Empty sends no field.",
			"hint.failureMode": "placeholder keeps the turn alive with the reason; error fails the whole turn.",
			"hint.nativeVisionPassThrough": "Models that already accept images are passed straight through.",
			"hint.marker": "Prefix on every transcription so the brain can tell it apart.",
			"hint.abortWithSession": "Off by default: a finished inference is not thrown away by a session abort.",
		};

		/**
		 * Editable fields. Keys must match the Host Config's volatile fields
		 * byte-for-byte; `scope` decides where a field renders:
		 *   mode     — rendered as the source switch
		 *   custom   — only in custom mode
		 *   advanced — inside the collapsed advanced section
		 */
		const FIELDS = [
			{ key: "source", kind: "mode", scope: "mode", options: [MODE_DEEPSEEK, MODE_CUSTOM] },
			{ key: "deepseekVisionModel", kind: "text", scope: "advanced", placeholder: DEFAULT_DEEPSEEK_VISION_MODEL },
			{ key: "baseURL", kind: "text", scope: "custom", placeholder: DEFAULT_BASE_URL },
			{ key: "apiKey", kind: "secret", scope: "custom" },
			{ key: "model", kind: "text", scope: "custom", placeholder: DEFAULT_MODEL },
			{ key: "anonymous", kind: "boolean", scope: "custom" },
			{ key: "localOllamaModel", kind: "text", scope: "custom", placeholder: "" },
			{ key: "maxTokens", kind: "number", scope: "advanced", min: 1, max: 32768, step: 1 },
			{ key: "timeoutMs", kind: "number", scope: "advanced", min: 1000, max: 300000, step: 1 },
			{ key: "maxImagePixels", kind: "number", scope: "advanced", min: 0, max: 100000000, step: 1 },
			{ key: "keepAlive", kind: "text", scope: "advanced", placeholder: "30m" },
			{ key: "failureMode", kind: "select", scope: "advanced", options: ["placeholder", "error"] },
			{ key: "nativeVisionPassThrough", kind: "boolean", scope: "advanced" },
			{ key: "marker", kind: "text", scope: "advanced", placeholder: "[图片转译]" },
			{ key: "abortWithSession", kind: "boolean", scope: "advanced" },
		];
		const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((field) => [field.key, field]));

		// ── styles (module body, so HMR unload reclaims them) ───────────────
		const CSS_TAG = PKG + "/client.css";
		const CSS = [
			".dshvp{padding:2px 2px 28px;display:flex;flex-direction:column;gap:10px;",
			"max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dshvp h2{margin:0;font-size:18px;font-weight:600;line-height:26px}",
			".dshvp h3{margin:6px 0 0;font-size:14px;font-weight:600;line-height:22px}",
			".dshvp p{margin:0}",
			".dshvp .intro,.dshvp .hint,.dshvp .note,.dshvp .msg{color:var(--dsw-alias-label-tertiary)}",
			".dshvp .note{font-size:12px;line-height:18px}",
			".dshvp .modes{display:flex;gap:10px;flex-wrap:wrap}",
			".dshvp .mode{flex:1 1 280px;display:flex;flex-direction:column;gap:4px;padding:12px;cursor:pointer;",
			"background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;text-align:left;font:inherit;color:inherit}",
			".dshvp .mode[data-active=true]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);",
			"box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4d6bfe) inset;background:var(--dsw-alias-fill-l3,rgba(77,107,254,.08))}",
			".dshvp .mode-title{display:flex;align-items:center;gap:8px;font-weight:600}",
			".dshvp .badge{flex:0 0 auto;padding:0 6px;border-radius:4px;font-size:11px;line-height:18px;",
			"color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-fill-l3,rgba(77,107,254,.12))}",
			".dshvp .mode-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshvp .field{display:flex;flex-direction:column;gap:4px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".dshvp .row{display:flex;align-items:center;gap:8px}",
			".dshvp .label{font-weight:500;flex:1 1 auto;min-width:0}",
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
			".dshvp details{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px}",
			".dshvp summary{cursor:pointer;font-weight:500}",
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

		/**
		 * Resolve the effective mode from the stored config (same inference the
		 * host plugin applies, without environment visibility).
		 * @returns {"deepseek" | "custom"}
		 */
		function modeOf(value) {
			const source = value?.source;
			if (source === MODE_DEEPSEEK || source === MODE_CUSTOM) return source;
			const apiKey = value?.apiKey;
			if (typeof apiKey === "string" && apiKey !== "") return MODE_CUSTOM;
			const baseURL = value?.baseURL;
			if (typeof baseURL === "string" && baseURL !== "" && baseURL !== DEFAULT_BASE_URL) return MODE_CUSTOM;
			const model = value?.model;
			if (typeof model === "string" && model !== "" && model !== DEFAULT_MODEL) return MODE_CUSTOM;
			return MODE_DEEPSEEK;
		}

		// ── the page component ──────────────────────────────────────────────
		/** Settings section: mode switch + mode-scoped fields over the Host entry config. */
		function VisionProxySection(props) {
			const t = props.t;
			const form = props.form;
			const useForm = props.useForm;
			const snapshot = useForm((state) => state);

			const [drafts, setDrafts] = React.useState({});
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(undefined);
			const [notice, setNotice] = React.useState(undefined);

			const revision = snapshot.revision;
			React.useEffect(() => {
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

			// Draft mode wins so switching shows the right fields before saving.
			const draftMode = hasOwn(drafts, "source") ? drafts.source : undefined;
			const mode = draftMode === MODE_DEEPSEEK || draftMode === MODE_CUSTOM ? draftMode : modeOf(value);

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
				if (field.kind === "mode") return drafts[key] !== modeOf(value);
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
					if (field.kind === "mode") {
						ops.push({ op: "set", path: [key], value: drafts[key] });
						continue;
					}
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
								hasOwn(user, field.key) ? jsx("span", { className: "badge", children: t("overridden") }) : null,
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

			const renderModeCard = (target, titleKey, descriptionKey, badgeKey) => {
				const active = mode === target;
				return jsxs("button", {
					type: "button",
					className: "mode",
					"data-active": active ? "true" : undefined,
					"aria-pressed": active,
					disabled: readOnly || busy,
					onClick: () => edit(FIELD_BY_KEY.source, target),
					children: [
						jsxs("span", {
							className: "mode-title",
							children: [
								jsx("span", { children: t(titleKey) }),
								badgeKey === undefined ? null : jsx("span", { className: "badge", children: t(badgeKey) }),
							],
						}),
						jsx("span", { className: "mode-desc", children: t(descriptionKey) }),
					],
				}, target);
			};

			const customFields = FIELDS.filter((field) => field.scope === "custom");
			const advancedFields = FIELDS.filter((field) => field.scope === "advanced");

			return jsxs("div", {
				className: "dshvp",
				children: [
					jsx("h2", { children: t("title") }),
					jsx("p", { className: "intro", children: t("intro") }),
					readOnly ? jsx("p", { className: "msg", children: t("readOnly") }) : null,
					jsx("h3", { children: t("modeTitle") }),
					jsxs("div", {
						className: "modes",
						children: [
							renderModeCard(MODE_DEEPSEEK, "modeDeepseek", "modeDeepseekDesc", "modeDeepseekBadge"),
							renderModeCard(MODE_CUSTOM, "modeCustom", "modeCustomDesc", undefined),
						],
					}),
					mode === MODE_DEEPSEEK
						? jsx("p", { className: "msg", children: t("deepseekActive") })
						: jsxs("fieldset", {
							disabled: readOnly,
							children: [
								jsx("p", { className: "msg", children: t("customHint") }),
								customFields.map(renderField),
							],
						}),
					jsxs("details", {
						children: [
							jsx("summary", { children: t("advanced") }),
							jsx("fieldset", { disabled: readOnly, children: advancedFields.map(renderField) }),
						],
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
