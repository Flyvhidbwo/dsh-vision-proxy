/**
 * dsh-vision-proxy: keep DeepSeek as the conversation brain and get image
 * support anyway.
 *
 * Registers a NEW provider route (`deepseek-vision` by default) that wraps the
 * real DeepSeek adapter:
 *   - `resolveModel` declares `inputModalities` including "image", so the Web
 *     attachment preflight and the read_image capability gate admit images;
 *   - `stream` transcribes every image block in the request to text through an
 *     OpenAI-compatible VLM (DashScope qwen3.7-flash by default) and then
 *     delegates the text-only conversation to the real DeepSeek adapter.
 *
 * The DeepSeek wire route never sees an image; the conversation is still
 * answered by DeepSeek.
 *
 * Resilience features:
 *   - `fallbackModels`: an ordered fallback chain — when the main model fails
 *     (rate limit, quota, auth, network…), each fallback entry is tried in
 *     turn and only after all of them fail does the request fail, with one
 *     error listing every attempt. A default config ships with a
 *     registration-free anonymous endpoint (OVHcloud, 2 req/min/IP) as the
 *     last resort, so a fresh install works with zero API keys.
 *   - Content-hash cache: transcriptions are cached by the SHA-256 of the
 *     image bytes (in-process, capped), so the same image — even re-attached
 *     under a new attachment id or in another conversation — is transcribed
 *     at most once per process.
 *   - Classified errors: failed VLM responses are classified (rate limit /
 *     quota / auth / region / model not found / context too large / http) and
 *     the thrown error carries an actionable hint; HTTP 429 honors
 *     Retry-After once (capped) before giving up.
 *
 * @module dsh-vision-proxy
 */
import z from 'schemastery';
import { createHash } from 'node:crypto';

export const name = 'dsh-vision-proxy';
export const inject = ['llm', 'attachments'];

/** Default proxy route id exposed to the model picker. */
const DEFAULT_PROVIDER = 'deepseek-vision';
/** Default inner route whose adapter is wrapped (the text-only DeepSeek line). */
const DEFAULT_INNER_PROVIDER = 'deepseek-official';
/** Default transcription endpoint: Alibaba Cloud Model Studio (DashScope) compatible mode. */
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** Default vision model at the endpoint (cheap, fast, multimodal). */
const DEFAULT_MODEL = 'qwen3.7-flash';
/** Registration-free anonymous vision endpoint (OVHcloud AI Endpoints), 2 req/min/IP. */
const DEFAULT_FREE_BASE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
/** Model served by the anonymous free endpoint. */
const DEFAULT_FREE_MODEL = 'Qwen2.5-VL-72B-Instruct';
/** In-process transcription cache cap (content-hash keys). */
const CACHE_CAP = 200;
/** Upper bound for honoring a Retry-After header (seconds). */
const MAX_RETRY_AFTER_SECONDS = 15;

export const Config = z.object({
    providerId: z.string().default(DEFAULT_PROVIDER)
        .description('Provider route id this proxy registers; appears in the model picker'),
    innerProvider: z.string().default(DEFAULT_INNER_PROVIDER)
        .description('Existing provider route whose adapter this proxy wraps'),
    baseURL: z.string().default(DEFAULT_BASE_URL)
        .description('OpenAI-compatible VLM endpoint base URL (…/chat/completions is appended)'),
    apiKey: z.string().role('secret').default('')
        .description('VLM API key; falls back to $VISION_API_KEY, then $DASHSCOPE_API_KEY'),
    model: z.string().default(DEFAULT_MODEL)
        .description('Vision model id at the endpoint'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(2048),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
    marker: z.string().default('[图片转译]')
        .description('Text marker prepended to each transcription in the DeepSeek-visible message'),
    fallbackModels: z.array(z.object({
        model: z.string().required()
            .description('Vision model id for this fallback entry'),
        baseURL: z.string().required(false)
            .description('Endpoint override; defaults to the main baseURL'),
        apiKey: z.string().required(false)
            .description('Key override; defaults to the main apiKey resolution'),
        anonymous: z.boolean().required(false)
            .description('True for registration-free endpoints that need no key (e.g. the OVHcloud free endpoint)'),
        timeoutMs: z.number().required(false)
            .description('Request timeout override; defaults to the main timeoutMs'),
    })).default([])
        .description('Ordered fallback vision models tried when the main model fails'),
});

const TRANSCRIBE_PROMPT = `You are an image-to-text transcription service. The recipient is a text-only LLM that cannot see the image. Produce a faithful, complete text rendition covering:
1. ALL visible text, verbatim, in its original language (OCR).
2. The overall layout and structure (positioning, sections, hierarchy).
3. Notable visual elements: objects, people, colors, icons, UI components, charts or tables and the data they show.
4. Any other detail that matters (style, logos, numbers, timestamps, URLs).
Be precise and thorough; prefer completeness over brevity. Output only the transcription, no preamble.`;

/** Recursively detect image blocks, walking tool-result content. */
function hasImage(content) {
    return content.some((block) => block.type === 'image'
        || (block.type === 'tool-result' && hasImage(block.content)));
}

/** Resolve the VLM key: config, then environment, per call. Anonymous endpoints need none. */
function resolveApiKey(config, baseURL) {
    if (config.anonymous) return '';
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseURL);
    const key = config.apiKey !== undefined && config.apiKey !== ''
        ? config.apiKey
        : process.env.VISION_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (key === '' && !isLocal) {
        throw new Error('dsh-vision-proxy: no VLM API key. Set the dsh-vision-proxy apiKey config, or export VISION_API_KEY / DASHSCOPE_API_KEY (local endpoints like Ollama need none; anonymous endpoints can set anonymous: true).');
    }
    return key;
}

/**
 * Classify a failed VLM response into a kind + actionable hint.
 * @param {number} status - HTTP status of the failed response.
 * @param {string} body - response body text.
 * @returns {{kind: string, hint: string}}
 */
function classifyHttpError(status, body) {
    const text = String(body);
    if (status === 429) {
        return { kind: 'rate_limit', hint: 'vision provider is rate-limited; one Retry-After backoff was attempted — if it persists, wait before sending more images or switch models' };
    }
    if (status === 402 || /insufficient_quota|quota|billing|balance|credit|arrear/i.test(text)) {
        return { kind: 'quota', hint: 'vision provider quota or balance is exhausted — top up at the provider console' };
    }
    if (status === 401 || status === 403) {
        if (/region|area|not available in your|unsupported.*region/i.test(text)) {
            return { kind: 'region', hint: 'model is not available in this region — use another endpoint' };
        }
        return { kind: 'auth', hint: 'the endpoint rejected the API key — verify it matches the platform-issued format exactly (e.g. sk-ws-… / sk-sp-… on Qwen platforms), with no extra prefix, missing characters, or line breaks' };
    }
    if (status === 404) {
        return { kind: 'model_not_found', hint: 'model id was not found at this endpoint — check the model name and baseURL' };
    }
    if (status === 400 && /context|length|too (large|long)|token/i.test(text)) {
        return { kind: 'context_too_large', hint: 'input is too large for this model — try a smaller image or a model with a longer context' };
    }
    return { kind: 'http', hint: `endpoint returned HTTP ${status}` };
}

/** Parse a Retry-After header value (seconds or HTTP date) into seconds, or undefined. */
function parseRetryAfter(header) {
    if (header === null || header === undefined) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
    return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send the transcription request for already-read image bytes; returns the text. */
async function transcribeRequest(ctx, config, mediaType, data, signal) {
    const dataUrl = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
    const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const apiKey = resolveApiKey(config, config.baseURL);
    const post = () => fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
        },
        body: JSON.stringify({
            model: config.model,
            max_tokens: config.maxTokens,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: dataUrl } },
                    { type: 'text', text: TRANSCRIBE_PROMPT },
                ],
            }],
        }),
        signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal === undefined ? [] : [signal])]),
    });

    let response = await post();
    if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
        if (retryAfter !== undefined) {
            await sleep(Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000);
            response = await post();
        }
    }
    const body = await response.text();
    if (!response.ok) {
        const { kind, hint } = classifyHttpError(response.status, body);
        throw new Error(`dsh-vision-proxy: transcription failed (${kind}) at ${url}: ${body.slice(0, 200)} — ${hint}`);
    }
    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new Error(`dsh-vision-proxy: transcription failed, non-JSON response: ${body.slice(0, 200)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content
        : Array.isArray(content)
            ? content.map((part) => (part && typeof part.text === 'string') ? part.text : '').filter(Boolean).join('\n')
            : undefined;
    if (text === undefined || text.trim() === '') {
        throw new Error('dsh-vision-proxy: transcription failed, VLM returned no text');
    }
    return text.trim();
}

/**
 * Transcribe one image with the content-hash cache: reads the bytes once,
 * computes the SHA-256 key, and only calls the VLM on a miss.
 * @returns {Promise<{text: string, hash: string}>}
 */
async function transcribeImage(ctx, config, ref, signal, cache) {
    const attachments = ctx.get('attachments');
    const stored = await attachments.readImage(ref, signal);
    const hash = createHash('sha256').update(stored.data).digest('hex');
    const key = `sha256:${hash}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { text: cached, hash };
    const text = await transcribeRequest(ctx, config, stored.ref.mediaType, stored.data, signal);
    if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value);
    cache.set(key, text);
    return { text, hash };
}

/**
 * Try the main model then every fallback entry in order; only after all fail
 * throw one error listing every attempt.
 */
async function transcribeWithFallback(ctx, resolved, fallbacks, ref, signal, cache) {
    const attempts = [resolved, ...fallbacks];
    const errors = [];
    for (const attempt of attempts) {
        try {
            return await transcribeImage(ctx, attempt, ref, signal, cache);
        } catch (error) {
            errors.push(`${attempt.model} @ ${attempt.baseURL}: ${error.message}`);
        }
    }
    throw new Error(`dsh-vision-proxy: all ${attempts.length} vision model(s) failed.\n${errors.join('\n')}`);
}

/** Replace image blocks with transcribed text, recursively. */
async function transcribeBlocks(ctx, config, fallbacks, blocks, signal, cache) {
    const out = [];
    for (const block of blocks) {
        if (block.type === 'image') {
            const { text } = await transcribeWithFallback(ctx, config, fallbacks, block.attachment, signal, cache);
            out.push({ type: 'text', text: `${config.marker}\n${text}` });
        } else if (block.type === 'tool-result' && hasImage(block.content)) {
            out.push({ ...block, content: await transcribeBlocks(ctx, config, fallbacks, block.content, signal, cache) });
        } else {
            out.push(block);
        }
    }
    return out;
}

/** Transcribe all images in a message list; image-free messages pass through untouched. */
async function transcribeMessages(ctx, config, fallbacks, messages, signal, cache) {
    const out = [];
    for (const message of messages) {
        if (!hasImage(message.content)) {
            out.push(message);
            continue;
        }
        out.push({ ...message, content: await transcribeBlocks(ctx, config, fallbacks, message.content, signal, cache) });
    }
    return out;
}

export function apply(ctx, config) {
    const resolved = {
        providerId: config.providerId ?? DEFAULT_PROVIDER,
        innerProvider: config.innerProvider ?? DEFAULT_INNER_PROVIDER,
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        apiKey: config.apiKey ?? '',
        model: config.model ?? DEFAULT_MODEL,
        maxTokens: config.maxTokens ?? 2048,
        timeoutMs: config.timeoutMs ?? 60_000,
        marker: config.marker ?? '[图片转译]',
        anonymous: false,
    };
    const fallbacks = (config.fallbackModels ?? []).map((fb) => ({
        model: fb.model,
        baseURL: fb.baseURL ?? resolved.baseURL,
        apiKey: fb.apiKey ?? resolved.apiKey,
        anonymous: fb.anonymous ?? false,
        timeoutMs: fb.timeoutMs ?? resolved.timeoutMs,
        maxTokens: resolved.maxTokens,
    }));
    const cache = new Map();

    const inner = ctx.llm.registration(resolved.innerProvider)?.adapter;
    if (inner === undefined) {
        ctx.logger.error(`dsh-vision-proxy: no adapter registered for "${resolved.innerProvider}"; proxy route disabled`);
        return;
    }

    const keySource = resolved.anonymous
        ? 'none needed (anonymous endpoint)'
        : resolved.apiKey !== ''
            ? 'config'
            : process.env.VISION_API_KEY !== undefined && process.env.VISION_API_KEY !== ''
                ? '$VISION_API_KEY'
                : process.env.DASHSCOPE_API_KEY !== undefined && process.env.DASHSCOPE_API_KEY !== ''
                    ? '$DASHSCOPE_API_KEY'
                    : 'UNSET (main model will fail; fallback chain still applies)';
    const fallbackSummary = fallbacks.length === 0
        ? 'none'
        : fallbacks.map((f) => `${f.model}@${f.baseURL}${f.anonymous ? ' (anonymous)' : ''}`).join(', ');
    ctx.logger.info(`dsh-vision-proxy: route "${resolved.providerId}" wraps "${resolved.innerProvider}" · VLM model "${resolved.model}" @ ${resolved.baseURL} · apiKey from ${keySource} · fallbacks: ${fallbackSummary} (key itself is never logged)`);

    const proxy = {
        providerInfo: (provider) => ({ id: provider, name: 'DeepSeek + 自动识图' }),
        providerRetryPolicy: (provider) => inner.providerRetryPolicy?.(provider) ?? undefined,
        listModels: (provider) => inner.listModels(provider),
        resolveModel: async (provider, model, signal) => {
            const info = await inner.resolveModel(provider, model, signal);
            // The key trick: claim image input so attachment preflight and the
            // read_image gate admit images; transcription happens in stream().
            return { ...info, inputModalities: ['text', 'image'] };
        },
        stream: async function* (options) {
            const messages = await transcribeMessages(ctx, resolved, fallbacks, options.messages, options.signal, cache);
            yield* inner.stream({ ...options, messages });
        },
    };

    ctx.llm.registerAdapter([resolved.providerId], proxy);
}

/** Test seam: internals exported for unit tests (not part of the public API). */
export const _test = { transcribeWithFallback, transcribeImage, transcribeRequest, classifyHttpError, resolveApiKey, parseRetryAfter, hasImage };
