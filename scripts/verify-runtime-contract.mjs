/**
 * Contract verification against a REAL @deepseek-ai/dsh-llm runtime.
 *
 * The unit tests mock the adapter boundary; this script mounts the proxy into
 * the actual dsh 0.2.x runtime and drives the exact code paths the runtime uses
 * (catalog validation, exact-model normalization, prepareCall dispatch, stream
 * projection). It catches "our mock agreed with our mock" mistakes.
 *
 * Run it from a directory whose node_modules contains `@deepseek-ai/dsh-llm`
 * and `@deepseek-ai/cordis` — e.g. a `dsh` installation:
 *
 *   cd <dir-with-dsh-installed>
 *   node <path-to-this-repo>/scripts/verify-runtime-contract.mjs
 *
 * Or install the two packages in a scratch directory:
 *
 *   npm i @deepseek-ai/dsh-llm@0.2.1-rc.5 @deepseek-ai/cordis@~4.0.5
 *   node scripts/verify-runtime-contract.mjs
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve the runtime from the CURRENT WORKING DIRECTORY, so the script can
// live in this repository while running against any dsh installation:
//   cd <dir-with-@deepseek-ai/dsh-llm-installed>
//   node <repo>/scripts/verify-runtime-contract.mjs
const requireFromCwd = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
async function loadFromCwd(specifier) {
    let resolved;
    try {
        resolved = requireFromCwd.resolve(specifier);
    } catch (error) {
        throw new Error(`cannot resolve ${specifier} from ${process.cwd()} — run this script from a directory where that package is installed (${error.message})`);
    }
    return import(pathToFileURL(resolved).href);
}

const { Context } = await loadFromCwd('@deepseek-ai/cordis');
const { default: LlmRuntime } = await loadFromCwd('@deepseek-ai/dsh-llm');

const pluginUrl = new URL('../lib/index.js', import.meta.url).href;
const plugin = await import(pluginUrl);

const results = [];
async function check(name, fn) {
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
        results.push({ name, ok: false });
        console.log(`FAIL ${name} — ${error?.message ?? error}`);
    }
}

// ── mock the transcription endpoint and the Ollama probe ───────────────────
const fetchCalls = [];
globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), body: options?.body });
    if (String(url).includes('/models')) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'no ollama' };
    }
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ message: { content: '转译文本：一张设置对话框截图' } }] }),
    };
};

// ── a stand-in for the wrapped DeepSeek adapter ────────────────────────────
const innerReceived = [];
const innerAdapter = {
    providerInfo: (provider) => ({ id: provider, name: 'DeepSeek' }),
    providerRetryPolicy: () => undefined,
    listModels: async (provider) => [
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'], context: { contextWindow: 1048576 } },
        { provider, id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text', 'image'], context: { contextWindow: 1048576 } },
    ],
    resolveModel: async (provider, model) => ({
        provider, id: model, name: model,
        inputModalities: model === 'deepseek-flash' ? ['text', 'image'] : ['text'],
        context: { contextWindow: 1048576 }, defaultMaxTokens: 8192,
    }),
    prepareCall: async (provider, model) => ({
        model: await innerAdapter.resolveModel(provider, model),
        stream: (options) => innerAdapter.stream(options),
    }),
    stream: async function* (options) {
        innerReceived.push(options);
        yield { type: 'delta', text: 'answer from deepseek brain' };
    },
};

const attachments = {
    // dsh >= 0.2 public projection API
    readImageRequest: async (ref, target) => ({ data: new Uint8Array([1, 2, 3, 4, 5]), mediaType: 'image/png', width: target.width, height: target.height }),
};

// ── the real runtime ───────────────────────────────────────────────────────
const ctx = new Context();
const llm = new LlmRuntime(ctx);
llm.registerAdapter(['deepseek-official'], innerAdapter);

const pluginCtx = {
    get: (name) => (name === 'attachments' ? attachments : undefined),
    llm,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};
plugin.apply(pluginCtx, { apiKey: 'test-key' });

await check('provider route is registered with the runtime', () => {
    const providers = llm.listProviders().map((provider) => provider.id);
    if (!providers.includes('deepseek-vision')) throw new Error(`providers = ${providers.join(', ')}`);
    return providers.join(', ');
});

await check('runtime listModels() accepts the proxy catalog (INVALID_CATALOG guard)', async () => {
    const models = await llm.listModels('deepseek-vision');
    if (models.length !== 2) throw new Error(`expected 2 models, got ${models.length}`);
    for (const model of models) {
        if (model.provider !== 'deepseek-vision') throw new Error(`row provider ${model.provider}`);
    }
    return `${models.map((model) => model.id).join(', ')} (all stamped deepseek-vision)`;
});

await check('runtime resolveModelInfo() accepts the proxy metadata (INVALID_MODEL_INFO guard)', async () => {
    const info = await llm.resolveModelInfo('deepseek-vision', 'deepseek-v4-pro');
    if (info.provider !== 'deepseek-vision') throw new Error(`provider ${info.provider}`);
    if (!info.inputModalities.includes('image')) throw new Error('image modality not claimed');
    if (info.context?.contextWindow !== 1048576) throw new Error('context lost in forwarding');
    return `provider=${info.provider} modalities=${info.inputModalities} window=${info.context.contextWindow}`;
});

await check('runtime stream() transcribes an attached image and dispatches to the wrapped route', async () => {
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: '这张截图里是什么？' },
            { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', width: 1200, height: 800, bytes: 1000 } },
        ],
    }];
    for await (const chunk of llm.stream({ provider: 'deepseek-vision', model: 'deepseek-v4-pro', messages })) void chunk;
    if (innerReceived.length !== 1) throw new Error(`inner dispatched ${innerReceived.length} times`);
    const forwarded = innerReceived[0];
    if (forwarded.provider !== 'deepseek-official') throw new Error(`forwarded provider ${forwarded.provider}`);
    const content = forwarded.messages[0].content;
    if (content.some((block) => block.type === 'image')) throw new Error('image block leaked to the text-only brain');
    if (!content.some((block) => block.type === 'text' && block.text.includes('图片转译'))) throw new Error('marker missing');
    if (!content.some((block) => block.type === 'text' && block.text.includes('转译文本'))) throw new Error('transcription text missing');
    const vlmCall = fetchCalls.find((call) => call.url.includes('/chat/completions'));
    if (!vlmCall) throw new Error('VLM endpoint was never called');
    return `forwarded ${content.length} text blocks, VLM model=${JSON.parse(vlmCall.body).model}`;
});

await check('native-vision model passes images through without a VLM call', async () => {
    innerReceived.length = 0;
    const before = fetchCalls.filter((call) => call.url.includes('/chat/completions')).length;
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', width: 100, height: 100, bytes: 500 } }] }];
    for await (const chunk of llm.stream({ provider: 'deepseek-vision', model: 'deepseek-flash', messages })) void chunk;
    const after = fetchCalls.filter((call) => call.url.includes('/chat/completions')).length;
    if (innerReceived.length !== 1) throw new Error(`inner dispatched ${innerReceived.length} times`);
    const content = innerReceived[0].messages[0].content;
    if (!content.some((block) => block.type === 'image')) throw new Error('image not passed through');
    if (after !== before) throw new Error('unexpected transcription call for a native-vision model');
    return 'images forwarded untouched, no extra VLM request';
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
if (failed.length > 0) process.exitCode = 1;
