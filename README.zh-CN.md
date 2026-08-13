# dsh-vision-proxy

[English](README.md) | [简体中文](README.zh-CN.md)

**DeepSeek 大脑 + 自动识图** —— 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的代理路由插件。

保持 DeepSeek（纯文本线路）作为对话大脑，同时也能在 Web 界面直接附加图片——每条图片消息都会自动经 OpenAI 兼容 VLM（默认 DashScope `qwen3.7-flash`）转译成文字，再交给 DeepSeek 作答。

## 为什么需要它

DeepSeek Harness 原生按模型声明的 `inputModalities` 决定是否放行图片附件。DeepSeek 的 chat-completions 线路是纯文本的，所以选中 DeepSeek 时附加图片会被原生拒绝。已有的视觉插件提供 `view_image` *工具*（适用于文件路径），但 GUI 图片*附件*依然被拒。

本插件补上这个缺口：注册一条新提供商路由（`deepseek-vision`），包装真正的 DeepSeek 适配器——对外声明支持图片输入（附件预检放行），并在请求流里**把每张图片转译成文字**后再委托给 DeepSeek。对话仍然由 DeepSeek 作答，识图只是附加能力。

```
用户附加图片 ──▶ deepseek-vision 路由 ──▶ 经 qwen3.7-flash 转译（OCR+版式+细节）
                   │                        │
                   ▼                        ▼
            DeepSeek 作答 ◀── 纯文本对话（图片已替换为 [图片转译] 文字）
```

## 安装

```sh
dsh plugin add <本仓库 git 地址>
# 或经插件管理器（Marisa / dshx）：dshx install dsh-vision-proxy <url>
```

安装后重启 `dsh web`，在模型选择器里选 **DeepSeek + 自动识图 → DeepSeek-V4-Flash**（或内部 DeepSeek 路由暴露的任意模型）。

要求：dsh >= 0.1.0-rc.6，Node >= 22.19。

## 配置

配置位于插件行（以下为 bundle 默认值；可在你的 profile 的 `cordis.patch.yml` 中覆盖）：

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

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `deepseek-vision` | 模型选择器中显示的路由 id |
| `innerProvider` | `deepseek-official` | 被包装的现有适配器路由 |
| `baseURL` | DashScope 兼容模式 | OpenAI 兼容 VLM 端点（任意厂商，含 Ollama） |
| `apiKey` | `''` | VLM 密钥；回退读取 `$VISION_API_KEY`，再回退 `$DASHSCOPE_API_KEY` |
| `model` | `qwen3.7-flash` | 视觉模型 id（如 `qwen3-vl-flash`、`glm-4.6v-flash`，本地 Ollama 可用 `qwen3-vl:4b`） |
| `maxTokens` | `2048` | VLM 输出上限 |
| `timeoutMs` | `60000` | VLM 请求超时 |
| `marker` | `[图片转译]` | 每条转译文本前加的前缀标记 |

### 端点说明

- **DashScope（阿里云百炼）**：保持默认 `baseURL`；密钥在 [bailian.console.aliyun.com](https://bailian.console.aliyun.com) 申请。`qwen3.7-flash` 多模态且便宜。
- **智谱**：`https://open.bigmodel.cn/api/paas/v4` + `glm-4.6v-flash`（有免费档）。
- **本地 Ollama**：`http://localhost:11434/v1` + 任意视觉模型，无需密钥。

## 行为说明

- 只有含图片块的消息才会被处理；纯文本对话零开销直达 DeepSeek。
- 转译结果按 `attachmentId` 缓存（进程内，上限 100 条），同一张图每个进程最多转译一次。
- `read_image` 工具在该路由下同样可用（其能力门禁读取的是同一份模型信息）。
- 若 VLM 失败（网络 / 额度 / 缺密钥），请求会以明确报错失败，而不是静默丢弃图片。

## 实现原理（给插件开发者）

本插件只使用 rc.6 上稳定的公共接口：

- `ctx.llm.registration(innerProvider).adapter` —— 拿到被包装的适配器；
- `ctx.llm.registerAdapter([providerId], proxyAdapter)` —— 注册新路由（无 `DUPLICATE_ADAPTER` 冲突）；
- 代理 `resolveModel` 把 `inputModalities` 覆盖为 `['text', 'image']` —— 满足附件预检（`api-proxy`）与 `read_image` 门禁（`dsh-tool-fs`）；
- 代理 `stream` 转译图片块（结构 `{ type: 'image', attachment }`，字节经 `ctx.get('attachments').readImage(ref)` 获取），再 `yield*` 原样转发内部适配器的流。

## 许可证

MIT
