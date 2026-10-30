# dsh-vision-proxy

[English](README.en-US.md) | [简体中文](README.md)

**保持 DeepSeek 作为对话大脑，图片照样直接发。** 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造：GUI 附加图片自动转译，纯文本 DeepSeek 也能识图。

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://www.npmjs.com/package/dsh-vision-proxy"><img src="https://img.shields.io/npm/v/dsh-vision-proxy?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml"><img src="https://github.com/Flyvhidbwo/dsh-vision-proxy/actions/workflows/ci.yml/badge.svg" alt="CI (Node 22/24)" /></a>
  <img src="https://img.shields.io/badge/tests-34%20passed-2EA44F?style=flat-square" alt="34 项测试通过" />
  <img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node >=22.19" />
  <a href="https://github.com/Flyvhidbwo/dsh-vision-proxy"><img src="https://img.shields.io/github/stars/Flyvhidbwo/dsh-vision-proxy?style=flat-square" alt="GitHub stars" /></a>
</p>

> ⚠️ **兼容性与定位（2026-10，v0.5.0）**：已适配 **dsh 0.2.x**（桌面端 0.2.1-rc.3 / CLI 0.2.1-rc.5 实测），并在 **设置 → 识图代理** 里提供可视化配置页（改动实时生效，无需重启）。
>
> dsh 0.2.x 起 DeepSeek 账号/官方视觉模型**原生支持图片**（如 `deepseek-flash`、`deepseek-v4-flash-vision-exp`）——**用原生视觉模型时不需要本插件**。本插件补的是另一半：**纯文本模型依然看不了图**（如 `deepseek-v4-pro`），插件把图片转译成文字后交给它们。插件适用于：Pro/文本模型识图、本地 Ollama（图片不出本机、免费）、自定义 OpenAI 兼容 VLM；**选中的模型本身支持图片时会自动直通，不再二次转译**。
>
> 0.5.0 修复了 0.4.1 在 dsh 0.2.x 上「静默失效」的根因：0.2.x 的 `ctx.llm.registration()` 在包装路由尚未注册时**抛** `NO_ADAPTER`（而非返回 undefined），旧版在 `apply()` 里同步调用它 → 条目不激活、路由从不出现。现在改为惰性解析 + 自动发现内层路由（`deepseek-official` / `deepseek-account` 皆可）。

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

- **设置页可视化配置**。dsh **设置 → 识图代理**：端点、模型、超时、失败策略等 15 个字段直接编辑，保存写入 profile 的 `cordis.patch.yml`，**后续对话立即生效，无需重启**；密钥字段只显示「已保存」，永不回显到浏览器。
- **原生识图直通**。选中的模型本身声明了图片输入（如 `deepseek-flash` / `deepseek-v4-flash-vision-exp`）时，图片原样透传、**不再转译**——不浪费一次 VLM 调用，也不损失原生视觉质量。
- **内层路由自动发现**。配置的 `innerProvider` 没注册时，按 `deepseek-official` → `deepseek-account` → 任一已注册路由的顺序自动挑选：API-key profile 与「DeepSeek 账号登录」profile 都能开箱即用。
- **绝不卡死**。公网匿名端点强制 20 秒超时上限；匿名端点遇到 HTTP 429 **立即失败**（不做无意义的 Retry-After 等待）；刚失败（429/超时）的端点进入 60 秒冷却并被跳过。**本机/回环端点不受这套匿名策略约束**：冷启动加载几 GB 权重慢是正常的，用满你配置的超时，并发送 `keep_alive` 让 Ollama 模型常驻。
- **多模型、多厂商**。任何 OpenAI 兼容 VLM 端点都行——百炼/Qwen、QwenCloud 国际站、智谱、OpenRouter、本地 Ollama、或你自己的端点。每条 `fallbackModels` 都可以带**各自独立的** `baseURL`/`model`，一个安装即可串联多家。
- **零配置本地路径**。`autoLocalOllama`（默认开）启动时探测 `http://localhost:11434`，检测到 Ollama 就自动加入降级链——图片不出本机，免 key 免注册。
- **快速且明确的失败**。没有 key 也没有本地 Ollama 时，转译在几秒内失败并给出可操作指引（配置 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 或安装 Ollama）——绝不静默卡住。
- **有 key 自动提速**。导出 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 后自动走你配置的付费端点（默认百炼 `qwen3.7-flash`——快、便宜、不限速）；没有 key 的条目会被**跳过**而不是失败。
- **降级链 + 错误分类**。`rate_limit` / `quota` / `auth` / `region` / `model_not_found` / `context_too_large` / `http` 分类给出可操作提示；占位符会报告**每一次尝试**而不仅是第一条。
- **思考型模型兜底**。`qwen3-vl`、`deepseek-flash` 这类思考模型可能把输出预算全花在 `reasoning` 上、`content` 为空——此时自动回退使用推理文本，不丢弃已经完成的识图结果。
- **转译不因会话取消而中断**。默认不把会话层的中止信号链进转译请求（`abortWithSession: false`）：dsh 在处理大图时会取消/重发请求，旧行为会在推理中途掐断已完成的工作。需要严格取消时可在设置页打开。
- **内容哈希缓存**。转译结果按图片字节的 SHA-256 缓存（进程内，上限 200）——同一张图每个进程最多转译一次，重新附加或换对话也命中。
- **自动降采样（可选）**。dsh 0.2.x 走附件服务的 `readImageRequest` 投影（原生缩放、带缓存）；旧版 / 无投影后端回退 `readImage` + 可选 `sharp` 降采样。
- **兼容 `read_image`**。原生 `read_image` 工具在该路由下同样可用（它的能力门禁读取同一份模型信息）。

## 支持的模型与厂商

一套配置（`baseURL` + `model`，可选 `apiKey`）覆盖所有后端：

| 场景 | baseURL | model | 说明 |
|---|---|---|---|
| **DeepSeek 官方识图**——默认 | `https://api.deepseek.com` | `deepseek-v4-flash-vision-exp` | 复用 `DEEPSEEK_API_KEY`，无需额外 key；官方视觉质量最好 |
| **百炼（国内）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.7-flash` / `qwen3-vl-flash` | 便宜、快、不限速。密钥：千问平台 `sk-ws-…` 或百炼 `sk-…` |
| **本地 Ollama（自动探测）** | `http://localhost:11434/v1` | 第一个视觉模型 | 装了就零配置可用；图片不出本机；自动带 `keep_alive: 30m` |
| **QwenCloud（国际）** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` 等 | 国际版 |
| **智谱（免费档）** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 免费档仍需注册智谱（免费）key |
| **任意 OpenAI 兼容端点** | 你的端点 | 你的模型 | OpenRouter、火山 Ark、vLLM、各类网关……插件只讲 `/chat/completions` |

> ⚠️ **不再内置任何第三方匿名免费端点作为默认兜底**。实测中匿名免费端点（如 OVHcloud AI Endpoints）限速极严且会无响应挂起——作为默认只会复现"卡死"体验。如果你仍想用某个匿名端点，请通过 `fallbackModels` 自行添加并设 `anonymous: true`（20 秒超时上限依然生效）。

### 价格参考（人民币，百炼国内站 2026-08 参考价）

| 模型 | 输入 | 输出 | 一张 1080p 截图（≈2000 token） |
|---|---|---|---|
| qwen3-vl-flash | ¥0.15/百万 token | ¥1.5/百万 token | ≈ ¥0.0005（约 0.05 分钱） |
| qwen3.7-flash | ¥0.2/百万 token | ¥0.8/百万 token | ≈ ¥0.001（约 0.1 分钱） |
| **deepseek-v4-flash-vision-exp**（官方，默认） | ¥3/百万（高峰）· ¥1.5（空闲） | ¥9/百万（高峰）· ¥4.5（空闲） | ≈ ¥0.01（高峰）/ ¥0.005（空闲） |
| 本地 Ollama | 免费 | 免费 | ¥0（图片不出本机） |

> 温馨提示：**识图默认走官方 deepseek-v4-flash-vision-exp**（高峰 9:00-12:00 / 14:00-18:00 为全价，其余时间半价；图片按尺寸折算 token，不按张计费）。与 V4-Pro 同档价约 1/3。

> 图片按 token 折算（各平台把图片按分辨率折算成 token，一张 1080p 截图 ≈ 2000 token）。按上面价格，**一张图不到 1 厘钱**；即使重度使用（每天 100 张）每月也就几块钱，基本可以忽略。本地 Ollama 完全免费。以百炼控制台实时标价为准。

**key 读取顺序**：配置 `apiKey` → `$VISION_API_KEY` → `$DASHSCOPE_API_KEY`。匿名端点（`anonymous: true`）和本地主机无需 key；无 key 的非匿名条目自动跳过。

## 快速开始

```sh
# 桌面端（profile 名以实际为准：桌面客户端用 desktop，`dsh web` 用 web）
dsh plugin --profile desktop add dsh-vision-proxy
```

重启 dsh 后：

1. 模型选择器里出现 **DeepSeek + 自动识图**（选它才能让纯文本大脑收到图片）；
2. **设置 → 识图代理** 里改配置（保存后下一轮对话生效，无需重启，密钥不回显）；
3. 把图片粘贴进任意对话——完事。

> 默认策略：优先用 DeepSeek 官方视觉模型转译（`deepseek-v4-flash-vision-exp`，复用你的 `DEEPSEEK_API_KEY`，无需额外 key）；没有 key 则尝试 `VISION_API_KEY` / `DASHSCOPE_API_KEY` 走百炼；本机装有 Ollama 会自动加入降级链；**选中的模型本身支持图片时直接直通、不转译**。

**pnpm ≥ 10 默认拦截依赖构建脚本**——首次安装会以非零码退出并提示 `Ignored build scripts: dsh-vision-proxy, sharp`。请批准两者（插件的安装确认提示 + `sharp` 的可选二进制），然后**重跑一次安装**完成 bundle 注册：

```yaml
# 写在 profile 的 pnpm-workspace.yaml 里
allowBuilds:
  dsh-vision-proxy: true
  sharp: true
```

```sh
dsh plugin --profile desktop add dsh-vision-proxy   # 批准后重跑
```

> **npm 官方源太慢？** `dsh plugin --profile desktop add dsh-vision-proxy --registry=https://registry.npmmirror.com`（参数会转发给 pnpm）。

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

**首选：dsh 设置页**。设置 → **识图代理** 里可直接编辑 15 个常用字段；保存写入 profile 的 `cordis.patch.yml`，**下一轮对话立即生效，无需重启**。密钥字段只显示「已保存」（密文永不下发浏览器），留空表示不修改。

**需要重启的四项**（`providerId`、`innerProvider`、`autoLocalOllama`、`fallbackModels`）仍写在 profile patch 里，用 **id 定向覆盖**，不要用 `insert`：

```yaml
# $DSH_HOME/profiles/desktop/cordis.patch.yml —— 用户层覆盖示例
- id: dsh-vision-proxy
  name: 'dsh-vision-proxy'
  config:
    providerId: deepseek-vision     # 模型选择器里的路由 id
    innerProvider: deepseek-official # 包装哪条现有路由；留空/失效时自动发现 deepseek-account
    autoLocalOllama: true
    fallbackModels: []              # 可自行添加 {model, baseURL, apiKey?, anonymous?, timeoutMs?}
```

> ⚠️ **不要写成 `- insert: [{id: dsh-vision-proxy, …}]`。** dsh 的 patch 语义里 `insert` 是往条目列表**追加**——bundle 自带的条目和你写的同 id 条目会同时存在并被实例化，`deepseek-vision` adapter 会被**注册两次**（行为未定义）。顶层 `- id:` 条目才会命中既有行并**整体替换其 `config`**；未列出的键回落到插件 zod schema 的默认值。注意：设置页保存时也会写成这种 id 定向覆盖。

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `deepseek-vision` | 模型选择器中显示的路由 id（**改需重启**） |
| `innerProvider` | `deepseek-official` | 被包装的现有适配器路由；未注册时自动回退 `deepseek-account` → 任一已注册路由（**改需重启**） |
| `baseURL` | DashScope 兼容模式 | OpenAI 兼容 VLM 端点（任意厂商，含 Ollama） |
| `apiKey` | `''` | VLM 密钥；回退读取 `$VISION_API_KEY`，再回退 `$DASHSCOPE_API_KEY`。**Windows 下环境变量变更可能不生效，直写这里最可靠**；设置页不回显 |
| `anonymous` | `false` | 跳过 Authorization 头（用于免注册**公网**端点；受 20s 超时上限约束）。回环地址永远按本地处理 |
| `model` | `qwen3.7-flash` | 视觉模型 id（如 `qwen3-vl-flash`、`glm-4.6v-flash`、`qwen3-vl:8b`） |
| `maxTokens` | `8192` | VLM 输出上限（思考型模型先耗推理 token，预算给足） |
| `timeoutMs` | `120000` | VLM 请求超时（公网匿名端点强制 20s 上限；本机端点用满此值） |
| `maxImagePixels` | `4000000` | 超过该像素数的图片转译前自动降采样（0 关闭） |
| `keepAlive` | `30m` | 仅本机端点发送的 `keep_alive`（Ollama 模型常驻时长；留空不发送） |
| `marker` | `[图片转译]` | 每条转译文本前加的前缀标记 |
| `failureMode` | `placeholder` | 全部 VLM 失败时的行为：`placeholder`（默认）插入 `[图片转译失败: 原因]` 文本并继续对话；`error` 则整轮失败 |
| `abortWithSession` | `false` | 是否让会话层取消中止正在进行的转译。默认关闭：已完成的一次推理不因 dsh 的重发/取消被丢弃 |
| `deepseekVision` | `true` | 优先用 DeepSeek 官方视觉模型转译（复用 `DEEPSEEK_API_KEY`） |
| `deepseekVisionModel` | `deepseek-v4-flash-vision-exp` | 官方转译所用模型 |
| `nativeVisionPassThrough` | `true` | 选中的模型原生支持图片时直接透传，不再二次转译 |
| `autoLocalOllama` | `true` | 启动时探测 `http://localhost:11434`；检测到则加入降级链（**改需重启**） |
| `localOllamaModel` | `''` | 指定 Ollama 模型 id；留空自动选本地 Ollama 报告的第一个视觉模型 |
| `fallbackModels` | `[]` | 降级链：`{model, baseURL?, apiKey?, anonymous?, timeoutMs?}`，每条可指向**不同厂商**；无 key 的非匿名条目自动跳过（**改需重启**） |

> **Windows 上关于 API key 的说明**：`dsh --profile <name> --dump-config` 会原样打印组合后的配置（写在 `cordis.patch.yml` 里的 key 会出现在明文输出中），但另一方面，进程启动后设置的环境变量（explorer.exe 会缓存旧环境）可能永远到不了正在运行的 dsh。如果你明明导出了 key 却看到 `skipped — no API key`，**请在设置 → 识图代理里直接填 key**（或写进插件配置）。

## 安装后验证

```sh
dsh --profile desktop --dump-config | grep -A3 dsh-vision-proxy   # 应恰好一个条目（注意：会明文打印配置，含 key）
```

1. 重启 dsh → 模型选择器出现 **DeepSeek + 自动识图**。
2. 设置里出现 **识图代理** 页（说明 volatile 配置命名空间已服务）。
3. 向对话粘贴图片 → 应看到 `[图片转译]` 标记后 DeepSeek 作答。
4. 若选中的模型本身支持图片（如 `deepseek-flash`），图片会**直接透传**、不产生转译请求。

## 行为说明

- 只有含图片块的消息才会被处理；纯文本对话零开销直达 DeepSeek。
- 公网匿名端点：20 秒硬超时上限、HTTP 429 立即失败（不重试）、失败后触发 60 秒端点冷却——连发图片不会反复踩坏端点。**本机/回环端点不受匿名策略约束**。
- **网络层失败（fetch failed / 连接被拒等）同样进入 60 秒冷却**，死端点不会每轮重试。
- **会话永不中毒**（`failureMode: placeholder`，默认）：某张图全部 VLM 失败时插入 `[图片转译失败: 原因]` 占位文本并继续对话（原因包含**每一次尝试**）；失败的图片按内容哈希记忆 60 秒，期间不再发起网络请求。
- **思考型模型**：`content` 为空但有 `reasoning` / `reasoning_content` 时，用推理文本作为转译结果，不丢弃已完成的识图。
- 全部链路条目都失败才报错（`failureMode: error` 时），错误会列出每一次尝试并附可操作指引。
- 转译结果按图片内容哈希进程内缓存（永不落盘）。
- 启动时写入一行摘要日志（路由 id、内层路由、VLM 模型、端点、超时、maxTokens、failureMode、key 来源与降级列表；key 本身从不打印）。
- 测试：**34 个单测**（含对真实 `dsh-llm` 运行时的契约验证，可运行 `scripts/verify-runtime-contract.mjs` 复现），GitHub Actions 在 Node 22/24 上运行。
- 转译质量：密集 UI 截图可能丢失小字细节——这是视觉模型的能力上限，不是插件 bug。OCR 重度场景建议换更强模型（如 `qwen3-vl-plus`）或调大 `maxTokens`。

## 排障

| 现象 | 原因与解决 |
|---|---|
| 0.4.1 在 dsh 0.2.x 上「完全不可用」：终端打印 `1 entry did not activate`、模型选择器没有分组 | 0.2.x 的 `ctx.llm.registration()` 抛 `NO_ADAPTER`，旧版在 `apply()` 同步调用导致条目不激活。**升级到 0.5.0**（惰性解析 + 内层路由自动发现） |
| 模型选择器里没有「DeepSeek + 自动识图」 | 确认 profile 的 `cordis.patch.yml` 里有且仅有一个 `dsh-vision-proxy` 条目；确认插件已安装（`dsh --profile desktop --dump-config`）。若目标是账号登录 profile，`innerProvider` 设为 `deepseek-account` 或留空自动发现 |
| 设置里没有「识图代理」页 | 该页只在 Host 服务 `dsh-vision-proxy` 设置命名空间时出现：确认条目处于启用状态；若插件行被禁用或 profile 未加载该行，页面不会注册 |
| 明明导出了 `VISION_API_KEY` 仍报 `skipped — no API key` | Windows 在 explorer.exe 里缓存环境变量，运行中的 dsh 读不到新值。在 **设置 → 识图代理** 里直接填 key，或写进插件配置 |
| 本机 Ollama 每张图都超时（20 秒） | 0.4.x 的匿名 20s 上限误伤本机端点。**0.5.0 已修复**：回环地址不再按匿名端点处理，并发送 `keep_alive` 让模型常驻 |
| 本机 Ollama 报上下文超限（图片 token > 4096） | Ollama 默认上下文太小。设 `OLLAMA_CONTEXT_LENGTH=32768` 后重启 Ollama |
| 安装时报 `Ignored build scripts: dsh-vision-proxy, sharp` | pnpm ≥ 10 默认拦截依赖构建脚本。在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: {dsh-vision-proxy: true, sharp: true}`，然后重跑安装 |
| 发布当天安装报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 11 默认 `minimumReleaseAge` 为 1 天（供应链策略）。在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAge: 0`，或给 `dsh plugin add` 加 `--config.minimum-release-age=0`，然后重跑 |
| 匿名端点报 `all N vision model(s) failed … rate_limit` | 匿名免费档限速极严且可能挂起。配置 key 或改用本地 Ollama |
| 同时装了 `@anionex/dsh-vision-toolkit` 时报 `needs no image-input variant` | 两个插件都提供图片输入能力，功能重叠。在本插件路由上关掉 toolkit 的变体：在 profile patch 里给 `vision-toolkit` 行加 `config: { imageInputVariants: { enabled: false } }`，或直接卸载其中一个 |
| npm 官方源下载慢 | 使用 `--registry=https://registry.npmmirror.com`（参数转发给 pnpm） |

## 隐私

转译会把图片字节（base64，HTTPS）发送到配置的 VLM 端点——**图片数据会离开你的机器**，除非 `baseURL` 指向本地服务（如 Ollama）。除 harness 自身的附件存储外不持久化任何东西。敏感图片请使用自己的端点或本地模型——或者不安装本插件。

## 实现原理（给插件开发者）

本插件只使用 dsh 0.2.x 的公共接口：

- `ctx.llm.registerAdapter([providerId], proxyAdapter)` —— 注册新路由；
- **惰性**解析被包装的适配器：`ctx.llm.registration(inner)` **会抛** `NO_ADAPTER`（不是返回 undefined），必须在真正调用时才解析并记忆化，否则 cordis 的激活顺序会让 `apply()` 失败；
- 代理 `listModels` / `resolveModel` 用**内层路由**取元数据，再把 `provider` 重新盖成调用方询问的路由——`dsh-llm` 校验 `model.provider === 请求路由`，否则整包 `INVALID_CATALOG`；
- `resolveModel` 把 `inputModalities` 覆盖为 `['text', 'image']` —— 满足附件预检与 `read_image` 门禁；
- 代理 `prepareCall` 绑定内层的 `prepareCall` 生成代，`stream` 转译图片块后 `yield*` 转发；图片字节经 `ctx.get('attachments').readImageRequest(ref, target, signal)`（0.2.x 公共投影 API）获取，旧后端回退 `readImage(ref)`；
- Config 里对设置页要暴露的字段加 `.volatile()`（`@deepseek-ai/schemastery`）：dsh 会把**活动且可唯一定位的条目**的 volatile 字段作为设置命名空间服务，并持久化到 profile 的 `cordis.patch.yml`，通过引用热更新到运行中的插件；
- 浏览器半 `lib/client.js` 由 `dsh.client` 声明被 `/plugins` 服务：注册 `settings.section` 得到设置导航项，用 `ctx.configForms.get('dsh-vision-proxy')` 读写该命名空间。

## 许可证

MIT
