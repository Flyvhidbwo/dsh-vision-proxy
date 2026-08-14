# dsh-vision-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**保持 DeepSeek 作为对话大脑，图片照样直接发。** 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的零配置免费识图插件。

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-vision-proxy"><img src="https://img.shields.io/npm/v/dsh-vision-proxy?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml"><img src="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml/badge.svg" alt="CI (Node 22/24)" /></a>
  <img src="https://img.shields.io/badge/tests-11%20passed-2EA44F?style=flat-square" alt="11 项测试通过" />
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=22.19" />
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy"><img src="https://img.shields.io/github/stars/Flyvhidbwo/dsh-vision-proxy?style=flat-square" alt="GitHub stars" /></a>
</p>

## 为什么需要它

DeepSeek Harness 原生按模型声明的 `inputModalities` 决定是否放行图片附件。DeepSeek 的 chat-completions 线路是纯文本的，所以选中 DeepSeek 时附加图片会被原生拒绝。已有的视觉插件提供 `view_image` 等*工具*（适用于文件路径），但 **GUI 图片附件对纯文本模型依然失败**。

本插件补上这个缺口：注册一条新提供商路由（`deepseek-vision`），包装真正的 DeepSeek 适配器——对外声明支持图片输入（附件预检放行），并在请求流里**把每张附加图片转译成文字**后再委托给 DeepSeek。对话仍然由 DeepSeek 作答，识图只是附加能力。

```
用户附加图片 ──▶ deepseek-vision 路由 ──▶ 经 VLM 转译（OCR+版式+细节）
                   │                        │
                   ▼                        ▼
            DeepSeek 作答 ◀── 纯文本对话（图片已替换为 [图片转译] 文字）
```

## 特性

- **免费开箱即用**。无需 API key、无需注册、零配置：内置免注册匿名端点（OVHcloud AI Endpoints，`Qwen2.5-VL-72B-Instruct`，约 2 次/分/IP）在没有 key 时就是实际默认。
- **多模型、多厂商**。任何 OpenAI 兼容 VLM 端点都行——百炼/Qwen、QwenCloud 国际站、智谱、OpenRouter、本地 Ollama、或你自己的端点。每条 `fallbackModels` 都可以带**各自独立的** `baseURL`/`model`，一个安装即可串联多家。
- **有 key 自动提速**。导出 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 后自动走付费快速通道（百炼 `qwen3.7-flash`——快、便宜、不限速）；没有 key 的条目会被**跳过**而不是失败。
- **安装时一问式确认**。`postinstall` 询问你是否有 VLM API key（没有 → 免费默认；有 → 引导快速通道）。非交互环境自动跳过，安装永不卡死。启动时还会打印 PRIVACY NOTICE 标明当前使用的端点。
- **降级链 + 错误分类**。`rate_limit` / `quota` / `auth` / `region` / `model_not_found` / `context_too_large` / `http` 分类给出可操作提示；HTTP 429 遵循 `Retry-After` 重试一次（上限 15 秒）。
- **内容哈希缓存**。转译结果按图片字节的 SHA-256 缓存（进程内，上限 200）——同一张图每个进程最多转译一次，重新附加或换对话也命中。
- **自动降采样（可选）**。装有 `sharp` 时，超过 `maxImagePixels` 的图片转译前自动缩小——大截图更快；没有 sharp 则优雅降级原图直发。
- **兼容 `read_image`**。原生 `read_image` 工具在该路由下同样可用（它的能力门禁读取同一份模型信息）。

## 支持的模型与厂商

一套配置（`baseURL` + `model`，可选 `apiKey`）覆盖所有后端：

| 场景 | baseURL | model | 说明 |
|---|---|---|---|
| **默认（免费）** | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `Qwen2.5-VL-72B-Instruct` | 匿名、免注册免 key、约 2 次/分/IP、尽力而为；内置兜底，无 key 时的实际默认 |
| **百炼（国内）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-flash` / `qwen3-vl-flash` | 便宜、快、不限速。密钥：千问平台 `sk-ws-…` 或百炼 `sk-…`。有 key 时自动作为降级项启用 |
| **QwenCloud（国际）** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` 等 | 国际版 |
| **智谱（免费档）** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 免费档仍需注册智谱（免费）key |
| **本地 Ollama** | `http://localhost:11434/v1` | `qwen3-vl:4b` 等 | 无需 key；图片不出本机 |
| **任意 OpenAI 兼容端点** | 你的端点 | 你的模型 | OpenRouter、火山 Ark、vLLM、各类网关……插件只讲 `/chat/completions` |

**key 读取顺序**：配置 `apiKey` → `$VISION_API_KEY` → `$DASHSCOPE_API_KEY`。匿名端点（`anonymous: true`）无需 key；无 key 的非匿名条目自动跳过。

## 快速开始

```sh
dsh plugin --profile web add dsh-vision-proxy   # 或：github:Flyvhidbwo/dsh-vision-proxy
```

安装时会问你一个问题——*你有 VLM API key 吗？* 回答 `N`（默认）走免费零配置，回答 `y` 走快速通道引导。重启 `dsh web`，在模型选择器里选 **DeepSeek + 自动识图**，然后把图片粘贴进任意对话——完事。

> pnpm ≥ 10 默认拦截依赖构建脚本。如果安装时提示 "Ignored build scripts"，先执行一次 `pnpm approve-builds`（勾选 `dsh-vision-proxy`），或在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: dsh-vision-proxy: true`。不授权也只是跳过询问、免费默认照常生效。

## 现场演示：工作中途的自主识图

在一次"部署检查"任务中，工具返回了一张截图路径；模型**自主决定要看图**，调用了 `view_image`——代理把图片经 VLM 转译成文字，模型基于文字继续分析并作答。

![工作中途识图演示](assets/demo.png)

```
任务：分析这份部署报告
  → 工具返回 deploy-report.png（一个文件路径）
  → 模型自主调用 view_image("deploy-report.png", "逐行准确读出所有文字")
  → VLM 转译（OCR + 版式）：
      "Deploy Report - 2026-08-13 22:47:12
       [ERROR] web-server: Connection refused: localhost:8080
       [ERROR] database: timeout after 5000ms
       [INFO ] retry 1/3 ...
       [ERROR] TLS handshake failed: cert expired (demo.local)
       [INFO ] rollback to release-2026.08.12
       exit code: 1"
  → 模型基于文字分析故障原因并回答
```

两条自主路径都覆盖：`view_image` 工具（任意路由，支持文件路径与 URL）和图片块自动转译（`deepseek-vision` 路由——对话中途附加的图片）。

## 配置

bundle 默认值（可在你的 profile 的 `cordis.patch.yml` 覆盖）：

```yaml
- insert:
    - id: dsh-vision-proxy
      name: 'dsh-vision-proxy'
      config:
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        apiKey: ''            # 或导出 VISION_API_KEY / DASHSCOPE_API_KEY
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

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `deepseek-vision` | 模型选择器中显示的路由 id |
| `innerProvider` | `deepseek-official` | 被包装的现有适配器路由 |
| `baseURL` | DashScope 兼容模式 | OpenAI 兼容 VLM 端点（任意厂商，含 Ollama） |
| `apiKey` | `''` | VLM 密钥；回退读取 `$VISION_API_KEY`，再回退 `$DASHSCOPE_API_KEY` |
| `anonymous` | `false` | 跳过 Authorization 头（用于免注册端点） |
| `model` | `qwen3.7-flash` | 视觉模型 id（如 `Qwen2.5-VL-72B-Instruct`、`qwen3-vl-flash`、`glm-4.6v-flash`、`qwen3-vl:4b`） |
| `maxTokens` | `4096` | VLM 输出上限（思考型模型先耗推理 token，预算给足） |
| `timeoutMs` | `120000` | VLM 请求超时 |
| `maxImagePixels` | `4000000` | 超过该像素数的图片转译前自动降采样（装有 `sharp` 时；0 关闭） |
| `marker` | `[图片转译]` | 每条转译文本前加的前缀标记 |
| `fallbackModels` | `[OVH 匿名]` | 降级链：`{model, baseURL?, apiKey?, anonymous?, timeoutMs?}`，每条可指向**不同厂商**；无 key 的非匿名条目自动跳过 |

> **优先用 `VISION_API_KEY` 而不是把 key 写进 patch 文件**：`dsh --profile <name> --dump-config` 会原样打印组合后的配置，写在 `cordis.patch.yml` 里的 key 会出现在明文输出中。

## 行为说明

- 只有含图片块的消息才会被处理；纯文本对话零开销直达 DeepSeek。
- 全部链路条目都失败才报错，错误会列出每一次尝试。
- 转译结果按图片内容哈希进程内缓存（永不落盘）。
- 启动时打印一行摘要——路由 id、被包装的提供商、VLM 模型、端点、超时、maxTokens、key 来源与降级列表（key 本身从不打印），外加标明当前端点的 PRIVACY NOTICE。
- 测试：11 个单测，GitHub Actions 在 Node 22/24 上运行。

## 隐私

转译会把图片字节（base64，HTTPS）发送到配置的 VLM 端点——**图片数据会离开你的机器**，除非 `baseURL` 指向本地服务（如 Ollama）。默认无 key 时：OVHcloud 匿名端点；有 key 时：阿里云百炼。除 harness 自身的附件存储外不持久化任何东西。敏感图片请使用自己的端点或本地模型——或者不安装本插件。

## 实现原理（给插件开发者）

本插件只使用 rc.6 上稳定的公共接口：

- `ctx.llm.registration(innerProvider).adapter` —— 拿到被包装的适配器；
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` —— 注册新路由（无 `DUPLICATE_ADAPTER` 冲突）；
- 代理 `resolveModel` 把 `inputModalities` 覆盖为 `['text', 'image']` —— 满足附件预检（`api-proxy`）与 `read_image` 门禁（`dsh-tool-fs`）；
- 代理 `stream` 转译图片块（结构 `{ type: 'image', attachment }`，字节经 `ctx.get('attachments').readImage(ref)` 获取），再 `yield*` 原样转发内部适配器的流。

## 许可证

MIT
