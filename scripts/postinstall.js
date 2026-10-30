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
    console.log('dsh-vision-proxy: 无需额外 key —— 识图默认走 DeepSeek 官方视觉模型（复用你的 DEEPSEEK_API_KEY）；本机装有 Ollama 时也会自动加入降级链（图片不出本机）。两者都没有时，识图会快速失败并给出明确指引，不会卡死。');
    console.log('dsh-vision-proxy: no extra key needed —— transcription defaults to DeepSeek\'s official vision model (reuses DEEPSEEK_API_KEY); a local Ollama is appended automatically when running (images stay on this machine). Otherwise transcription fails fast with guidance.');
}

function printHasKey() {
    console.log('');
    console.log('dsh-vision-proxy: 好的 —— 也可以把 VISION_API_KEY / DASHSCOPE_API_KEY（百炼 sk-ws-… / sk-…）填到「设置 → 识图代理」里改走百炼（qwen3.7-flash，便宜且不限速）。Windows 下环境变量变更可能不生效，设置页写入最可靠。');
    console.log('dsh-vision-proxy: OK —— you can also point transcription at DashScope (qwen3.7-flash: cheap, no rate limit) from Settings → Vision proxy with a VISION_API_KEY / DASHSCOPE_API_KEY. On Windows the settings page is more reliable than environment variables.');
}

async function main() {
    console.log('');
    console.log('dsh-vision-proxy: PRIVACY NOTICE / 隐私提示 —— image bytes are sent to a third-party VLM endpoint for transcription · 图片字节会发送到第三方 VLM 端点进行转译。');
    if (!process.stdin.isTTY || process.env.CI !== undefined) {
        // Non-interactive (CI, scripts, package managers that don't attach a TTY):
        // never hang the install — free default applies.
        printNoKey();
        console.log('dsh-vision-proxy: 安装完成 —— 重启 dsh 后生效；之后在「设置 → 识图代理」里改配置（实时生效）/ install done — restart dsh; then configure it in Settings → Vision proxy (applies live).');
        return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        rl.question('你有额外的 VLM API key 吗（百炼/智谱等；没有则默认用 DeepSeek 官方视觉模型或本机 Ollama）？Do you have an extra VLM API key? (y/N) ', (a) => resolve(a.trim().toLowerCase()));
    });
    rl.close();
    if (answer === 'y' || answer === 'yes') {
        printHasKey();
    } else {
        printNoKey();
    }
    console.log('dsh-vision-proxy: 安装完成 —— 重启 dsh 后生效 / install done — restart dsh to activate.');
}

main().catch((error) => {
    console.error('dsh-vision-proxy: postinstall prompt failed:', error.message);
    process.exit(0); // never break the install
});
