# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-08-14

### Added

- `scripts/release.ps1`: one-command release flow — version bump, git tag, push to GitHub, publish to npm (see the script header for usage).
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`.

## [0.1.2] - 2026-08-14

### Changed

- README install section: npm registry (`dsh plugin --profile web add dsh-vision-proxy`) is now the primary, recommended install path — no GitHub access needed, which matters for users behind unreliable GitHub connectivity; GitHub install remains as an alternative.

## [0.1.1] - 2026-08-14

### Added

- Startup log line: route id, wrapped provider, VLM model, endpoint and apiKey source (the key itself is never logged).
- 401/403 transcription errors now include a hint to verify the key format against the platform-issued one (e.g. `sk-ws-…` / `sk-sp-…` on Qwen platforms).
- README: profile override example with the "config is replaced, not deep-merged" caveat; endpoint/key-format table (Qwen/DashScope China, QwenCloud international, Zhipu, Ollama); local/`link:` install note (run `pnpm install` inside the plugin folder); security note recommending `VISION_API_KEY` over storing the key in patch files.
- npm metadata (`repository`, `homepage`, `bugs`, `publishConfig`).

### Changed

- First release on the npm registry (`dsh-vision-proxy@0.1.1`).

## [0.1.0] - 2026-08-13

### Added

- `deepseek-vision` provider route wrapping the inner DeepSeek adapter: declares image input so GUI attachments and the `read_image` gate admit images, and transcribes every image block to text through an OpenAI-compatible VLM (`qwen3.7-flash` on DashScope compatible-mode by default) before delegating to DeepSeek.
- Per-`attachmentId` in-process transcription cache (capped at 100).
- Bilingual README (EN + zh-CN) with live mid-task vision demo.
- `dsh.bundle` patch (`cordis.patch.yml`) so `dsh plugin add` wires the plugin into the profile's bundle layers automatically.

[0.1.3]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Flyvhidbwo/dsh-vision-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Flyvhidbwo/dsh-vision-proxy/releases/tag/v0.1.0
