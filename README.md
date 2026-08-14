# dsh-vision-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**Keep DeepSeek as the brain — paste images anyway.** Zero-config free vision for text-only DeepSeek on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-vision-proxy"><img src="https://img.shields.io/npm/v/dsh-vision-proxy?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml"><img src="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml/badge.svg" alt="CI (Node 22/24)" /></a>
  <img src="https://img.shields.io/badge/tests-11%20passed-2EA44F?style=flat-square" alt="11 tests" />
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=22.19" />
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy"><img src="https://img.shields.io/github/stars/Flyvhidbwo/dsh-vision-proxy?style=flat-square" alt="GitHub stars" /></a>
</p>

## Why this exists

DeepSeek Harness natively gates image attachments on the selected model's declared `inputModalities`. DeepSeek's chat-completions line is text-only, so attaching an image with DeepSeek selected is rejected by design. Tool-based vision plugins exist, but **GUI image attachments still fail** with a text-only model.

This plugin closes that gap: it registers a new provider route (`deepseek-vision`) that wraps the real DeepSeek adapter, claims image input (so the preflight admits attachments), and **transcribes every attached image to text in the request stream** before delegating to DeepSeek. The conversation is still answered by DeepSeek; vision is an add-on.

```
user attaches image ──▶ deepseek-vision route ──▶ transcribe via VLM (OCR + layout + details)
                          │                          │
                          ▼                          ▼
                   DeepSeek answers ◀── text-only conversation (images replaced by [图片转译] text)
```

## Features

- **Free out of the box.** No API key, no account, no configuration: a built-in registration-free anonymous endpoint (OVHcloud AI Endpoints, `Qwen2.5-VL-72B-Instruct`, ~2 req/min/IP) is the effective default when no key is set.
- **Multi-model, multi-provider.** Any OpenAI-compatible VLM endpoint works — DashScope/Qwen, QwenCloud (international), Zhipu, OpenRouter, local Ollama, or your own. Each `fallbackModels` entry can carry its **own** `baseURL`/`model`, so one install can chain providers.
- **Automatic upgrade when you have a key.** Export `VISION_API_KEY` / `DASHSCOPE_API_KEY` and the paid fast path (DashScope `qwen3.7-flash` — fast, cheap, no rate limit) is used automatically; keyless entries are skipped, not failed.
- **Install-time consent prompt.** `postinstall` asks whether you have a VLM API key (no → free default; yes → fast path guidance). Non-interactive environments skip the prompt; the install never hangs. A PRIVACY NOTICE is printed at startup naming the active endpoint.
- **Fallback chain with classified errors.** `rate_limit` / `quota` / `auth` / `region` / `model_not_found` / `context_too_large` / `http` are classified with actionable hints; HTTP 429 honors `Retry-After` once (capped at 15 s).
- **Content-hash cache.** Transcriptions are cached by the SHA-256 of the image bytes (in-process, capped at 200) — the same image is transcribed at most once per process, even re-attached or in another conversation.
- **Auto-downscale (optional).** With `sharp` installed, images above `maxImagePixels` are downscaled before transcription — fewer image tokens, much faster on big screenshots. Degrades gracefully without sharp.
- **`read_image` compatible.** The native `read_image` tool also works on this route (its capability gate reads the same model info).

## Supported models & providers

One config (`baseURL` + `model`, optionally `apiKey`) covers every backend:

| Scenario | baseURL | model | Notes |
|---|---|---|---|
| **Default — free** | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `Qwen2.5-VL-72B-Instruct` | Anonymous, no account/key, ~2 req/min/IP, best-effort. Built-in fallback; the effective default with no key |
| **DashScope (China)** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-flash` / `qwen3-vl-flash` | Cheap, fast, no rate limit. Keys: `sk-ws-…` from [platform.qianwenai.com](https://platform.qianwenai.com) or `sk-…` from [bailian.console.aliyun.com](https://bailian.console.aliyun.com). Auto-enabled as fallback when a key is present |
| **QwenCloud (intl.)** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` etc. | International variant |
| **Zhipu (free tier)** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | Free tier, still needs a (free) Zhipu API key |
| **Local Ollama** | `http://localhost:11434/v1` | `qwen3-vl:4b` etc. | No key; images never leave your machine |
| **Anything OpenAI-compatible** | your endpoint | your model | OpenRouter, Ark, vLLM, gateways… the plugin only speaks `/chat/completions` |

**Key resolution order**: config `apiKey` → `$VISION_API_KEY` → `$DASHSCOPE_API_KEY`. Anonymous endpoints (`anonymous: true`) need no key; keyless non-anonymous entries are skipped automatically.

## Quick start

```sh
dsh plugin --profile web add dsh-vision-proxy   # or: github:Flyvhidbwo/dsh-vision-proxy
```

During install you are asked one question — *do you have a VLM API key?* Answer `N` (default) for the free zero-config path, or `y` for guidance to the fast paid path. Restart `dsh web`, pick **DeepSeek + 自动识图** in the model selector, then paste an image into any conversation — it just works.

> pnpm ≥ 10 blocks dependency build scripts by default. If the install says "Ignored build scripts", run `pnpm approve-builds` once (select `dsh-vision-proxy`) or add `allowBuilds: dsh-vision-proxy: true` to the profile's `pnpm-workspace.yaml`. Without approval the prompt is skipped and the free default applies.

## Live demo: mid-task autonomous vision

During a deployment-check task, the agent's tooling returned a screenshot path; the model **autonomously decided to look at it** and called `view_image` — the proxy transcribed the image through the VLM, and the model continued its analysis on the resulting text.

![Mid-task vision demo](assets/demo.png)

```
task: analyze the deploy report
  → tooling returns deploy-report.png (a file path)
  → model autonomously calls view_image("deploy-report.png", "read every line verbatim")
  → VLM transcribes (OCR + layout):
      "Deploy Report - 2026-08-13 22:47:12
       [ERROR] web-server: Connection refused: localhost:8080
       [ERROR] database: timeout after 5000ms
       [INFO ] retry 1/3 ...
       [ERROR] TLS handshake failed: cert expired (demo.local)
       [INFO ] rollback to release-2026.08.12
       exit code: 1"
  → model analyzes the failure from the text and answers
```

Two autonomous paths are covered: the `view_image` tool (any route, file paths & URLs) and image-block auto-transcription (on the `deepseek-vision` route — images you attach mid-conversation).

## Configuration

Bundle defaults (override in your profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-vision-proxy
      name: 'dsh-vision-proxy'
      config:
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        apiKey: ''            # or export VISION_API_KEY / DASHSCOPE_API_KEY
        model: qwen3.7-flash
        maxTokens: 4096
        timeoutMs: 120000
        maxImagePixels: 4000000
        marker: '[图片转译]'
        fallbackModels:
          - model: Qwen2.5-VL-72B-Instruct
            baseURL: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
            anonymous: true
```

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `deepseek-vision` | Route id shown in the model picker |
| `innerProvider` | `deepseek-official` | Existing adapter route to wrap |
| `baseURL` | DashScope compatible-mode | OpenAI-compatible VLM endpoint (any vendor, Ollama included) |
| `apiKey` | `''` | VLM key; falls back to `$VISION_API_KEY`, then `$DASHSCOPE_API_KEY` |
| `anonymous` | `false` | Skip the Authorization header (for registration-free endpoints) |
| `model` | `qwen3.7-flash` | Vision model id (e.g. `Qwen2.5-VL-72B-Instruct`, `qwen3-vl-flash`, `glm-4.6v-flash`, `qwen3-vl:4b`) |
| `maxTokens` | `4096` | VLM output cap (thinking models spend tokens on reasoning first) |
| `timeoutMs` | `120000` | VLM request timeout |
| `maxImagePixels` | `4000000` | Images above this are downscaled before transcription when `sharp` is installed (0 disables) |
| `marker` | `[图片转译]` | Marker prepended to each transcription |
| `fallbackModels` | `[OVH anonymous]` | Ordered fallback list `{model, baseURL?, apiKey?, anonymous?, timeoutMs?}` — each entry may point at a **different provider**; keyless non-anonymous entries are skipped |

> **Prefer `VISION_API_KEY` over writing the key into a patch file**: `dsh --profile <name> --dump-config` prints the composed config as-is, so a key in `cordis.patch.yml` appears in plaintext dumps.

## Behavior notes

- Only messages containing image blocks are touched; plain-text conversations hit DeepSeek with zero overhead.
- The request only fails after every chain entry failed, with one error listing each attempt.
- Transcription results are cached in-process by image content hash (never persisted).
- On startup the plugin logs a one-line summary — route id, wrapped provider, VLM model, endpoint, timeout, maxTokens, apiKey source and fallback list (the key itself is never logged), plus a PRIVACY NOTICE naming the active endpoint.
- Tested: 11 unit tests on Node 22 and 24 via GitHub Actions.

## Privacy

Transcription sends image bytes (base64, over HTTPS) to the configured VLM endpoint — **the image data leaves your machine** unless `baseURL` points at a local service (e.g. Ollama). Default with no key: the anonymous OVHcloud AI Endpoints. With a key: Alibaba Cloud Model Studio (DashScope). Nothing is stored beyond the harness's own attachment store. For sensitive images, use your own endpoint or a local model — or don't install.

## How it works (for plugin developers)

The plugin uses only public harness seams, stable on rc.6:

- `ctx.llm.registration(innerProvider).adapter` — reach the wrapped adapter;
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` — register a NEW route (no `DUPLICATE_ADAPTER` conflict);
- proxy `resolveModel` overrides `inputModalities` to `['text', 'image']` — satisfies the attachment preflight (`api-proxy`) and the `read_image` gate (`dsh-tool-fs`);
- proxy `stream` transcribes image blocks (shape `{ type: 'image', attachment }`, bytes via `ctx.get('attachments').readImage(ref)`) and `yield*`s the inner adapter's stream unchanged.

## License

MIT
