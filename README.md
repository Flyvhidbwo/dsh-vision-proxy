# dsh-vision-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**DeepSeek brain + automatic image transcription** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A provider-route proxy plugin: keep using DeepSeek (a text-only line) as the conversation brain, and attach images in the Web GUI anyway — every image is automatically transcribed to text through an OpenAI-compatible VLM (DashScope `qwen3.7-flash` by default) before the conversation reaches DeepSeek.

## Why

DeepSeek Harness natively gates image attachments on the selected model's declared `inputModalities`. DeepSeek's chat-completions line is text-only, so attaching an image with DeepSeek selected is rejected by design. Existing vision plugins add a `view_image` *tool* (works for file paths), but GUI image *attachments* still fail.

This plugin closes that gap: it registers a new provider route (`deepseek-vision`) that wraps the real DeepSeek adapter, claims image input (so the preflight admits attachments), and **transcribes every image to text in the request stream** before delegating to DeepSeek. The conversation is still answered by DeepSeek; vision is an add-on.

```
user attaches image ──▶ deepseek-vision route ──▶ transcribe via qwen3.7-flash (OCR+layout+details)
                          │                          │
                          ▼                          ▼
                   DeepSeek answers ◀── text-only conversation (images replaced by [图片转译] text)
```

## Live demo: mid-task autonomous vision

This is the exact flow this plugin enables. During a deployment-check task, the agent's tooling returned a screenshot path; the model **autonomously decided to look at it** and called `view_image` — the proxy transcribed the image through the VLM, and the model continued its analysis on the resulting text.

![Mid-task vision demo](assets/demo.png)

**Call chain**

```
task: analyze the deploy report
  → tooling returns deploy-report.png (a file path)
  → model autonomously calls view_image("deploy-report.png", "read every line verbatim")
  → qwen3.7-flash transcribes (OCR + layout):
      "Deploy Report - 2026-08-13 22:47:12
       [ERROR] web-server: Connection refused: localhost:8080
       [ERROR] database: timeout after 5000ms
       [INFO ] retry 1/3 ...
       [ERROR] TLS handshake failed: cert expired (demo.local)
       [INFO ] rollback to release-2026.08.12
       exit code: 1"
  → model analyzes the failure from the text and answers
```

Both autonomous paths are covered:

- **`view_image` tool (any route)**: whenever an image matters — a screenshot path a tool returned, an image URL, a chart, a UI mockup — the model calls it by itself instead of guessing.
- **Image-block auto-transcription (on the `deepseek-vision` route)**: images you attach mid-conversation are transcribed into the next request automatically, so DeepSeek always sees a text-only conversation.

## Install

**Recommended: straight from the npm registry** (no GitHub access needed, one command):

```sh
dsh plugin --profile web add dsh-vision-proxy
```

**Alternative: from GitHub** (requires GitHub connectivity):

```sh
dsh plugin --profile web add github:Flyvhidbwo/dsh-vision-proxy
```

Or via a plugin registry (Marisa / dshx): `dshx install dsh-vision-proxy <url>`

No build step is involved: the plugin ships compiled `lib/` in the repo, so git installs work as-is (no `prepare` script, no pnpm `allowBuilds` authorization needed). The package declares `dsh.bundle`, so the install adds it to the profile's bundle layers automatically.

Then restart `dsh web`, open the model picker and select **DeepSeek + 自动识图 → DeepSeek-V4-Flash** (or any model the inner DeepSeek route exposes).

Requirements: `dsh` >= 0.1.0-rc.6, Node >= 22.19, and `pnpm` on PATH (the `dsh plugin` command forwards to pnpm).

> **Installing from a local folder** (e.g. `dsh plugin --profile web add /path/to/dsh-vision-proxy`) creates a `link:` dependency, and pnpm does not install a linked package's own dependencies — run `pnpm install` once inside the plugin folder afterwards (the only runtime dependency is `schemastery`).

## Configuration

Config lives in the plugin row (bundle default below; override in your profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-vision-proxy
      name: 'dsh-vision-proxy'
      config:
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        apiKey: ''            # leave empty to read environment variables — or no key at all (see below)
        model: qwen3.7-flash
        maxTokens: 2048
        timeoutMs: 60000
        marker: '[图片转译]'
        # Fallback chain: tried in order when the main model fails. The default
        # ships with a registration-free anonymous endpoint (OVHcloud, 2 req/min/IP),
        # so a fresh install works with ZERO API keys — slowly but surely.
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
| `model` | `qwen3.7-flash` | Vision model id (e.g. `qwen3-vl-flash`, `glm-4.6v-flash`, `qwen3-vl:4b` for local Ollama) |
| `maxTokens` | `2048` | VLM output cap |
| `timeoutMs` | `60000` | VLM request timeout |
| `marker` | `[图片转译]` | Marker prepended to each transcription |
| `fallbackModels` | `[OVH anonymous]` | Ordered fallback list `{model, baseURL?, apiKey?, anonymous?, timeoutMs?}` — each entry inherits the main config unless overridden; `anonymous: true` endpoints need no key |

### Overriding in your profile

```yaml
# e.g. $DSH_HOME/profiles/web/cordis.patch.yml
# NOTE: an id-targeted patch REPLACES the whole `config` object — it is not a
# deep merge — so repeat every key you want to keep.
- id: dsh-vision-proxy
  config:
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    apiKey: 'sk-…'           # or leave '' and export VISION_API_KEY instead
    model: qwen3.7-flash
    maxTokens: 2048
    timeoutMs: 60000
    marker: '[图片转译]'
```

> **Prefer `VISION_API_KEY` over writing the key into a patch file**: `dsh --profile <name> --dump-config` prints the composed config as-is, so a key stored in `cordis.patch.yml` appears in plaintext dumps.

### Endpoint notes

- **Qwen / DashScope (China)**: keep the default `baseURL` (`https://dashscope.aliyuncs.com/compatible-mode/v1`). Keys from [platform.qianwenai.com](https://platform.qianwenai.com) — general API keys are `sk-ws-…`, Token Plan keys are `sk-sp-…` — or from [bailian.console.aliyun.com](https://bailian.console.aliyun.com) (`sk-…`). `qwen3.7-flash` is multimodal and cheap.
- **QwenCloud (international)**: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
- **Zhipu**: `https://open.bigmodel.cn/api/paas/v4` + `glm-4.6v-flash` (free tier — still needs a (free) Zhipu API key).
- **OVHcloud anonymous (free, no key)**: `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` + `Qwen2.5-VL-72B-Instruct` with `anonymous: true` — registration-free, 2 requests/min/IP, best-effort. This is the built-in last-resort fallback.
- **Local Ollama**: `http://localhost:11434/v1` + any vision model, no key needed.

## Behavior notes

- Only messages containing image blocks are touched; plain-text conversations hit DeepSeek with zero overhead.
- **Fallback chain**: when the main model fails (rate limit, quota, auth, network…), `fallbackModels` entries are tried in order; the request only fails after all of them failed, with one error listing every attempt.
- **Content-hash cache**: transcriptions are cached by the SHA-256 of the image bytes (in-process, capped at 200), so the same image — even re-attached under a new attachment id or in another conversation — is transcribed at most once per process.
- **Classified errors**: failed VLM responses are classified (`rate_limit` / `quota` / `auth` / `region` / `model_not_found` / `context_too_large` / `http`) and the error carries an actionable hint; HTTP 429 honors `Retry-After` once (capped at 15 s) before giving up.
- `read_image` also works on this route (its capability gate reads the same model info).
- On startup the plugin logs a one-line summary — route id, wrapped provider, VLM model, endpoint, apiKey source and fallback list (the key itself is never logged). Check it to confirm the active VLM before sending images.

## How it works (for plugin developers)

The plugin uses only public harness seams, stable on rc.6:

- `ctx.llm.registration(innerProvider).adapter` — reach the wrapped adapter;
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` — register a NEW route (no `DUPLICATE_ADAPTER` conflict);
- proxy `resolveModel` overrides `inputModalities` to `['text', 'image']` — satisfies the attachment preflight (`api-proxy`) and the `read_image` gate (`dsh-tool-fs`);
- proxy `stream` transcribes image blocks (shape `{ type: 'image', attachment }`, bytes via `ctx.get('attachments').readImage(ref)`) and `yield*`s the inner adapter's stream unchanged.

## License

MIT
