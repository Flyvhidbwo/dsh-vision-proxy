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
    // Volatile fields are live references; read through them like apply() does.
    const read = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value);
    const c = plugin.Config({ fallbackModels: [{ model: 'Qwen2.5-VL-72B-Instruct', anonymous: true }] });
    assert.equal(read(c.model), 'qwen3.7-flash');
    assert.equal(read(c.maxTokens), 8192); // thinking models need room for reasoning + transcription
    assert.equal(read(c.timeoutMs), 120000);
    assert.equal(read(c.maxImagePixels), 4_000_000);
    assert.equal(read(c.keepAlive), '30m');
    assert.equal(read(c.nativeVisionPassThrough), true);
    assert.equal(c.autoLocalOllama, true);
    assert.equal(read(c.failureMode), 'placeholder');
    assert.equal(c.fallbackModels.length, 1);
    assert.equal(c.fallbackModels[0].baseURL, undefined); // absent keys stay absent
    // The Settings page can only edit volatile fields: the live-editable ones must be refs.
    for (const key of ['baseURL', 'apiKey', 'model', 'maxTokens', 'timeoutMs', 'maxImagePixels', 'keepAlive', 'marker', 'failureMode', 'deepseekVision', 'deepseekVisionModel', 'autoLocalOllama', 'localOllamaModel', 'nativeVisionPassThrough', 'abortWithSession']) {
        if (key === 'autoLocalOllama') continue; // restart-only on purpose
        assert.equal(typeof c[key]?.get, 'function', `${key} must be volatile so Settings can edit it`);
    }
    // Mount-time wiring stays ordinary config.
    for (const key of ['providerId', 'innerProvider', 'autoLocalOllama', 'fallbackModels']) {
        assert.notEqual(typeof c[key]?.get, 'function', `${key} must stay non-volatile`);
    }
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

// dsh >= 0.1.1-rc.2: the llm runtime calls adapter.prepareCall(provider, model, signal)
// and dispatches through the returned `stream` entry point. Simulate that exact chain:
// apply() registers the proxy → prepareCall → stream → inner.stream receives transcribed messages.
test('adapter prepareCall contract (dsh >= 0.1.1-rc.2)', async () => {
    const innerReceived = [];
    const mockInner = {
        providerRetryPolicy: () => undefined,
        listModels: async () => [],
        resolveModel: async (provider, model) => ({
            provider, id: model, name: model, inputModalities: ['text'],
            context: { contextWindow: 1000000 }, defaultMaxTokens: 4096,
        }),
        stream: async function* (options) {
            innerReceived.push(options.messages);
            yield { type: 'delta', text: 'ok' };
        },
    };
    let registered = null;
    const mockCtx = {
        get: (name) => name === 'attachments'
            ? { readImage: async (r) => ({ ref: { mediaType: 'image/png' }, data: imgBytes }) }
            : undefined,
        llm: {
            registration: () => ({ adapter: mockInner }),
            registerAdapter: (routes, adapter) => { registered = adapter; },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    // fetch mock: Ollama probe fails fast; VLM transcription succeeds.
    makeFetchMock(async (url) => {
        if (url.includes('/models')) return res(500, 'no ollama');
        return res(200, okBody('transcribed via VLM'));
    });
    plugin.apply(mockCtx, { apiKey: 'test-key' });
    assert.ok(registered, 'adapter registered');
    assert.equal(typeof registered.prepareCall, 'function', 'prepareCall present on proxy');

    const adapterCall = await registered.prepareCall('deepseek-vision', 'deepseek-v4-flash', undefined);
    assert.ok(adapterCall.model.inputModalities.includes('image'), 'claims image modality');
    assert.equal(typeof adapterCall.stream, 'function');

    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
        ],
    }];
    const stream = adapterCall.stream({ provider: 'deepseek-vision', model: 'deepseek-v4-flash', messages });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(chunks.some((c) => c.type === 'delta'));
    assert.equal(innerReceived.length, 1, 'inner.stream dispatched once');
    const sent = innerReceived[0][0].content;
    const imageBlocks = sent.filter((b) => b.type === 'image');
    assert.equal(imageBlocks.length, 0, 'image block transcribed away before inner');
    assert.ok(sent.some((b) => b.type === 'text' && b.text.includes('图片转译')), 'marker present');
    assert.ok(sent.some((b) => b.type === 'text' && b.text.includes('transcribed via VLM')), 'transcription text present');
});

// ---------------------------------------------------------------------------
// dsh 0.2.x compatibility
// ---------------------------------------------------------------------------

/** A ctx whose `llm.registration()` behaves like dsh 0.2.x: it THROWS NO_ADAPTER. */
function makeCtx({ attachments, inner }) {
    const state = { adapter: null, inner };
    const ctx = {
        get: (service) => service === 'attachments' ? attachments : undefined,
        llm: {
            registration: (provider) => {
                if (state.inner === null) {
                    const error = new Error(`no adapter registered for provider "${provider}"`);
                    error.code = 'NO_ADAPTER';
                    throw error;
                }
                return { provider: { id: provider, name: 'DeepSeek' }, adapter: state.inner };
            },
            registerAdapter: (routes, adapter) => { state.adapter = adapter; state.routes = routes; },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    return { ctx, state };
}

function makeInner(overrides = {}) {
    const received = [];
    const inner = {
        providerRetryPolicy: () => undefined,
        listModels: async (provider) => [{ provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
        resolveModel: async (provider, model) => ({
            provider, id: model, name: model, inputModalities: ['text'],
            context: { contextWindow: 1_000_000 }, defaultMaxTokens: 4096,
        }),
        stream: async function* (options) {
            received.push(options);
            yield { type: 'delta', text: 'ok' };
        },
        ...overrides,
    };
    return { inner, received };
}

test('lazy inner adapter: apply() succeeds before the wrapped provider registered (dsh 0.2.x)', async () => {
    makeFetchMock(async (url) => url.includes('/models') ? res(500, 'no ollama') : res(200, okBody('vlm')));
    const attachments = { readImageRequest: async () => ({ data: imgBytes, mediaType: 'image/png' }) };
    const { ctx, state } = makeCtx({ attachments, inner: null });

    // The wrapped provider is not there yet: apply() must still register the route.
    plugin.apply(ctx, { apiKey: 'k' });
    assert.ok(state.adapter, 'adapter registered even though the inner route is missing');

    // Querying the route while the inner adapter is absent must not throw.
    assert.equal(state.adapter.providerRetryPolicy('deepseek-vision'), undefined);

    // The wrapped provider activates later.
    const { inner, received } = makeInner();
    state.inner = inner;

    const adapterCall = await state.adapter.prepareCall('deepseek-vision', 'deepseek-v4-pro', undefined);
    assert.equal(adapterCall.model.provider, 'deepseek-vision');
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png' } }] }];
    const chunks = [];
    for await (const chunk of adapterCall.stream({ provider: 'deepseek-vision', model: 'deepseek-v4-pro', messages })) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.equal(received.length, 1, 'inner stream dispatched');
    assert.equal(received[0].provider, 'deepseek-official', 'inner route forwarded, not the proxy route');
    assert.ok(received[0].messages[0].content.some((b) => b.type === 'text' && b.text.includes('vlm')), 'image transcribed');
});

test('catalog and exact-model metadata are stamped with the route the caller asked about', async () => {
    makeFetchMock(async () => res(500, 'no ollama'));
    const { ctx, state } = makeCtx({ attachments: { readImage: async () => ({ ref: { mediaType: 'image/png' }, data: imgBytes }) }, inner: null });
    plugin.apply(ctx, { apiKey: 'k' });
    const { inner } = makeInner();
    state.inner = inner;

    // The inner adapter stamps its OWN route on every row (as deepseek-official does).
    const models = await state.adapter.listModels('deepseek-vision');
    assert.equal(models.length, 1);
    assert.equal(models[0].provider, 'deepseek-vision', 'row restamped for the proxy route');
    assert.equal(models[0].id, 'deepseek-v4-pro');

    const info = await state.adapter.resolveModel('deepseek-vision', 'deepseek-v4-pro', undefined);
    assert.equal(info.provider, 'deepseek-vision');
    assert.ok(info.inputModalities.includes('image'), 'declares image input');
});

test('imageTargetFor: aspect-preserving downscale target and safe fallbacks', () => {
    const { imageTargetFor } = plugin._test;
    const t = imageTargetFor({ width: 4000, height: 3000, bytes: 900_000 }, 1_000_000);
    assert.ok(t.width * t.height <= 1_000_000 + 1000, `product ${t.width * t.height} within the pixel budget`);
    assert.ok(Math.abs((t.width / t.height) - (4000 / 3000)) < 0.01, 'aspect ratio preserved');
    assert.equal(t.maxBytes, 900_000);
    // small image keeps its dimensions
    const same = imageTargetFor({ width: 800, height: 600, bytes: 50_000 }, 4_000_000);
    assert.deepEqual(same, { width: 800, height: 600, maxBytes: 50_000 });
    // missing metadata falls back to a square safe target, still honoring the pixel budget
    const unknown = imageTargetFor({ mediaType: 'image/png' }, 4_000_000);
    assert.equal(unknown.width, unknown.height, 'unknown intrinsic size uses a square target');
    assert.ok(unknown.width * unknown.height <= 4_000_000 + 1000);
    assert.ok(unknown.maxBytes > 0);
});

test('readImageBytes: prefers the public readImageRequest projection (dsh >= 0.2)', async () => {
    const targets = [];
    const attachments = {
        readImageRequest: async (ref, target) => { targets.push(target); return { data: imgBytes, mediaType: 'image/jpeg' }; },
        readImage: async () => { throw new Error('legacy readImage must not be used when projection is available'); },
    };
    const calls = makeFetchMock(async () => res(200, okBody('from projection')));
    const config = { baseURL: 'https://p', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 1_000_000, marker: '[X]' };
    const r = await transcribeImage({ get: () => attachments }, config, { attachmentId: 'a', mediaType: 'image/png', width: 4000, height: 3000, bytes: 900_000 }, undefined, new Map());
    assert.equal(r.text, 'from projection');
    assert.equal(calls.length, 1);
    assert.equal(targets.length, 1);
    assert.ok(targets[0].width * targets[0].height <= 1_000_000 + 1000);
});

test('readImageBytes: falls back to readImage when the backend has no request projection', async () => {
    const attachments = {
        readImageRequest: async () => { const error = new Error('no projection'); error.code = 'ATTACHMENT_PROJECTION_UNSUPPORTED'; throw error; },
        readImage: async () => ({ ref: { mediaType: 'image/png' }, data: imgBytes }),
    };
    makeFetchMock(async () => res(200, okBody('legacy path')));
    const config = { baseURL: 'https://p', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, marker: '[X]' };
    const r = await transcribeImage({ get: () => attachments }, config, ref, undefined, new Map());
    assert.equal(r.text, 'legacy path');
});

test('loopback endpoints are not anonymous public tiers: keep_alive sent, no 20 s cap', async () => {
    const calls = makeFetchMock(async () => res(200, okBody('local ok')));
    const text = await transcribeRequest(ctx, {
        baseURL: 'http://localhost:11434/v1', model: 'qwen3-vl:8b', apiKey: '', maxTokens: 10,
        timeoutMs: 300_000, anonymous: true, keepAlive: '30m',
    }, 'image/png', imgBytes);
    assert.equal(text, 'local ok');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.keep_alive, '30m', 'Ollama keeps the model resident');
    // a public endpoint must not receive an Ollama-specific field
    const publicCalls = makeFetchMock(async () => res(200, okBody('remote ok')));
    await transcribeRequest(ctx, {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash', apiKey: 'k', maxTokens: 10,
        timeoutMs: 5000, anonymous: false, keepAlive: '30m',
    }, 'image/png', imgBytes);
    const publicBody = JSON.parse(publicCalls[0].opts.body);
    assert.equal(publicBody.keep_alive, undefined);
});

test('loopback 429 honors Retry-After instead of failing fast like a public anonymous tier', async () => {
    const calls = makeFetchMock(async (url, opts, n) => n === 1
        ? res(429, '{"error":"busy"}', { 'retry-after': '0' })
        : res(200, okBody('after retry')));
    const text = await transcribeRequest(ctx, {
        baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:8b', apiKey: '', maxTokens: 10,
        timeoutMs: 5000, anonymous: true, keepAlive: '30m',
    }, 'image/png', imgBytes);
    assert.equal(text, 'after retry');
    assert.equal(calls.length, 2, 'loopback rate limit is retried, not treated as a hostile free tier');
});

test('transcription no longer chains the session abort signal by default', async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
        seen.push(opts.signal);
        return res(200, okBody('decoupled'));
    };
    const controller = new AbortController();
    const config = { baseURL: 'https://x', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, keepAlive: '' };
    await transcribeRequest(ctx, config, 'image/png', imgBytes, controller.signal);
    assert.ok(seen[0], 'request is still bounded by its own timeout signal');
    controller.abort();
    // the same aborted session signal must not retroactively kill a later turn
    await transcribeRequest(ctx, config, 'image/png', imgBytes, controller.signal);
    assert.equal(seen.length, 2);
});

test('reasoning-only VLM reply is used instead of discarded', async () => {
    makeFetchMock(async () => res(200, JSON.stringify({ choices: [{ message: { content: '', reasoning: 'the screenshot shows a settings dialog' } }] })));
    const text = await transcribeRequest(ctx, { baseURL: 'https://r', model: 'm', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, keepAlive: '' }, 'image/png', imgBytes);
    assert.equal(text, 'the screenshot shows a settings dialog');
});

test('placeholder reports every attempt, not just the first', async () => {
    makeFetchMock(async () => res(401, '{"error":"bad key"}'));
    const resolved = { baseURL: 'https://a', model: 'main', apiKey: 'k', maxTokens: 10, timeoutMs: 5000, anonymous: false, maxImagePixels: 0, failureMode: 'placeholder', marker: '[X]' };
    const fallbacks = [{ baseURL: 'https://b', model: 'fb', apiKey: 'k', anonymous: false, timeoutMs: 5000, maxTokens: 10, maxImagePixels: 0 }];
    const { text } = await transcribeWithFallback(ctx, resolved, fallbacks, ref, undefined, new Map());
    assert.ok(text.includes('[图片转译失败:'), text);
    assert.ok(text.includes('main @ https://a'), `first attempt present: ${text}`);
    assert.ok(text.includes('fb @ https://b'), `fallback attempt present: ${text}`);
});

test('native vision pass-through: a model that already sees images is not transcribed', async () => {    const { inner, received } = makeInner({
        resolveModel: async (provider, model) => ({
            provider, id: model, name: model, inputModalities: ['text', 'image'],
            context: { contextWindow: 1_000_000 }, defaultMaxTokens: 4096,
        }),
    });
    const calls = makeFetchMock(async (url) => url.includes('/models') ? res(500, 'no ollama') : res(200, okBody('should not be called')));
    const { ctx, state } = makeCtx({ attachments: { readImageRequest: async () => ({ data: imgBytes, mediaType: 'image/png' }) }, inner: null });
    plugin.apply(ctx, { apiKey: 'k' });
    state.inner = inner;
    const adapterCall = await state.adapter.prepareCall('deepseek-vision', 'deepseek-v4-flash-vision-exp', undefined);
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png' } }] }];
    for await (const chunk of adapterCall.stream({ provider: 'deepseek-vision', model: 'deepseek-v4-flash-vision-exp', messages })) void chunk;
    assert.equal(received.length, 1);
    assert.ok(received[0].messages[0].content.some((b) => b.type === 'image'), 'image passed through untouched');
    // only the Ollama probe touched the network, no VLM transcription call
    assert.equal(calls.filter((c) => !c.url.includes('/models')).length, 0);
});

test('inner route auto-detection: a signed-in profile (deepseek-account) works without reconfiguring', async () => {
    makeFetchMock(async (url) => url.includes('/models') ? res(500, 'no ollama') : res(200, okBody('vlm')));
    const { inner, received } = makeInner();
    const ctx = {
        get: () => ({ readImageRequest: async () => ({ data: imgBytes, mediaType: 'image/png' }) }),
        llm: {
            listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
            registration: (provider) => {
                if (provider !== 'deepseek-account') {
                    const error = new Error(`no adapter registered for provider "${provider}"`);
                    error.code = 'NO_ADAPTER';
                    throw error;
                }
                return { provider: { id: 'deepseek-account', name: 'DeepSeek 账号' }, adapter: inner };
            },
            registerAdapter: (routes, adapter) => { ctx._adapter = adapter; },
        },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    plugin.apply(ctx, {}); // default innerProvider is deepseek-official, which is disabled here
    const adapterCall = await ctx._adapter.prepareCall('deepseek-vision', 'deepseek-v4-pro', undefined);
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png' } }] }];
    for await (const chunk of adapterCall.stream({ provider: 'deepseek-vision', model: 'deepseek-v4-pro', messages })) void chunk;
    assert.equal(received.length, 1);
    assert.equal(received[0].provider, 'deepseek-account', 'the registered account route was wrapped');
});
