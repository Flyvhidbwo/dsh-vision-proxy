#!/usr/bin/env node
/**
 * dsh-vision-proxy install-time consent/key prompt.
 *
 * Runs from `npm install` (postinstall). Asks the installing user one
 * question: do you have a VLM API key?  — no key → the free anonymous
 * model is the effective default (zero config); key → they are pointed at
 * the fast paid path (export VISION_API_KEY / DASHSCOPE_API_KEY).
 *
 * Never fails the install: non-TTY / CI environments skip the prompt and
 * assume the free default. This script only informs — it writes nothing.
 */
import { createInterface } from 'node:readline';
import process from 'node:process';

function printNoKey() {
    console.log('');
    console.log('dsh-vision-proxy: 未配置 key —— 将自动尝试本地 Ollama（http://localhost:11434，若已安装，图片不出本机）；两者都没有时，识图会快速失败并给出明确指引，不会卡死。有 key 时请导出 VISION_API_KEY / DASHSCOPE_API_KEY（Windows 下建议直接写入插件配置）或安装 Ollama。');
    console.log('dsh-vision-proxy: no key set —— local Ollama (http://localhost:11434) is auto-detected when available (images stay on this machine); otherwise transcription fails fast with guidance. Export VISION_API_KEY / DASHSCOPE_API_KEY (or write apiKey into the plugin config on Windows) or install Ollama.');
}

function printHasKey() {
    console.log('');
    console.log('dsh-vision-proxy: 好的 —— 请导出 VISION_API_KEY 或 DASHSCOPE_API_KEY（百炼 sk-ws-… / sk-…）后重启 dsh，即可走付费快速通道（qwen3.7-flash，不限速）；也可以按 README 把 baseURL/model 改成你用的端点。Windows 下环境变量变更可能不生效，直写 apiKey 配置最可靠。');
    console.log('dsh-vision-proxy: OK —— export VISION_API_KEY or DASHSCOPE_API_KEY and restart dsh to use the fast paid path (qwen3.7-flash, no rate limit); or point baseURL/model at your own endpoint (see README). On Windows, writing apiKey into the plugin config is more reliable than environment variables.');
}

async function main() {
    console.log('');
    console.log('dsh-vision-proxy: PRIVACY NOTICE / 隐私提示 —— image bytes are sent to a third-party VLM endpoint for transcription · 图片字节会发送到第三方 VLM 端点进行转译。');
    if (!process.stdin.isTTY || process.env.CI !== undefined) {
        // Non-interactive (CI, scripts, package managers that don't attach a TTY):
        // never hang the install — free default applies.
        printNoKey();
        return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        rl.question('你有 API key 吗（百炼/智谱等；没有则自动尝试本地 Ollama 或快速失败提示）？Do you have a VLM API key? (y/N) ', (a) => resolve(a.trim().toLowerCase()));
    });
    rl.close();
    if (answer === 'y' || answer === 'yes') {
        printHasKey();
    } else {
        printNoKey();
    }
}

main().catch((error) => {
    console.error('dsh-vision-proxy: postinstall prompt failed:', error.message);
    process.exit(0); // never break the install
});
