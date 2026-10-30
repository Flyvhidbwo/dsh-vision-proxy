/**
 * dsh-vision-proxy: keep DeepSeek as the conversation brain and get image
 * support anyway.
 *
 * Registers a NEW provider route (`deepseek-vision` by default) that wraps the
 * real DeepSeek adapter:
 *   - `resolveModel` declares `inputModalities` including "image", so the Web
 *     attachment preflight and the read_image capability gate admit images;
 *   - `stream` transcribes every image block in the request to text through an
 *     OpenAI-compatible VLM (DashScope qwen3.7-flash by default, or DeepSeek's
 *     official vision model) and then delegates the text-only conversation to
 *     the real DeepSeek adapter.
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
 *   - No hangs: PUBLIC anonymous endpoints get a hard 20 s timeout cap
 *     regardless of the configured `timeoutMs`, and HTTP 429 on them fails
 *     immediately (no Retry-After sleep). Loopback endpoints (local Ollama) are
 *     never treated as anonymous public tiers: they keep the configured
 *     timeout, because loading a multi-GB model into VRAM legitimately takes
 *     30-60 s. Endpoints that just failed with a rate limit or a timeout are
 *     cooled down for 60 s and skipped.
 *   - Content-hash cache: transcriptions are cached by the SHA-256 of the
 *     image bytes (in-process, capped), so the same image — even re-attached
 *     under a new attachment id or in another conversation — is transcribed
 *     at most once per process.
 *   - Classified errors: failed VLM responses are classified (rate limit /
 *     quota / auth / region / model not found / context too large / http) and
 *     the thrown error carries an actionable hint.
 *   - Reasoning-model tolerance: when a thinking VLM spends its whole output
 *     budget on `reasoning` and returns an empty `content`, the reasoning text
 *     is used instead of discarding a completed inference.
 *
 * dsh 0.2.x compatibility:
 *   - the wrapped adapter is resolved LAZILY (cordis activates entries by
 *     service availability, so this plugin's fiber can run before the wrapped
 *     provider registered its adapter; `ctx.llm.registration()` throws
 *     `NO_ADAPTER` instead of returning undefined);
 *   - model metadata is forwarded for the INNER route and re-stamped with the
 *     route id the caller asked about, so the runtime's catalog and exact-model
 *     metadata validation both accept it;
 *   - image bytes are read through the public attachment request-projection
 *     API (`readImageRequest`) when present, falling back to the legacy
 *     `readImage` storage read used by dsh 0.1.x;
 *   - when the selected model already declares native image input (e.g.
 *     `deepseek-v4-flash-vision-exp`), images are passed through untranslated
 *     (`nativeVisionPassThrough`) — no wasted VLM call, no quality loss;
 *   - the live-editable settings are declared `.volatile()`, so dsh serves them
 *     as a Settings namespace (entry id `dsh-vision-proxy`) and the bundled
 *     browser half renders a 「识图代理」page under Settings → no YAML editing.
 *
 * @module dsh-vision-proxy
 */
import z from '@deepseek-ai/schemastery';
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
/** Hard cap on the effective timeout for PUBLIC anonymous endpoints (they can hang). */
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
const DEFAULT_MAX_TOKENS = 8192;
/** Default request timeout — thinking models on large images are slow. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Downscale images above this many pixels before transcription (0 disables). */
const DEFAULT_MAX_IMAGE_PIXELS = 4_000_000;
/** DeepSeek official API base URL for the built-in vision-model transcription. */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** Official multimodal model used for transcription when deepseekVision is enabled. */
const DEFAULT_DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp';
/** Files below this size skip the sharp round-trip entirely. */
const DOWNSCALE_SKIP_BYTES = 512 * 1024;
/** `keep_alive` sent to loopback OpenAI-compatible servers (Ollama keeps a model resident). */
const DEFAULT_KEEP_ALIVE = '30m';
/** Upper bound on how much of the combined failure list reaches the placeholder text. */
const PLACEHOLDER_REASON_CAP = 600;
/** Fallback byte target when an attachment reference carries no encoded size. */
const DEFAULT_IMAGE_TARGET_BYTES = 8 * 1024 * 1024;
/** Fallback dimension target when an attachment reference carries no intrinsic size. */
const DEFAULT_IMAGE_TARGET_DIMENSION = 4096;

// Live-editable fields are `.volatile()`: dsh serves every volatile field of the
// active entry `dsh-vision-proxy` as a Settings namespace, so the bundled Web
// settings page can read and write them without a restart. Fields that decide
// the mount-time wiring (route ids, Ollama probing, the fallback array) stay
// ordinary config and are edited in the profile patch.
export const Config = z.object({
    providerId: z.string().default(DEFAULT_PROVIDER)
        .description('Provider route id this proxy registers; appears in the model picker. Changing it needs a restart'),
    innerProvider: z.string().default(DEFAULT_INNER_PROVIDER)
        .description('Existing provider route whose adapter this proxy wraps. If that route is not registered, the plugin falls back to deepseek-official, then deepseek-account, then the first registered route (so an API-key profile and a signed-in account profile both work). Changing it needs a restart'),
    baseURL: z.string().default(DEFAULT_BASE_URL).volatile()
        .description('OpenAI-compatible VLM endpoint base URL (…/chat/completions is appended)'),
    apiKey: z.string().role('secret').default('').volatile()
        .description('VLM API key; falls back to $VISION_API_KEY, then $DASHSCOPE_API_KEY. On Windows, environment changes may not reach the running dsh — writing apiKey here is the reliable way. The stored value is never sent to the browser'),
    anonymous: z.boolean().required(false).volatile()
        .description('True to skip the Authorization header (registration-free endpoints). A loopback baseURL is always treated as local, never as an anonymous public tier'),
    model: z.string().default(DEFAULT_MODEL).volatile()
        .description('Vision model id at the endpoint'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(DEFAULT_MAX_TOKENS).volatile()
        .description('VLM output cap (thinking models need room for reasoning plus the transcription)'),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(DEFAULT_TIMEOUT_MS).volatile()
        .description('VLM request timeout; public anonymous endpoints are capped at 20 s regardless, loopback endpoints keep this value'),
    maxImagePixels: z.number().step(1).min(0).max(100_000_000).default(DEFAULT_MAX_IMAGE_PIXELS).volatile()
        .description('Images above this many pixels are downscaled before transcription (0 disables)'),
    keepAlive: z.string().default(DEFAULT_KEEP_ALIVE).volatile()
        .description('keep_alive sent to loopback OpenAI-compatible servers (Ollama: how long a loaded model stays resident; empty disables the field)'),
    marker: z.string().default('[图片转译]').volatile()
        .description('Text marker prepended to each transcription in the DeepSeek-visible message'),
    failureMode: z.union(['placeholder', 'error']).default('placeholder').volatile()
        .description('What happens when every vision model fails for one image: "placeholder" (default) inserts [图片转译失败: …] text and the conversation continues — the session can never be poisoned by a dead endpoint; "error" fails the whole turn as before'),
    abortWithSession: z.boolean().required(false).volatile()
        .description('True to abort a running transcription when the conversation request is cancelled. Default false: a completed inference is never thrown away by a session-level abort'),
    deepseekVision: z.boolean().default(true).volatile()
        .description('Prefer DeepSeek\'s official multimodal model (deepseek-v4-flash-vision-exp) for transcription — native vision quality, uses your DEEPSEEK_API_KEY; ideal to keep a text-only DeepSeek-V4-Pro brain'),
    deepseekVisionModel: z.string().default(DEFAULT_DEEPSEEK_VISION_MODEL).volatile()
        .description('DeepSeek official model used for the built-in vision transcription'),
    nativeVisionPassThrough: z.boolean().default(true).volatile()
        .description('When the selected model already declares native image input (e.g. deepseek-v4-flash-vision-exp), send images straight to it instead of transcribing them first'),
    autoLocalOllama: z.boolean().default(true)
        .description('Probe http://localhost:11434 at startup and prepend it to the fallback chain when a local Ollama is running (images stay on this machine). Changing it needs a restart'),
    localOllamaModel: z.string().default('').volatile()
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
        .description('Ordered fallback vision models tried when the main model fails. No third-party free endpoint is pre-bundled: anonymous free tiers are rate-limited and may hang; use local Ollama or your own key instead. Changing it needs a restart'),
});

const TRANSCRIBE_PROMPT = `You are an image-to-text transcription service. The recipient is a text-only LLM that cannot see the image. Produce a faithful, complete text rendition covering:
1. ALL visible text, verbatim, in its original language (OCR).
2. The overall layout and structure (positioning, sections, hierarchy).
3. Notable visual elements: objects, people, colors, icons, UI components, charts or tables and the data they show.
4. Any other detail that matters (style, logos, numbers, timestamps, URLs).
Be precise and thorough; prefer completeness over brevity. Output only the transcription, no preamble.`;

/** Recursively detect image blocks, walking tool-result content. */
function hasImage(content) {
    return Array.isArray(content) && content.some((block) => block !== null && typeof block === 'object'
        && (block.type === 'image'
            || (block.type === 'tool-result' && hasImage(block.content))));
}

/** Whether a base URL points at this machine (loopback), where no anonymous-tier policy applies. */
function isLoopbackURL(baseURL) {
    return /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(String(baseURL ?? ''));
}

/**
 * Effective endpoint policy: only a PUBLIC anonymous endpoint gets the harsh
 * "can hang, cap it and never retry" treatment. A loopback endpoint is local
 * infrastructure — it may be slow on a cold start but it cannot be rate-limited
 * by a stranger.
 */
function endpointPolicy(baseURL, anonymous) {
    const loopback = isLoopbackURL(baseURL);
    return { loopback, publicAnonymous: anonymous === true && !loopback };
}

/** Resolve the VLM key: config, then environment, per call. Anonymous/local endpoints need none. */
function resolveApiKey(config, baseURL) {
    if (config.anonymous && !isLoopbackURL(baseURL)) return '';
    const key = config.apiKey !== undefined && config.apiKey !== ''
        ? config.apiKey
        : process.env.VISION_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (key === '' && !isLoopbackURL(baseURL)) {
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
 * Logger that never breaks activation: `ctx.logger` is a cordis service, but a
 * deployment may mount no console exporter for it, and a plugin must not fail
 * to activate because a log call is unavailable.
 * @param {object} ctx - plugin context.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function}}
 */
function loggerOf(ctx) {
    const fallback = (level) => (...args) => console[level]('[dsh-vision-proxy]', ...args);
    const logger = ctx?.logger;
    if (logger === undefined || logger === null) {
        return { info: fallback('log'), warn: fallback('warn'), error: fallback('error'), debug: () => {} };
    }
    const bind = (level, plain) => (typeof logger[level] === 'function'
        ? (...args) => logger[level](...args)
        : plain);
    return {
        info: bind('info', fallback('log')),
        warn: bind('warn', fallback('warn')),
        error: bind('error', fallback('error')),
        debug: bind('debug', () => {}),
    };
}

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

/**
 * Resolve the DeepSeek API key (credentials service first — that is how the
 * wrapped deepseek-official route itself authenticates — then environment).
 * @returns the key string, or '' when nothing is configured.
 */
async function resolveDeepSeekKey(ctx) {
    const credentials = ctx?.get?.('credentials');
    if (credentials !== undefined && credentials !== null) {
        try {
            const hit = await credentials.resolve('DEEPSEEK_API_KEY');
            if (hit !== undefined && hit !== null && hit.value !== undefined && String(hit.value).length > 0) {
                return String(hit.value);
            }
        } catch {
            // fall through to the environment
        }
    }
    return process.env.DEEPSEEK_API_KEY ?? '';
}

/** Send the transcription request for already-read image bytes; returns the text. */
async function transcribeRequest(ctx, config, mediaType, data, signal) {
    const dataUrl = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
    const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const apiKey = config.deepseekKey
        ? await resolveDeepSeekKey(ctx)
        : resolveApiKey(config, config.baseURL);
    const policy = endpointPolicy(config.baseURL, config.anonymous);
    // A PUBLIC anonymous endpoint (free tier) can hang: never let it eat the full
    // configured timeout — fail fast so the user gets guidance, not a stall.
    // A loopback endpoint is not that kind of endpoint: a cold Ollama load is
    // legitimately slow, so the configured timeout applies unchanged.
    const effectiveTimeout = policy.publicAnonymous
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
            // Keep a locally hosted model resident between images: Ollama evicts
            // after its 5-minute default, and every reload costs 20-30s of
            // weight loading on the next screenshot. Servers that do not know
            // this field ignore it.
            ...policy.loopback && config.keepAlive !== '' && config.keepAlive !== undefined
                ? { keep_alive: config.keepAlive }
                : {},
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: dataUrl } },
                    { type: 'text', text: TRANSCRIBE_PROMPT },
                ],
            }],
        }),
        // dsh flushes, re-issues, and cancels attachment work around large images;
        // chaining that session signal here killed inferences the GPU was already
        // running (observed as `cancel task` eleven to fifteen seconds in, with
        // thousands of tokens generated). The hard timeout is the only bound a
        // transcription needs: it can never hang, and one slow-but-finished
        // inference is worth more than a perfect cancellation. Opt back in with
        // `abortWithSession: true`.
        signal: signal === undefined
            ? AbortSignal.timeout(effectiveTimeout)
            : AbortSignal.any([AbortSignal.timeout(effectiveTimeout), signal]),
    });

    let response = await post();
    if (response.status === 429 && policy.publicAnonymous) {
        // Free anonymous tiers are rate-limited far beyond any Retry-After;
        // retrying only adds a long stall. Fail immediately with guidance.
        const body = await response.text();
        throw new Error(`dsh-vision-proxy: transcription failed (rate_limit) at ${url}: ${body.slice(0, 200)} — anonymous free endpoints are strictly rate-limited and may hang; they are not retried. Configure VISION_API_KEY / DASHSCOPE_API_KEY, or use local Ollama.`);
    }
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
        // Reasoning models (qwen3-vl, deepseek-r1, …) put their scratchpad in
        // `reasoning` / `reasoning_content` and can spend the whole output budget
        // there, leaving `content` empty even though the model did read the
        // image. Falling back to the reasoning text keeps a completed inference
        // instead of discarding it.
        const message = payload?.choices?.[0]?.message;
        const scratch = message?.reasoning ?? message?.reasoning_content ?? message?.thinking;
        if (typeof scratch === 'string' && scratch.trim() !== '') {
            return scratch.trim();
        }
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
 * @returns {Promise<{data: Buffer, mediaType: string | undefined}>}
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
 * Derive the attachment request-projection target for one transcription.
 * The attachment service does the resizing natively (and caches the derived
 * version), so `maxImagePixels` keeps its meaning without a sharp round-trip.
 * @param {object} ref - durable image attachment reference.
 * @param {number} maxImagePixels - pixel budget; <= 0 keeps the source.
 * @returns {{width: number, height: number, maxBytes: number}}
 */
function imageTargetFor(ref, maxImagePixels) {
    const sourceWidth = Number.isInteger(ref?.width) && ref.width > 0 ? ref.width : DEFAULT_IMAGE_TARGET_DIMENSION;
    const sourceHeight = Number.isInteger(ref?.height) && ref.height > 0 ? ref.height : DEFAULT_IMAGE_TARGET_DIMENSION;
    let width = sourceWidth;
    let height = sourceHeight;
    if (maxImagePixels > 0 && sourceWidth * sourceHeight > maxImagePixels) {
        const scale = Math.sqrt(maxImagePixels / (sourceWidth * sourceHeight));
        width = Math.max(1, Math.round(sourceWidth * scale));
        height = Math.max(1, Math.round(sourceHeight * scale));
    }
    const maxBytes = Number.isInteger(ref?.bytes) && ref.bytes > 0 ? ref.bytes : DEFAULT_IMAGE_TARGET_BYTES;
    return { width, height, maxBytes };
}

/**
 * Read the bytes of one attached image through whichever attachment API this
 * dsh generation exposes:
 *   - dsh >= 0.2: `readImageRequest(ref, target, signal)` — the public
 *     request-projection surface (returns provider-compatible bytes);
 *   - dsh 0.1.x (and every local backend today): `readImage(ref, signal)` —
 *     the stored normalized bytes, downscaled here with optional sharp.
 * @returns {Promise<{data: Uint8Array, mediaType: string}>}
 */
async function readImageBytes(ctx, ref, maxImagePixels, signal) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined || attachments === null) {
        throw new Error('dsh-vision-proxy: the attachments service is unavailable; cannot read the attached image');
    }
    if (typeof attachments.readImageRequest === 'function') {
        try {
            const projected = await attachments.readImageRequest(ref, imageTargetFor(ref, maxImagePixels), signal);
            return { data: projected.data, mediaType: projected.mediaType ?? ref.mediaType };
        } catch (error) {
            // A backend without request projection keeps legacy behaviour below.
            if (error?.code !== 'ATTACHMENT_PROJECTION_UNSUPPORTED') throw error;
        }
    }
    if (typeof attachments.readImage === 'function') {
        const stored = await attachments.readImage(ref, signal);
        const { data, mediaType } = await maybeDownscale(stored.data, maxImagePixels);
        return { data, mediaType: mediaType ?? stored.ref?.mediaType ?? ref.mediaType };
    }
    throw new Error('dsh-vision-proxy: the mounted attachment service exposes neither readImageRequest() nor readImage(); cannot read attached images');
}

/**
 * Transcribe one image with the content-hash cache: reads the bytes once,
 * computes the SHA-256 key, and only calls the VLM on a miss.
 * @returns {Promise<{text: string, hash: string}>}
 */
async function transcribeImage(ctx, config, ref, signal, cache) {
    const { data, mediaType } = await readImageBytes(ctx, ref, config.maxImagePixels, signal);
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
        const text = await transcribeRequest(ctx, config, mediaType, data, signal);
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
        if (attempt.deepseekKey) {
            const dsKey = await resolveDeepSeekKey(ctx);
            if (dsKey === '') {
                errors.push(`${attempt.model} @ ${attempt.baseURL}: skipped — no DEEPSEEK_API_KEY (credentials service or environment)`);
                continue;
            }
        } else if (!attempt.anonymous || !isLoopbackURL(attempt.baseURL)) {
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
        // Report EVERY attempt, not just errors[0]. The first entry is typically
        // the primary model's "skipped — no API key" tick, which hid the real
        // reason (e.g. a local Ollama timeout) and made this placeholder useless
        // as a diagnostic. One line per attempt keeps it bounded.
        const reason = errors.join(' | ').slice(0, PLACEHOLDER_REASON_CAP);
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

/** Defaults for every resolved field; also the fallback when a ref yields undefined. */
const RESOLVED_DEFAULTS = {
    providerId: DEFAULT_PROVIDER,
    innerProvider: DEFAULT_INNER_PROVIDER,
    baseURL: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
    keepAlive: DEFAULT_KEEP_ALIVE,
    marker: '[图片转译]',
    failureMode: 'placeholder',
    anonymous: false,
    abortWithSession: false,
    autoLocalOllama: true,
    localOllamaModel: '',
    deepseekVision: true,
    deepseekVisionModel: DEFAULT_DEEPSEEK_VISION_MODEL,
    nativeVisionPassThrough: true,
};

/**
 * Read one config value. The dsh loader hands volatile fields to `apply()` as
 * stable references (`{ get() }`) that change when the Settings page writes, so
 * every access has to go through this reader.
 */
function readConfigValue(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object' && typeof value.get === 'function') {
        const current = value.get();
        return current === undefined ? fallback : current;
    }
    return value;
}

export function apply(ctx, config) {
    // Volatile fields are live references: read them on every access so a
    // Settings change applies to the next request without a restart.
    const resolved = new Proxy({}, {
        get: (_target, key) => readConfigValue(config[key], RESOLVED_DEFAULTS[key]),
        has: (_target, key) => key in RESOLVED_DEFAULTS,
    });
    const log = loggerOf(ctx);
    if (resolved.providerId === resolved.innerProvider) {
        log.error(`dsh-vision-proxy: providerId and innerProvider are both "${resolved.providerId}"; a route cannot wrap itself — proxy route disabled`);
        return;
    }
    const fallbacks = (config.fallbackModels ?? []).map((fb) => ({
        model: fb.model,
        baseURL: fb.baseURL ?? resolved.baseURL,
        apiKey: fb.apiKey ?? resolved.apiKey,
        anonymous: fb.anonymous ?? false,
        timeoutMs: fb.timeoutMs ?? resolved.timeoutMs,
        maxTokens: resolved.maxTokens,
    }));
    // Built-in DeepSeek official vision model (default: deepseek-v4-flash-vision-exp):
    // native multimodal transcription with the user's DEEPSEEK_API_KEY — keeps a
    // text-only DeepSeek-V4-Pro brain able to "see" images. Rebuilt per request,
    // because the Settings page can change these volatile fields live.
    const deepseekVisionEntry = () => (resolved.deepseekVision
        ? [{
            model: resolved.deepseekVisionModel,
            baseURL: DEEPSEEK_BASE_URL,
            apiKey: '',
            anonymous: false,
            timeoutMs: resolved.timeoutMs,
            maxTokens: resolved.maxTokens,
            deepseekKey: true,
        }]
        : []);
    const cache = new Map();
    const cooldowns = new Map();
    /** Per-model memo of "does the wrapped route already accept images natively?". */
    const nativeVisionModels = new Map();

    // Local Ollama probe: non-blocking, memoized; result is prepended to the
    // fallback chain when a local Ollama is running (zero-config local path).
    const ollamaProbe = resolved.autoLocalOllama
        ? detectLocalOllama(fetch, OLLAMA_BASE_URL, OLLAMA_PROBE_TIMEOUT_MS, resolved.localOllamaModel)
        : Promise.resolve(null);

    // The wrapped adapter is resolved LAZILY, never once at apply() time.
    //
    // cordis activates entries by service availability, so this plugin's fiber
    // can run BEFORE the wrapped provider's own entry has registered its
    // adapter. `ctx.llm.registration(route)` THROWS (`NO_ADAPTER`) instead of
    // returning undefined in dsh 0.2.x, and a one-shot lookup let that throw
    // escape apply(): dsh then reported "1 entry did not activate" and the
    // proxy route simply did not exist. Resolving per call and memoising makes
    // the plugin independent of entry activation order while still surviving a
    // late inner adapter.
    //
    // Route discovery matters in practice: a profile that signs in with a
    // DeepSeek account registers `deepseek-account` and disables the API-key
    // route `deepseek-official`, while an API-key profile does the opposite.
    // The configured route is tried first; the well-known routes and finally
    // every registered route are fallbacks.
    let innerRoute;
    const resolveInner = () => {
        if (innerRoute !== undefined) return innerRoute;
        const registered = [];
        try {
            const providers = ctx.llm.listProviders?.() ?? [];
            for (const provider of providers) {
                if (typeof provider?.id === 'string' && provider.id !== '') registered.push(provider.id);
            }
        } catch {
            // listProviders is advisory; registration() below is the authority.
        }
        const candidates = [];
        const add = (id) => {
            if (typeof id === 'string' && id !== '' && id !== resolved.providerId && !candidates.includes(id)) candidates.push(id);
        };
        add(resolved.innerProvider);
        for (const id of ['deepseek-official', 'deepseek-account']) add(id);
        for (const id of registered) add(id);
        const failures = [];
        for (const id of candidates) {
            try {
                const registration = ctx.llm.registration(id);
                if (registration?.adapter !== undefined) {
                    innerRoute = { adapter: registration.adapter, provider: id };
                    log.info(id === resolved.innerProvider
                        ? `dsh-vision-proxy: inner adapter "${id}" resolved`
                        : `dsh-vision-proxy: inner provider "${resolved.innerProvider}" is not registered; wrapping "${id}" instead`);
                    return innerRoute;
                }
            } catch (error) {
                failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        throw new Error(`dsh-vision-proxy: no inner provider route to wrap (tried ${candidates.join(', ') || 'none'}). Set innerProvider to a registered route. ${failures.length > 0 ? failures.join(' | ') : ''}`);
    };

    /** Probe whether the wrapped route already accepts image input for one model. */
    async function modelHasNativeVision(model, signal) {
        if (!resolved.nativeVisionPassThrough) return false;
        const cached = nativeVisionModels.get(model);
        if (cached !== undefined) return cached;
        try {
            const inner = resolveInner();
            const info = await inner.adapter.resolveModel(inner.provider, model, signal);
            const native = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
            nativeVisionModels.set(model, native);
            return native;
        } catch {
            return false; // unknown metadata → transcribe, which never loses the image
        }
    }

    /**
     * Transcribe images then delegate. `delegate` is the inner stream entry
     * point (the one `prepareCall()` bound, when available) and `nativeVision`
     * short-circuits transcription for models that already see images.
     */
    async function* proxyStream(options, delegate, nativeVision) {
        const innerProvider = resolveInner().provider;
        const callInner = delegate ?? ((opts) => resolveInner().adapter.stream({ ...opts, provider: innerProvider }));
        const needsTranscription = !nativeVision
            && Array.isArray(options.messages)
            && options.messages.some((message) => hasImage(message.content));
        if (!needsTranscription) {
            yield* callInner({ ...options, provider: innerProvider });
            return;
        }
        const local = await ollamaProbe;
        // Transcription priority: built-in DeepSeek official vision model
        // (default deepseek-v4-flash-vision-exp) → user fallbacks → local Ollama
        // (free/privacy net). The main model sits at the head of the chain
        // inside transcribeWithFallback.
        const chain = local === null
            ? [...deepseekVisionEntry(), ...fallbacks]
            : [...deepseekVisionEntry(), ...fallbacks, {
                model: local.model,
                baseURL: local.baseURL,
                apiKey: '',
                // Local Ollama is not an anonymous public tier: it cannot hang
                // on a stranger's rate limiter, but its FIRST inference after a
                // cold start must load multi-GB weights into VRAM, which
                // routinely takes 30-60 s. The 20 s anonymous cap made that
                // warm-up request time out every single time (observed as a 500
                // with duration 20.01 s in Ollama's own log). Honor the
                // configured timeout and keep the model resident instead.
                anonymous: false,
                timeoutMs: resolved.timeoutMs,
                maxTokens: resolved.maxTokens,
            }];
        const transcriptionSignal = resolved.abortWithSession && options.signal !== undefined
            ? options.signal
            : undefined;
        const messages = await transcribeMessages(ctx, resolved, chain, options.messages, transcriptionSignal, cache, cooldowns);
        // The inner adapter dispatches on its own route id: forward that, not the
        // proxy route, or it sees a provider it does not own.
        yield* callInner({ ...options, provider: innerProvider, messages });
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
            : resolved.deepseekVision
                ? 'DeepSeek official vision model via DEEPSEEK_API_KEY'
                : 'UNSET';
    ollamaProbe.then((local) => {
        if (local !== null) {
            log.info(`dsh-vision-proxy: local Ollama detected at ${local.baseURL} (model ${local.model}) — appended to the fallback chain; images stay on this machine`);
        } else if (!hasAnyKey && !resolved.deepseekVision && fallbacks.length === 0) {
            log.warn('dsh-vision-proxy: no API key configured and no local Ollama detected — image transcription will FAIL FAST with guidance. Export VISION_API_KEY / DASHSCOPE_API_KEY (or write apiKey into the plugin config; Windows environment changes may not reach a running dsh), or install Ollama at http://localhost:11434.');
        }
    }).catch(() => {});
    const fallbackSummary = fallbacks.length === 0
        ? 'none'
        : fallbacks.map((f) => `${f.model}@${f.baseURL}${f.anonymous ? ' (anonymous)' : ''}`).join(', ');
    log.info(`dsh-vision-proxy: route "${resolved.providerId}" wraps "${resolved.innerProvider}" (auto-detected lazily: ${resolved.innerProvider} → deepseek-official → deepseek-account → any registered route) · VLM model "${resolved.model}" @ ${resolved.baseURL} · apiKey from ${keySource} · timeout ${resolved.timeoutMs}ms · maxTokens ${resolved.maxTokens} · maxImagePixels ${resolved.maxImagePixels} · failureMode ${resolved.failureMode} · deepseekVision ${resolved.deepseekVision} · nativeVisionPassThrough ${resolved.nativeVisionPassThrough} · autoLocalOllama ${resolved.autoLocalOllama} · fallbacks: ${fallbackSummary} (key itself is never logged)`);
    log.info('dsh-vision-proxy: PRIVACY NOTICE — image bytes are sent over HTTPS to the configured VLM endpoint for transcription. Images leave your machine unless baseURL points at a local service (e.g. Ollama). For sensitive images, configure your own endpoint or uninstall this plugin.');

    const proxy = {
        providerInfo: (provider) => ({ id: provider, name: 'DeepSeek + 自动识图' }),
        // Called while the route is registered, possibly before the wrapped
        // provider exists: never let an unavailable inner adapter fail the
        // registration (the runtime falls back to its default retry policy).
        providerRetryPolicy: () => {
            try {
                const inner = resolveInner();
                return inner.adapter.providerRetryPolicy?.(inner.provider) ?? undefined;
            } catch {
                return undefined;
            }
        },
        // The picker calls listModels(proxyRouteId) and the llm service then
        // validates every row with `model.provider === proxyRouteId`. Ask the
        // wrapped route for its catalog, then stamp the route the caller asked
        // about on every row.
        listModels: async (provider) => {
            const inner = resolveInner();
            const models = await inner.adapter.listModels(inner.provider);
            return models.map((model) => ({ ...model, provider }));
        },
        resolveModel: async (provider, model, signal) => {
            const inner = resolveInner();
            const info = await inner.adapter.resolveModel(inner.provider, model, signal);
            // The key trick: claim image input so attachment preflight and the
            // read_image gate admit images; transcription (or the native
            // pass-through) happens in stream().
            return { ...info, provider, inputModalities: ['text', 'image'] };
        },
        // dsh >= 0.1.1-rc.2: the runtime calls adapter.prepareCall(provider, model,
        // signal) and dispatches through the returned `stream` entry point. Bind
        // the inner adapter's own prepareCall generation here, so one request uses
        // one consistent connection snapshot even across a settings change.
        prepareCall: async (provider, model, signal) => {
            const inner = resolveInner();
            const innerCall = typeof inner.adapter.prepareCall === 'function'
                ? await inner.adapter.prepareCall(inner.provider, model, signal)
                : {
                    model: await inner.adapter.resolveModel(inner.provider, model, signal),
                    stream: (options) => inner.adapter.stream({ ...options, provider: inner.provider }),
                };
            const info = innerCall.model ?? await inner.adapter.resolveModel(inner.provider, model, signal);
            const nativeVision = resolved.nativeVisionPassThrough
                && Array.isArray(info?.inputModalities)
                && info.inputModalities.includes('image');
            nativeVisionModels.set(model, nativeVision);
            const modelInfo = { ...info, provider, inputModalities: ['text', 'image'] };
            return {
                model: modelInfo,
                stream: (options) => proxyStream(options, (opts) => innerCall.stream({ ...opts, provider: inner.provider }), nativeVision),
            };
        },
        stream: async function* (options) {
            const nativeVision = await modelHasNativeVision(options.model, options.signal);
            yield* proxyStream(options, undefined, nativeVision);
        },
    };

    ctx.llm.registerAdapter([resolved.providerId], proxy);
}

/** Test seam: internals exported for unit tests (not part of the public API). */
export const _test = {
    transcribeWithFallback,
    transcribeImage,
    transcribeRequest,
    classifyHttpError,
    resolveApiKey,
    parseRetryAfter,
    hasImage,
    maybeDownscale,
    detectLocalOllama,
    readImageBytes,
    imageTargetFor,
    isLoopbackURL,
    loggerOf,
};
