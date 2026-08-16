# dsh-vision-proxy

[English](README.en-US.md) | [简体中文](README.md)

**保持 DeepSeek 作为对话大脑，图片照样直接发。** 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造：GUI 附加图片自动转译，纯文本 DeepSeek 也能识图。

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://www.npmjs.com/package/dsh-vision-proxy"><img src="https://img.shields.io/npm/v/dsh-vision-proxy?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml"><img src="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml/badge.svg" alt="CI (Node 22/24)" /></a>
  <img src="https://img.shields.io/badge/tests-14%20passed-2EA44F?style=flat-square" alt="14 项测试通过" />
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

- **绝不卡死**。匿名端点强制 20 秒超时上限（免费档挂起也拖不住整轮对话）；匿名端点遇到 HTTP 429 **立即失败**（不做无意义的 Retry-After 等待）；刚失败（429/超时）的端点进入 60 秒冷却并被跳过。
- **多模型、多厂商**。任何 OpenAI 兼容 VLM 端点都行——百炼/Qwen、QwenCloud 国际站、智谱、OpenRouter、本地 Ollama、或你自己的端点。每条 `fallbackModels` 都可以带**各自独立的** `baseURL`/`model`，一个安装即可串联多家。
- **零配置本地路径**。`autoLocalOllama`（默认开）启动时探测 `http://localhost:11434`，检测到 Ollama 就自动加入降级链——图片不出本机，免 key 免注册。
- **快速且明确的失败**。没有 key 也没有本地 Ollama 时，转译在几秒内失败并给出可操作指引（配置 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 或安装 Ollama）——绝不静默卡住。
- **有 key 自动提速**。导出 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 后自动走你配置的付费端点（默认百炼 `qwen3.7-flash`——快、便宜、不限速；百炼/QwenCloud/智谱/OpenRouter 或任意 OpenAI 兼容端点均可）；没有 key 的条目会被**跳过**而不是失败。
- **安装时一问式确认**。`postinstall` 询问你是否有 VLM API key。非交互环境自动跳过，安装永不卡死。启动时打印 PRIVACY NOTICE 标明当前使用的端点。
- **降级链 + 错误分类**。`rate_limit` / `quota` / `auth` / `region` / `model_not_found` / `context_too_large` / `http` 分类给出可操作提示。
- **内容哈希缓存**。转译结果按图片字节的 SHA-256 缓存（进程内，上限 200）——同一张图每个进程最多转译一次，重新附加或换对话也命中。
- **自动降采样（可选）**。装有 `sharp` 时，超过 `maxImagePixels` 的图片转译前自动缩小——大截图更快；没有 sharp 则优雅降级原图直发。
- **兼容 `read_image`**。原生 `read_image` 工具在该路由下同样可用（它的能力门禁读取同一份模型信息）。

## 支持的模型与厂商

一套配置（`baseURL` + `model`，可选 `apiKey`）覆盖所有后端：

| 场景 | baseURL | model | 说明 |
|---|---|---|---|
| **百炼（国内）**——默认主模型 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-flash` / `qwen3-vl-flash` | 便宜、快、不限速。密钥：千问平台 `sk-ws-…` 或百炼 `sk-…` |
| **本地 Ollama（自动探测）** | `http://localhost:11434/v1` | 第一个视觉模型 | 装了就零配置可用；图片不出本机 |
| **QwenCloud（国际）** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` 等 | 国际版 |
| **智谱（免费档）** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 免费档仍需注册智谱（免费）key |
| **任意 OpenAI 兼容端点** | 你的端点 | 你的模型 | OpenRouter、火山 Ark、vLLM、各类网关……插件只讲 `/chat/completions` |

> ⚠️ **不再内置任何第三方匿名免费端点作为默认兜底**。实测中匿名免费端点（如 OVHcloud AI Endpoints）限速极严且会无响应挂起——作为默认只会复现"卡死"体验。如果你仍想用某个匿名端点，请通过 `fallbackModels` 自行添加并设 `anonymous: true`（20 秒超时上限依然生效）。

### 价格参考（人民币，百炼国内站 2026-08 参考价）

| 模型 | 输入 | 输出 | 一张 1080p 截图（≈2000 token） |
|---|---|---|---|
| qwen3-vl-flash | ¥0.15/百万 token | ¥1.5/百万 token | ≈ ¥0.0005（约 0.05 分钱） |
| qwen3.7-flash | ¥0.2/百万 token | ¥0.8/百万 token | ≈ ¥0.001（约 0.1 分钱） |
| 本地 Ollama | 免费 | 免费 | ¥0（图片不出本机） |

> 图片按 token 折算（百炼把图片按分辨率折算成 token，一张 1080p 截图 ≈ 2000 token）。按上面价格，**一张图不到 1 厘钱**；即使重度使用（每天 100 张）每月也就几块钱，基本可以忽略。本地 Ollama 完全免费。以百炼控制台实时标价为准。

**key 读取顺序**：配置 `apiKey` → `$VISION_API_KEY` → `$DASHSCOPE_API_KEY`。匿名端点（`anonymous: true`）和本地主机无需 key；无 key 的非匿名条目自动跳过。

## 快速开始

```sh
dsh plugin --profile web add dsh-vision-proxy
```

安装时会问你一个问题——*你有 VLM API key 吗？* 回答 `y` 走付费快速通道，回答 `N`（默认）走本地/零配置路径。重启 `dsh web`，在模型选择器里选 **DeepSeek + 自动识图**，然后把图片粘贴进任意对话——完事。

**pnpm ≥ 10 默认拦截依赖构建脚本**——首次安装会以非零码退出并提示 `Ignored build scripts: dsh-vision-proxy, sharp`。请批准两者（插件的安装确认提示 + `sharp` 的可选二进制），然后**重跑一次安装**完成 bundle 注册：

```yaml
# 写在 profile 的 pnpm-workspace.yaml 里
allowBuilds:
  dsh-vision-proxy: true
  sharp: true
```

```sh
dsh plugin --profile web add dsh-vision-proxy   # 批准后重跑
```

> **npm 官方源太慢？** `dsh plugin --profile web add dsh-vision-proxy --registry=https://registry.npmmirror.com`（参数会转发给 pnpm）。

## 现场演示：真实对话中的识图

一段 `deepseek-vision` 路由上的真实对话（DeepSeek-V4-Flash 作为大脑）：用户粘贴了一张表情包并问 **"你看到了什么"**，图片被 VLM 自动转译，DeepSeek 基于文字完整作答——单步，约 7.6 秒。

<p align="center">
  <img src="assets/demo-selector.png" width="49%" alt="模型选择器：DeepSeek + 自动识图 路由已选中" />
  <img src="assets/demo-reply.png" width="49%" alt="DeepSeek 基于转译内容的完整回答" />
</p>

*左图：模型选择器显示 `deepseek-vision` 路由（**DeepSeek + 自动识图**）已选中——这正是图片附件得以放行的原因。右图：DeepSeek 基于转译文字给出的完整回答。*

```
用户粘贴表情包 + "你看到了什么"
  → 图片块经 VLM 自动转译（OCR + 版式）：
      "我是吃白饭的 / 蓝色大肥鱼！ (理直气壮.jpg) — Q版蓝发女仆装少女，
       身后蓝鲸尾巴，端碗举筷，表情兴奋"
  → DeepSeek 基于文字对表情包做完整视觉分析
```

两条自主路径都覆盖：`view_image` 工具（任意路由，支持文件路径与 URL）和图片块自动转译（`deepseek-vision` 路由——对话中途附加的图片）。

## 配置

bundle 已自带合理的默认配置（见上方策略说明），一般无需改动。要覆盖时，请在 profile 中写 **id 定向覆盖**，不要用 `insert`（见下方警告）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml —— 用户层覆盖示例
- id: dsh-vision-proxy
  name: 'dsh-vision-proxy'
  config:
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    apiKey: 'sk-…'          # 或留空读环境变量（Windows 下直写这里最可靠）
    model: qwen3.7-flash
    maxTokens: 4096
    timeoutMs: 120000       # 匿名端点无论如何都会被强制 20s 上限
    maxImagePixels: 4000000
    marker: '[图片转译]'
    autoLocalOllama: true
    fallbackModels: []      # 可自行添加 {model, baseURL, apiKey?, anonymous?, timeoutMs?}
```

> ⚠️ **不要写成 `- insert: [{id: dsh-vision-proxy, …}]`。** dsh 的 patch 语义里 `insert` 是往条目列表**追加**——bundle 自带的条目和你写的同 id 条目会同时存在并被实例化，`deepseek-vision` adapter 会被**注册两次**（行为未定义）。顶层 `- id:` 条目才会命中既有行并**整体替换其 `config`**；未列出的键回落到插件 zod schema 的 `.default()` 值（如 `maxTokens=4096`、`timeoutMs=120000`、`autoLocalOllama=true`），所以只写 `apiKey`/`model` 也能工作。

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `deepseek-vision` | 模型选择器中显示的路由 id |
| `innerProvider` | `deepseek-official` | 被包装的现有适配器路由 |
| `baseURL` | DashScope 兼容模式 | OpenAI 兼容 VLM 端点（任意厂商，含 Ollama） |
| `apiKey` | `''` | VLM 密钥；回退读取 `$VISION_API_KEY`，再回退 `$DASHSCOPE_API_KEY`。**Windows 下环境变量变更可能不生效，直写这里最可靠** |
| `anonymous` | `false` | 跳过 Authorization 头（用于免注册端点；受 20s 超时上限约束） |
| `model` | `qwen3.7-flash` | 视觉模型 id（如 `Qwen2.5-VL-72B-Instruct`、`qwen3-vl-flash`、`glm-4.6v-flash`、`qwen3-vl:4b`） |
| `maxTokens` | `4096` | VLM 输出上限（思考型模型先耗推理 token，预算给足） |
| `timeoutMs` | `120000` | VLM 请求超时（匿名端点无论如何都被强制 20s 上限） |
| `maxImagePixels` | `4000000` | 超过该像素数的图片转译前自动降采样（装有 `sharp` 时；0 关闭） |
| `marker` | `[图片转译]` | 每条转译文本前加的前缀标记 |
| `autoLocalOllama` | `true` | 启动时探测 `http://localhost:11434`；检测到则前置进降级链 |
| `localOllamaModel` | `''` | 指定 Ollama 模型 id；留空自动选本地 Ollama 报告的第一个视觉模型 |
| `fallbackModels` | `[]` | 降级链：`{model, baseURL?, apiKey?, anonymous?, timeoutMs?}`，每条可指向**不同厂商**；无 key 的非匿名条目自动跳过 |

> **Windows 上关于 API key 的说明**：`dsh --profile <name> --dump-config` 会原样打印组合后的配置（写在 `cordis.patch.yml` 里的 key 会出现在明文输出中），但另一方面，进程启动后设置的环境变量（explorer.exe 会缓存旧环境）可能永远到不了正在运行的 dsh。如果你明明导出了 key 却看到 `skipped — no API key`，**请把 `apiKey` 直接写进插件配置**——这是 Windows 上唯一可靠的方式。（注意：dsh rc.6 **不加载 `.env` 文件**，那不是替代方案。）

## 安装后验证

```sh
dsh --profile web --dump-config | grep -A3 dsh-vision-proxy   # 应恰好一个条目（注意：会明文打印配置，含 key）
```

1. 重启 `dsh web` → 模型选择器出现 **DeepSeek + 自动识图**。
2. 向对话粘贴图片 → 应看到 `[图片转译]` 标记后 DeepSeek 作答。
3. 没有 key 也没有本地 Ollama 时，回合应在**数秒内快速失败**并给出指引消息——这就是预期的防卡死行为。

## 行为说明

- 只有含图片块的消息才会被处理；纯文本对话零开销直达 DeepSeek。
- 匿名端点：20 秒硬超时上限、HTTP 429 立即失败（不重试）、失败后触发 60 秒端点冷却——连发图片不会反复踩坏端点。
- 全部链路条目都失败才报错，错误会列出每一次尝试并附可操作指引。
- 转译结果按图片内容哈希进程内缓存（永不落盘）。
- 启动时打印一行摘要——路由 id、被包装的提供商、VLM 模型、端点、超时、maxTokens、key 来源与降级列表（key 本身从不打印），外加 PRIVACY NOTICE 和 Ollama 探测结果。
- 测试：14 个单测，GitHub Actions 在 Node 22/24 上运行（含防卡死快速失败、冷却跳过、Ollama 探测用例）。
- 转译质量：密集 UI 截图可能丢失小字细节——这是视觉模型的能力上限，不是插件 bug。OCR 重度场景建议换更强模型（如 `qwen3-vl-plus`）或调大 `maxTokens`。

## 排障

| 现象 | 原因与解决 |
|---|---|
| 明明导出了 `VISION_API_KEY` 仍报 `skipped — no API key` | Windows 在 explorer.exe 里缓存环境变量，运行中的 dsh 读不到新值。把 `apiKey` 直写进插件配置，重启 dsh |
| 安装时报 `Ignored build scripts: dsh-vision-proxy, sharp` | pnpm ≥ 10 默认拦截依赖构建脚本。在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: {dsh-vision-proxy: true, sharp: true}`，然后重跑安装 |
| 发布当天安装报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 11 默认 `minimumReleaseAge` 为 1 天（供应链策略）。在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAge: 0`，或给 `dsh plugin add` 加 `--config.minimum-release-age=0`，然后重跑 |
| 匿名端点报 `all N vision model(s) failed … rate_limit` | 匿名免费档限速极严且可能挂起。配置 key 或改用本地 Ollama |
| 新装无 key 时约 20 秒后失败 | 没有 key 也没有本地 Ollama——这是预期的快速失败路径。安装 Ollama 或配置 key |
| npm 官方源下载慢 | 使用 `--registry=https://registry.npmmirror.com`（参数转发给 pnpm） |

## 隐私

转译会把图片字节（base64，HTTPS）发送到配置的 VLM 端点——**图片数据会离开你的机器**，除非 `baseURL` 指向本地服务（如 Ollama）。除 harness 自身的附件存储外不持久化任何东西。敏感图片请使用自己的端点或本地模型——或者不安装本插件。

## 实现原理（给插件开发者）

本插件只使用 rc.6 上稳定的公共接口：

- `ctx.llm.registration(innerProvider).adapter` —— 拿到被包装的适配器；
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` —— 注册新路由（无 `DUPLICATE_ADAPTER` 冲突）；
- 代理 `resolveModel` 把 `inputModalities` 覆盖为 `['text', 'image']` —— 满足附件预检（`api-proxy`）与 `read_image` 门禁（`dsh-tool-fs`）；
- 代理 `stream` 转译图片块（结构 `{ type: 'image', attachment }`，字节经 `ctx.get('attachments').readImage(ref)` 获取），再 `yield*` 原样转发内部适配器的流。

## 许可证

MIT
