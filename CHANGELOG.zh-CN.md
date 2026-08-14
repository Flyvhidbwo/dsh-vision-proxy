# 更新日志

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-08-14

### 新增

- `scripts/release.ps1`：一条命令完成发布——升版本、打 git 标签、推送到 GitHub、发布到 npm（用法见脚本头部注释）。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`。

## [0.1.2] - 2026-08-14

### 变更

- README 安装节：npm registry 安装（`dsh plugin --profile web add dsh-vision-proxy`）改为**首选推荐**方式——无需访问 GitHub，对 GitHub 直连不稳定的国内用户更友好；GitHub 安装保留为备选。

## [0.1.1] - 2026-08-14

### 新增

- 启动日志：路由 id、被包装的 provider、VLM 模型、端点与 apiKey 来源（密钥本身永不入日志）。
- 401/403 转译错误现在附带提示：核对密钥与平台签发格式完全一致（如千问平台的 `sk-ws-…` / `sk-sp-…`）。
- README：profile 覆盖示例（注明"config 是整体替换、非深合并"）；端点/密钥格式对照表（千问/DashScope 国内、QwenCloud 国际、智谱、Ollama）；本地/link 安装说明（需在插件目录执行 `pnpm install`）；密钥安全建议（优先用 `VISION_API_KEY` 环境变量而非写进 patch 文件）。
- npm 元数据（`repository`、`homepage`、`bugs`、`publishConfig`）。

### 变更

- 首次发布到 npm registry（`dsh-vision-proxy@0.1.1`）。

## [0.1.0] - 2026-08-13

### 新增

- `deepseek-vision` 提供商路由，包装内部 DeepSeek 适配器：对外声明支持图片输入（GUI 附件预检与 `read_image` 门禁放行），并在请求流中把每张图片经 OpenAI 兼容 VLM（默认 DashScope 兼容模式 `qwen3.7-flash`）转译成文字后再委托给 DeepSeek。
- 按 `attachmentId` 的进程内转译缓存（上限 100 条）。
- 双语 README（英文 + 简体中文），含工作中途自主识图演示。
- `dsh.bundle` patch（`cordis.patch.yml`），`dsh plugin add` 后自动接入 profile 的组合包层。

[0.1.3]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Flyvhidbwo/dsh-vision-proxy/releases/tag/v0.1.0
