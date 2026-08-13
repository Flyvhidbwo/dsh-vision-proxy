# dsh-vision-proxy

**DeepSeek 大脑 + 自动识图** · DeepSeek brain + automatic image transcription for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

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

## Install

```sh
dsh plugin add <this-repo-git-url>
# or via plugin registry (Marisa / dshx): dshx install dsh-vision-proxy <url>
```

Then restart `dsh web`, open the model picker and select **DeepSeek + 自动识图 → DeepSeek-V4-Flash** (or any model the inner DeepSeek route exposes).

Requirements: dsh >= 0.1.0-rc.6, Node >= 22.19.

## Configuration

Config lives in the plugin row (bundle default below; override in your profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-vision-proxy
      name: 'dsh-vision-proxy'
      config:
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        apiKey: ''            # 留空则读环境变量
        model: qwen3.7-flash
        maxTokens: 2048
        timeoutMs: 60000
        marker: '[图片转译]'
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

### Endpoint notes

- **DashScope (阿里云百炼)**: keep the default `baseURL`; key from [bailian.console.aliyun.com](https://bailian.console.aliyun.com). `qwen3.7-flash` is multimodal and cheap.
- **Zhipu (智谱)**: `https://open.bigmodel.cn/api/paas/v4` + `glm-4.6v-flash` (free tier available).
- **Local Ollama**: `http://localhost:11434/v1` + any vision model, no key needed.

## Behavior notes

- Only messages containing image blocks are touched; plain-text conversations hit DeepSeek with zero overhead.
- Transcription is cached per `attachmentId` (in-process, capped at 100), so each image is transcribed at most once per process.
- `read_image` also works on this route (its capability gate reads the same model info).
- If the VLM fails (network / quota / missing key), the request fails with a clear message instead of silently dropping the image.

## How it works (for plugin developers)

The plugin uses only public harness seams, stable on rc.6:

- `ctx.llm.registration(innerProvider).adapter` — reach the wrapped adapter;
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` — register a NEW route (no `DUPLICATE_ADAPTER` conflict);
- proxy `resolveModel` overrides `inputModalities` to `['text', 'image']` — satisfies the attachment preflight (`api-proxy`) and the `read_image` gate (`dsh-tool-fs`);
- proxy `stream` transcribes image blocks (shape `{ type: 'image', attachment }`, bytes via `ctx.get('attachments').readImage(ref)`) and `yield*`s the inner adapter's stream unchanged.

## License

MIT
