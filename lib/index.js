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
 *     error listing every attempt. A non-anonymous entry with no resolvable
 *     API key is skipped (not failed).
 *   - Zero-config local path: when `autoLocalOllama` is enabled (default), a
 *     running Ollama at http://localhost:11434 is detected at startup and
 *     prepended to the fallback chain — images then never leave the machine.
 *     Without a key AND without local Ollama, transcription fails FAST with
 *     actionable guidance instead of hanging.
 *   - No hangs: anonymous endpoints get a hard 20 s timeout cap regardless of
 *     the configured `timeoutMs`, and HTTP 429 on anonymous endpoints fails
 *     immediately (no Retry-After sleep). Endpoints that just failed with a
 *     rate limit or a timeout are cooled down for 60 s and skipped.
 *   - Content-hash cache: transcriptions are cached by the SHA-256 of the
 *     image bytes (in-process, capped), so the same image — even re-attached
 *     under a new attachment id or in another conversation — is transcribed
 *     at most once per process.
 *   - Classified errors: failed VLM responses are classified (rate limit /
 *     quota / auth / region / model not found / context too large / http) and
 *     the thrown error carries an actionable hint.
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
/** Local Ollama endpoint probed when autoLocalOllama is enabled. */
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
/** Probe timeout for the local Ollama health check. */
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;
/** Hard cap on the effective timeout for anonymous endpoints (they can hang). */
const ANONYMOUS_TIMEOUT_CAP_MS = 20_000;
/** How long an endpoint that just failed (429/timeout/network) is skipped. */
const ENDPOINT_COOLDOWN_MS = 60_000;
/** Transport-level failure markers that must cool the endpoint down too. */
const NETWORK_ERROR_RE = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network|undici/i;
/** In-process transcription cache cap (content-hash keys). */
const CACHE_CAP = 200;
/** Upper bound for honoring a Retry-After header (seconds), paid endpoints only. */
const MAX_RETRY_AFTER_SECONDS = 15;
/** Default VLM output cap — generous so thinking models don't eat the budget. */
const DEFAULT_MAX_TOKENS = 4096;
/** Default request timeout — thinking models on large images are slow. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Downscale images above this many pixels before transcription when sharp is available (0 disables). */
const DEFAULT_MAX_IMAGE_PIXELS = 4_000_000;
/** Files below this size skip the sharp round-trip entirely. */
const DOWNSCALE_SKIP_BYTES = 512 * 1024;

export const Config = z.object({
    providerId: z.string().default(DEFAULT_PROVIDER)
        .description('Provider route id this proxy registers; appears in the model picker'),
    innerProvider: z.string().default(DEFAULT_INNER_PROVIDER)
        .description('Existing provider route whose adapter this proxy wraps'),
    baseURL: z.string().default(DEFAULT_BASE_URL)
        .description('OpenAI-compatible VLM endpoint base URL (…/chat/completions is appended)'),
    apiKey: z.string().role('secret').default('')
        .description('VLM API key; falls back to $VISION_API_KEY, then $DASHSCOPE_API_KEY. On Windows, environment changes may not reach the running dsh — writing apiKey here is the reliable way'),
    anonymous: z.boolean().required(false)
        .description('True to skip the Authorization header (registration-free or local endpoints)'),
    model: z.string().default(DEFAULT_MODEL)
        .description('Vision model id at the endpoint'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(DEFAULT_MAX_TOKENS)
        .description('VLM output cap'),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(DEFAULT_TIMEOUT_MS)
        .description('VLM request timeout (anonymous endpoints are capped at 20 s regardless)'),
    maxImagePixels: z.number().step(1).min(0).max(100_000_000).default(DEFAULT_MAX_IMAGE_PIXELS)
        .description('Images above this many pixels are downscaled before transcription when sharp is installed (0 disables)'),
    marker: z.string().default('[图片转译]')
        .description('Text marker prepended to each transcription in the DeepSeek-visible message'),
    failureMode: z.union(['placeholder', 'error']).default('placeholder')
        .description('What happens when every vision model fails for one image: "placeholder" (default) inserts [图片转译失败: …] text and the conversation continues — the session can never be poisoned by a dead endpoint; "error" fails the whole turn as before'),
    autoLocalOllama: z.boolean().default(true)
        .description('Probe http://localhost:11434 at startup and prepend it to the fallback chain when a local Ollama is running (images stay on this machine)'),
    localOllamaModel: z.string().default('')
        .description('Ollama model id to use; empty picks the first vision-capable model reported by the local Ollama'),
    fallbackModels: z.array(z.object({
        model: z.string().required()
            .description('Vision model id for this fallback entry'),
        baseURL: z.string().required(false)
            .description('Endpoint override; defaults to the main baseURL'),
        apiKey: z.string().required(false)
            .description('Key override; defaults to the main apiKey resolution'),
        anonymous: z.boolean().required(false)
            .description('True for registration-free endpoints that need no key'),
        timeoutMs: z.number().required(false)
            .description('Request timeout override; defaults to the main timeoutMs'),
    })).default([])
        .description('Ordered fallback vision models tried when the main model fails. No third-party free endpoint is pre-bundled: anonymous free tiers are rate-limited and may hang; use local Ollama or your own key instead'),
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
        throw new Error('dsh-vision-proxy: no VLM API key. Set the dsh-vision-proxy apiKey config (most reliable on Windows), or export VISION_API_KEY / DASHSCOPE_API_KEY. Local endpoints like Ollama need none.');
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
        return { kind: 'rate_limit', hint: 'vision provider is rate-limited; for anonymous free endpoints this usually persists — configure VISION_API_KEY / DASHSCOPE_API_KEY or use local Ollama instead' };
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

/**
 * Probe an OpenAI-compatible endpoint for its model list.
 * @returns {Promise<{baseURL: string, model: string} | null>}
 */
async function detectLocalOllama(fetchImpl, baseURL, timeoutMs, preferredModel) {
    try {
        const res = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/models`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const body = await res.text();
        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return null;
        }
        const ids = Array.isArray(payload?.data)
            ? payload.data.map((m) => (m && typeof m.id === 'string' ? m.id : '')).filter((id) => id !== '')
            : [];
        if (ids.length === 0) return null;
        if (preferredModel !== undefined && preferredModel !== '' && ids.includes(preferredModel)) {
            return { baseURL, model: preferredModel };
        }
        const vision = ids.find((id) => /vl|vision/i.test(id));
        return { baseURL, model: vision ?? ids[0] };
    } catch {
        return null;
    }
}

/** Send the transcription request for already-read image bytes; returns the text. */
async function transcribeRequest(ctx, config, mediaType, data, signal) {
    const dataUrl = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
    const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const apiKey = resolveApiKey(config, config.baseURL);
    // Anonymous endpoints (free tiers) can hang: never let them eat the full
    // configured timeout — fail fast so the user gets guidance, not a stall.
    const effectiveTimeout = config.anonymous
        ? Math.min(config.timeoutMs, ANONYMOUS_TIMEOUT_CAP_MS)
        : config.timeoutMs;
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
        signal: AbortSignal.any([AbortSignal.timeout(effectiveTimeout), ...(signal === undefined ? [] : [signal])]),
    });

    let response = await post();
    if (response.status === 429) {
        if (config.anonymous) {
            // Free anonymous tiers are rate-limited far beyond any Retry-After;
            // retrying only adds a long stall. Fail immediately with guidance.
            const body = await response.text();
            throw new Error(`dsh-vision-proxy: transcription failed (rate_limit) at ${url}: ${body.slice(0, 200)} — anonymous free endpoints are strictly rate-limited and may hang; they are not retried. Configure VISION_API_KEY / DASHSCOPE_API_KEY, or use local Ollama.`);
        }
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
 * Downscale an image when it exceeds maxImagePixels and `sharp` is available.
 * Graceful: if sharp is missing or decoding fails, the original bytes pass
 * through untouched. Small files skip the sharp round-trip entirely.
 * @param {Buffer} data - original image bytes.
 * @param {number} maxPixels - pixel budget; <= 0 disables downscaling.
 * @returns {Promise<{data: Buffer, mediaType: string}>}
 */
let sharpModulePromise;
async function maybeDownscale(data, maxPixels) {
    if (!(maxPixels > 0) || data.length < DOWNSCALE_SKIP_BYTES) return { data, mediaType: undefined };
    try {
        if (sharpModulePromise === undefined) sharpModulePromise = import('sharp');
        const sharp = (await sharpModulePromise).default;
        const meta = await sharp(data).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        if (width * height <= maxPixels) return { data, mediaType: undefined };
        const scale = Math.sqrt(maxPixels / (width * height));
        const out = await sharp(data).rotate()
            .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
            .png().toBuffer();
        return { data: out, mediaType: 'image/png' };
    } catch {
        return { data, mediaType: undefined }; // sharp missing or decode failed — send the original
    }
}

/**
 * Transcribe one image with the content-hash cache: reads the bytes once,
 * computes the SHA-256 key, and only calls the VLM on a miss.
 * @returns {Promise<{text: string, hash: string}>}
 */
async function transcribeImage(ctx, config, ref, signal, cache) {
    const attachments = ctx.get('attachments');
    const stored = await attachments.readImage(ref, signal);
    const { data, mediaType } = await maybeDownscale(stored.data, config.maxImagePixels);
    const hash = createHash('sha256').update(data).digest('hex');
    const key = `sha256:${hash}`;
    const entry = cache.get(key);
    if (entry !== undefined) {
        // Success hit: return the cached text.
        if (entry.text !== undefined) return { text: entry.text, hash };
        // Failure marker still in cooldown: no network call, insert the placeholder.
        if (entry.failedUntil > Date.now()) return { text: `[图片转译失败: ${entry.reason}]`, hash, failed: true };
        cache.delete(key); // stale failure marker — retry now
    }
    try {
        const text = await transcribeRequest(ctx, config, mediaType ?? stored.ref.mediaType, data, signal);
        if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value);
        cache.set(key, { text });
        return { text, hash };
    } catch (error) {
        if (error instanceof Error) error.hash = hash;
        throw error;
    }
}

/**
 * Try the main model then every fallback entry in order. A non-anonymous
 * attempt with no resolvable API key is SKIPPED instead of failing. Endpoints
 * that just hit a rate limit, timed out, or failed at the transport level
 * (fetch failed / ECONNREFUSED / …) are cooled down for ENDPOINT_COOLDOWN_MS.
 *
 * When every attempt fails:
 *   - `failureMode: "placeholder"` (default) — the image is replaced by an
 *     explicit `[图片转译失败: …]` text and the conversation continues; the
 *     failure is remembered per image hash for the cooldown window so later
 *     turns skip it without touching the network. A dead VLM endpoint can no
 *     longer poison a session.
 *   - `failureMode: "error"` — the whole turn fails with one error listing
 *     every attempt (previous default behavior).
 */
async function transcribeWithFallback(ctx, resolved, fallbacks, ref, signal, cache, cooldowns = new Map()) {
    const attempts = [resolved, ...fallbacks];
    const errors = [];
    let attempted = 0;
    let imageHash;
    for (const attempt of attempts) {
        const until = cooldowns.get(attempt.baseURL);
        if (until !== undefined) {
            if (Date.now() < until) {
                errors.push(`${attempt.model} @ ${attempt.baseURL}: skipped — endpoint cooling down (failed recently)`);
                continue;
            }
            cooldowns.delete(attempt.baseURL);
        }
        if (!attempt.anonymous) {
            try {
                resolveApiKey(attempt, attempt.baseURL);
            } catch (error) {
                errors.push(`${attempt.model} @ ${attempt.baseURL}: skipped — no API key (set apiKey or export VISION_API_KEY / DASHSCOPE_API_KEY)`);
                continue;
            }
        }
        attempted += 1;
        try {
            return await transcribeImage(ctx, attempt, ref, signal, cache);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            imageHash ??= error?.hash;
            errors.push(`${attempt.model} @ ${attempt.baseURL}: ${message}`);
            const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /aborted due to timeout|timed out/i.test(message);
            const isNetwork = error instanceof TypeError
                || NETWORK_ERROR_RE.test(message)
                || (error?.cause?.code !== undefined && /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(String(error.cause.code)));
            if (message.includes('(rate_limit)') || timedOut || isNetwork) {
                cooldowns.set(attempt.baseURL, Date.now() + ENDPOINT_COOLDOWN_MS);
            }
        }
    }
    const summary = `dsh-vision-proxy: all ${attempts.length} vision model(s) failed (${attempted} attempted).\n${errors.join('\n')}`;
    if ((resolved.failureMode ?? 'placeholder') === 'placeholder' && errors.length > 0) {
        const reason = (errors[0] ?? 'unknown error').slice(0, 200);
        if (imageHash !== undefined) {
            cache.set(`sha256:${imageHash}`, { failedUntil: Date.now() + ENDPOINT_COOLDOWN_MS, reason });
        }
        return { text: `[图片转译失败: ${reason}]`, hash: imageHash, failed: true };
    }
    throw new Error(`${summary}\nTip: 图片转译失败——请配置 VISION_API_KEY / DASHSCOPE_API_KEY，或安装本地 Ollama（http://localhost:11434，图片不出本机）。/ Transcription failed — configure an API key or run local Ollama.`);
}

/** Replace image blocks with transcribed text, recursively. */
async function transcribeBlocks(ctx, config, fallbacks, blocks, signal, cache, cooldowns) {
    const out = [];
    for (const block of blocks) {
        if (block.type === 'image') {
            const { text } = await transcribeWithFallback(ctx, config, fallbacks, block.attachment, signal, cache, cooldowns);
            out.push({ type: 'text', text: `${config.marker}\n${text}` });
        } else if (block.type === 'tool-result' && hasImage(block.content)) {
            out.push({ ...block, content: await transcribeBlocks(ctx, config, fallbacks, block.content, signal, cache, cooldowns) });
        } else {
            out.push(block);
        }
    }
    return out;
}

/** Transcribe all images in a message list; image-free messages pass through untouched. */
async function transcribeMessages(ctx, config, fallbacks, messages, signal, cache, cooldowns) {
    const out = [];
    for (const message of messages) {
        if (!hasImage(message.content)) {
            out.push(message);
            continue;
        }
        out.push({ ...message, content: await transcribeBlocks(ctx, config, fallbacks, message.content, signal, cache, cooldowns) });
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
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
        marker: config.marker ?? '[图片转译]',
        failureMode: config.failureMode ?? 'placeholder',
        anonymous: config.anonymous ?? false,
        autoLocalOllama: config.autoLocalOllama ?? true,
        localOllamaModel: config.localOllamaModel ?? '',
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
    const cooldowns = new Map();

    // Local Ollama probe: non-blocking, memoized; result is prepended to the
    // fallback chain when a local Ollama is running (zero-config local path).
    const ollamaProbe = resolved.autoLocalOllama
        ? detectLocalOllama(fetch, OLLAMA_BASE_URL, OLLAMA_PROBE_TIMEOUT_MS, resolved.localOllamaModel)
        : Promise.resolve(null);

    const inner = ctx.llm.registration(resolved.innerProvider)?.adapter;
    if (inner === undefined) {
        ctx.logger.error(`dsh-vision-proxy: no adapter registered for "${resolved.innerProvider}"; proxy route disabled`);
        return;
    }

    const hasAnyKey = resolved.apiKey !== ''
        || (process.env.VISION_API_KEY !== undefined && process.env.VISION_API_KEY !== '')
        || (process.env.DASHSCOPE_API_KEY !== undefined && process.env.DASHSCOPE_API_KEY !== '');
    const keySource = resolved.anonymous
        ? 'none needed (anonymous endpoint)'
        : hasAnyKey
            ? resolved.apiKey !== ''
                ? 'config'
                : process.env.VISION_API_KEY !== undefined && process.env.VISION_API_KEY !== ''
                    ? '$VISION_API_KEY'
                    : '$DASHSCOPE_API_KEY'
            : 'UNSET';
    ollamaProbe.then((local) => {
        if (local !== null) {
            ctx.logger.info(`dsh-vision-proxy: local Ollama detected at ${local.baseURL} (model ${local.model}) — prepended to the fallback chain; images stay on this machine`);
        } else if (!hasAnyKey && fallbacks.length === 0) {
            ctx.logger.warn('dsh-vision-proxy: no API key configured and no local Ollama detected — image transcription will FAIL FAST with guidance. Export VISION_API_KEY / DASHSCOPE_API_KEY (or write apiKey into the plugin config; Windows environment changes may not reach a running dsh), or install Ollama at http://localhost:11434.');
        }
    }).catch(() => {});
    const fallbackSummary = fallbacks.length === 0
        ? 'none'
        : fallbacks.map((f) => `${f.model}@${f.baseURL}${f.anonymous ? ' (anonymous)' : ''}`).join(', ');
    ctx.logger.info(`dsh-vision-proxy: route "${resolved.providerId}" wraps "${resolved.innerProvider}" · VLM model "${resolved.model}" @ ${resolved.baseURL} · apiKey from ${keySource} · timeout ${resolved.timeoutMs}ms (anonymous capped at ${ANONYMOUS_TIMEOUT_CAP_MS}ms) · maxTokens ${resolved.maxTokens} · maxImagePixels ${resolved.maxImagePixels} · failureMode ${resolved.failureMode} · autoLocalOllama ${resolved.autoLocalOllama} · fallbacks: ${fallbackSummary} (key itself is never logged)`);
    ctx.logger.info(`dsh-vision-proxy: PRIVACY NOTICE — image bytes are sent over HTTPS to the configured VLM endpoint for transcription. Images leave your machine unless baseURL points at a local service (e.g. Ollama). For sensitive images, configure your own endpoint or uninstall this plugin.`);

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
        // dsh >= 0.1.1-rc.2: the llm runtime calls adapter.prepareCall(provider, model, signal)
        // and dispatches through the returned `stream` entry point. Mirror the base-class
        // contract so the proxy works on both the rc.6 direct-stream path and the new API.
        prepareCall: async (provider, model, signal) => ({
            model: await proxy.resolveModel(provider, model, signal),
            stream: (options) => proxy.stream(options),
        }),
        stream: async function* (options) {
            const local = await ollamaProbe;
            const chain = local === null
                ? fallbacks
                : [{
                    model: local.model,
                    baseURL: local.baseURL,
                    apiKey: '',
                    anonymous: true,
                    timeoutMs: Math.min(resolved.timeoutMs, ANONYMOUS_TIMEOUT_CAP_MS),
                    maxTokens: resolved.maxTokens,
                }, ...fallbacks];
            const messages = await transcribeMessages(ctx, resolved, chain, options.messages, options.signal, cache, cooldowns);
            yield* inner.stream({ ...options, messages });
        },
    };

    ctx.llm.registerAdapter([resolved.providerId], proxy);
}

/** Test seam: internals exported for unit tests (not part of the public API). */
export const _test = { transcribeWithFallback, transcribeImage, transcribeRequest, classifyHttpError, resolveApiKey, parseRetryAfter, hasImage, maybeDownscale, detectLocalOllama };
