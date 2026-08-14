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

const FREE_ENDPOINT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1 · Qwen2.5-VL-72B-Instruct';

function printNoKey() {
    console.log('');
    console.log('dsh-vision-proxy: 未配置 key —— 将使用免费模型（OVHcloud 匿名端点，限速约 2 次/分/IP），零配置，重启 dsh 即可用。');
    console.log('dsh-vision-proxy: no key set —— using the free anonymous model (OVHcloud AI Endpoints, ~2 req/min/IP). Zero config; restart dsh to use it.');
}

function printHasKey() {
    console.log('');
    console.log('dsh-vision-proxy: 好的 —— 请导出 VISION_API_KEY 或 DASHSCOPE_API_KEY（百炼 sk-ws-… / sk-…）后重启 dsh，即可走付费快速通道（qwen3.7-flash，不限速）；也可以按 README 把 baseURL/model 改成你用的端点。');
    console.log('dsh-vision-proxy: OK —— export VISION_API_KEY or DASHSCOPE_API_KEY and restart dsh to use the fast paid path (qwen3.7-flash, no rate limit); or point baseURL/model at your own endpoint (see README).');
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
        rl.question('你有 API key 吗（百炼/智谱等；没有则默认免费模型）？Do you have a VLM API key? (y/N) ', (a) => resolve(a.trim().toLowerCase()));
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
