// dsh-vision-proxy core tests: fallback chain, content-hash cache, error
// classification, retry-once, key resolution, downscale guard.
// Run: npm test  (node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as plugin from '../lib/index.js';

const { classifyHttpError, parseRetryAfter, resolveApiKey, transcribeWithFallback, transcribeImage, transcribeRequest, hasImage, maybeDownscale, detectLocalOllama } = plugin._test;

const imgBytes = Buffer.from('fake-image-bytes-for-hash-test');
const ref = { attachmentId: 'att-1', mediaType: 'image/png' };
const ctx = { get: () => ({ readImage: async () => ({ ref, data: imgBytes }) }) };

function makeFetchMock(handler) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return handler(url, opts, calls.length);
    };
    return calls;
}
const res = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? null },
    text: async () => body,
});
const okBody = (content) => JSON.stringify({ choices: [{ message: { content } }] });

test('classifyHttpError: kinds', () => {
    assert.equal(classifyHttpError(429, '{}').kind, 'rate_limit');
    assert.equal(classifyHttpError(402, '{"error":"insufficient_quota"}').kind, 'quota');
    assert.equal(classifyHttpError(400, 'quota exhausted').kind, 'quota');
    assert.equal(classifyHttpError(401, '{"error":"invalid_api_key"}').kind, 'auth');
    assert.equal(classifyHttpError(403, 'model not available in your region').kind, 'region');
    assert.equal(classifyHttpError(404, '{"error":"model not found"}').kind, 'model_not_found');
    assert.equal(classifyHttpError(400, 'maximum context length exceeded').kind, 'context_too_large');
    assert.equal(classifyHttpError(500, 'oops').kind, 'http');
    // hints are actionable, never empty
    for (const s of [429, 402, 401, 404, 400, 500]) {
        assert.ok(classifyHttpError(s, 'x').hint.length > 10);
    }
});

test('parseRetryAfter', () => {
    assert.equal(parseRetryAfter('5'), 5);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('abc'), undefined);
});

test('resolveApiKey: anonymous and missing key', () => {
    assert.equal(resolveApiKey({ anonymous: true }, 'https://x.com'), '');
    assert.throws(() => resolveApiKey({ anonymous: false, apiKey: '' }, 'https://x.com'));
    assert.equal(resolveApiKey({ anonymous: false, apiKey: 'k' }, 'https://x.com'), 'k');
});

test('429 retries once with Retry-After backoff', async () => {
    const calls = makeFetchMock(async (url, opts, n) => {
        if (n === 1) return res(429, '{"error":"rate limit"}', { 'retry-after': '1' });
        return res(200, okBody('ok after retry'));
    });
    const t0 = Date.now();
    const text = await transcribeRequest(ctx, { baseURL: 'https://mock', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false }, 'image/png', imgBytes);
    assert.equal(text, 'ok after retry');
    assert.equal(calls.length, 2);
    assert.ok(Date.now() - t0 >= 900);
});

test('fallback chain: primary fails, fallback succeeds', async () => {
    makeFetchMock(async (url) => {
        if (url.includes('primary')) return res(500, '{"error":"boom"}');
        return res(200, okBody('from fallback'));
    });
    const resolved = { baseURL: 'https://primary', model: 'main', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, marker: '[X]' };
    const fallbacks = [{ baseURL: 'https://fallback', model: 'fb', apiKey: 'k', anonymous: false, timeoutMs: 5000, maxTokens: 10, maxImagePixels: 0 }];
    const { text } = await transcribeWithFallback(ctx, resolved, fallbacks, ref, undefined, new Map());
    assert.equal(text, 'from fallback');
});

test('fallback chain: all fail → combined classified error (failureMode "error")', async () => {
    makeFetchMock(async () => res(401, '{"error":"bad key"}'));
    const resolved = { baseURL: 'https://a', model: 'main', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, failureMode: 'error' };
    const fallbacks = [{ baseURL: 'https://b', model: 'fb', apiKey: 'k', anonymous: false, timeoutMs: 5000, maxTokens: 10, maxImagePixels: 0 }];
    await assert.rejects(
        transcribeWithFallback(ctx, resolved, fallbacks, ref, undefined, new Map()),
        (err) => err.message.includes('all 2 vision model(s) failed')
            && err.message.includes('main @ https://a')
            && err.message.includes('fb @ https://b')
            && err.message.includes('(auth)'),
    );
});

test('fallback chain: keyless main is skipped, anonymous fallback used', async () => {
    const calls = makeFetchMock(async (url) => {
        if (!url.includes('free')) throw new Error(`unexpected url ${url}`);
        return res(200, okBody('from free endpoint'));
    });
    const resolved = { baseURL: 'https://paid', model: 'main', apiKey: '', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0 };
    const fallbacks = [{ baseURL: 'https://free', model: 'Qwen2.5-VL-72B-Instruct', apiKey: '', anonymous: true, timeoutMs: 5000, maxTokens: 10, maxImagePixels: 0 }];
    const { text } = await transcribeWithFallback(ctx, resolved, fallbacks, ref, undefined, new Map());
    assert.equal(text, 'from free endpoint');
    assert.equal(calls.length, 1); // the keyless main never reached the network
    assert.ok(calls[0].url.includes('free'));
});

test('content-hash cache: same bytes, different attachment ids → one request', async () => {
    const calls = makeFetchMock(async () => res(200, okBody('cached text')));
    const config = { baseURL: 'https://c', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, marker: '[X]' };
    const cache = new Map();
    const r1 = await transcribeImage(ctx, config, { attachmentId: 'att-A', mediaType: 'image/png' }, undefined, cache);
    const r2 = await transcribeImage(ctx, config, { attachmentId: 'att-B', mediaType: 'image/png' }, undefined, cache);
    assert.equal(calls.length, 1);
    assert.equal(r1.text, r2.text);
    assert.equal(r1.hash, createHash('sha256').update(imgBytes).digest('hex'));
});

test('Config schema: defaults and fallback entries', () => {
    const c = plugin.Config({ fallbackModels: [{ model: 'Qwen2.5-VL-72B-Instruct', anonymous: true }] });
    assert.equal(c.model, 'qwen3.7-flash');
    assert.equal(c.maxTokens, 4096);
    assert.equal(c.timeoutMs, 120000);
    assert.equal(c.maxImagePixels, 4_000_000);
    assert.equal(c.autoLocalOllama, true);
    assert.equal(c.failureMode, 'placeholder');
    assert.equal(c.fallbackModels.length, 1);
    assert.equal(c.fallbackModels[0].baseURL, undefined); // absent keys stay absent
});

test('anonymous 429 fails fast without retry', async () => {
    const calls = makeFetchMock(async () => res(429, '{"error":"rate limit"}', { 'retry-after': '1' }));
    const t0 = Date.now();
    await assert.rejects(
        transcribeRequest(ctx, { baseURL: 'https://anon', model: 'm', apiKey: '', maxTokens: 10, timeoutMs: 5000, anonymous: true }, 'image/png', imgBytes),
        (err) => err.message.includes('rate_limit') && err.message.includes('not retried'),
    );
    assert.equal(calls.length, 1); // no Retry-After sleep for anonymous endpoints
    assert.ok(Date.now() - t0 < 800); // fast failure, never a stall
});

test('cooldown: an endpoint that just hit 429 is skipped on the next call', async () => {
    const calls = makeFetchMock(async () => res(429, '{"error":"rate limit"}'));
    const resolved = { baseURL: 'https://flaky', model: 'main', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, failureMode: 'error' };
    const cooldowns = new Map();
    await assert.rejects(transcribeWithFallback(ctx, resolved, [], ref, undefined, new Map(), cooldowns));
    assert.ok(cooldowns.get('https://flaky') > Date.now()); // cooldown armed
    await assert.rejects(
        transcribeWithFallback(ctx, resolved, [], ref, undefined, new Map(), cooldowns),
        (err) => err.message.includes('cooling down'),
    );
    assert.equal(calls.length, 1); // second call never reached the network
});

test('network failure cools the endpoint down; placeholder mode keeps the session alive', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new TypeError('fetch failed'); };
    const resolved = { baseURL: 'https://dead', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, failureMode: 'placeholder', marker: '[X]' };
    const cache = new Map();
    const cooldowns = new Map();
    // first turn: network error → placeholder, no throw
    const r1 = await transcribeWithFallback(ctx, resolved, [], ref, undefined, cache, cooldowns);
    assert.ok(r1.text.includes('[图片转译失败:'), r1.text);
    assert.equal(calls, 1);
    assert.ok(cooldowns.get('https://dead') > Date.now()); // transport failure armed the cooldown
    // second turn (different attachment id, same bytes): failure marker + cooldown → zero network
    const r2 = await transcribeWithFallback(ctx, resolved, [], { ...ref, attachmentId: 'att-2' }, undefined, cache, cooldowns);
    assert.ok(r2.text.includes('[图片转译失败:'), r2.text);
    assert.equal(calls, 1); // the dead endpoint is never hammered again within the cooldown
});

test('failureMode "error" still fails the whole turn', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new TypeError('fetch failed'); };
    const resolved = { baseURL: 'https://dead', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, failureMode: 'error', marker: '[X]' };
    await assert.rejects(
        transcribeWithFallback(ctx, resolved, [], ref, undefined, new Map(), new Map()),
        (err) => err.message.includes('all 1 vision model(s) failed'),
    );
    assert.equal(calls, 1);
});

test('detectLocalOllama: picks a vision model, honors preferred, fails to null', async () => {
    const fetchImpl = async () => res(200, JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'qwen3-vl:4b' }] }));
    const picked = await detectLocalOllama(fetchImpl, 'http://localhost:11434/v1', 1500, '');
    assert.equal(picked.model, 'qwen3-vl:4b');
    const preferred = await detectLocalOllama(fetchImpl, 'http://localhost:11434/v1', 1500, 'llama3.2');
    assert.equal(preferred.model, 'llama3.2');
    const broken = await detectLocalOllama(async () => res(500, 'boom'), 'http://localhost:11434/v1', 1500, '');
    assert.equal(broken, null);
    const empty = await detectLocalOllama(async () => res(200, JSON.stringify({ data: [] })), 'http://localhost:11434/v1', 1500, '');
    assert.equal(empty, null);
});

test('maybeDownscale: disabled, small files and failure all pass through', async () => {
    // disabled
    const r1 = await maybeDownscale(imgBytes, 0);
    assert.equal(r1.data, imgBytes);
    // small file skips sharp entirely
    const r2 = await maybeDownscale(imgBytes, 4_000_000);
    assert.equal(r2.data, imgBytes);
    // big-enough buffer without sharp installed → graceful passthrough
    const big = Buffer.alloc(600 * 1024, 7);
    const r3 = await maybeDownscale(big, 4_000_000);
    assert.equal(r3.data, big);
});

test('hasImage detects image blocks recursively', () => {
    assert.ok(hasImage([{ type: 'image' }]));
    assert.ok(hasImage([{ type: 'tool-result', content: [{ type: 'image' }] }]));
    assert.ok(!hasImage([{ type: 'text', text: 'x' }]));
});
