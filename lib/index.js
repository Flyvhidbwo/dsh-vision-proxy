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
 * answered by DeepSeek. Transcription results are cached per attachment id
 * (in-process, capped), so each image is transcribed at most once.
 *
 * @module dsh-vision-proxy
 */
import z from 'schemastery';

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
/** In-process transcription cache cap. */
const CACHE_CAP = 100;

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

/** Resolve the VLM key: config, then environment, per call. */
function resolveApiKey(config, baseURL) {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseURL);
    const key = config.apiKey !== undefined && config.apiKey !== ''
        ? config.apiKey
        : process.env.VISION_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (key === '' && !isLocal) {
        throw new Error('dsh-vision-proxy: no VLM API key. Set the dsh-vision-proxy apiKey config, or export VISION_API_KEY / DASHSCOPE_API_KEY (local endpoints like Ollama need none).');
    }
    return key;
}

/** Transcribe one image (attachment ref) to text via the configured VLM. */
async function transcribe(ctx, config, ref, signal) {
    const attachments = ctx.get('attachments');
    const stored = await attachments.readImage(ref, signal);
    const dataUrl = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`;
    const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const apiKey = resolveApiKey(config, config.baseURL);
    const response = await fetch(url, {
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
    const body = await response.text();
    if (!response.ok) {
        const hint = response.status === 401 || response.status === 403
            ? ' The endpoint rejected the API key — verify it matches the platform-issued format exactly (e.g. sk-ws-… / sk-sp-… on Qwen platforms), with no extra prefix, missing characters, or line breaks.'
            : '';
        throw new Error(`dsh-vision-proxy: transcription failed, ${url} returned ${response.status}: ${body.slice(0, 300)}${hint}`);
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

/** Replace image blocks with transcribed text, recursively. */
async function transcribeBlocks(ctx, config, blocks, signal, cache) {
    const out = [];
    for (const block of blocks) {
        if (block.type === 'image') {
            const key = block.attachment?.attachmentId;
            let text = key !== undefined ? cache.get(key) : undefined;
            if (text === undefined) {
                text = await transcribe(ctx, config, block.attachment, signal);
                if (key !== undefined) {
                    if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value);
                    cache.set(key, text);
                }
            }
            out.push({ type: 'text', text: `${config.marker}\n${text}` });
        } else if (block.type === 'tool-result' && hasImage(block.content)) {
            out.push({ ...block, content: await transcribeBlocks(ctx, config, block.content, signal, cache) });
        } else {
            out.push(block);
        }
    }
    return out;
}

/** Transcribe all images in a message list; image-free messages pass through untouched. */
async function transcribeMessages(ctx, config, messages, signal, cache) {
    const out = [];
    for (const message of messages) {
        if (!hasImage(message.content)) {
            out.push(message);
            continue;
        }
        out.push({ ...message, content: await transcribeBlocks(ctx, config, message.content, signal, cache) });
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
    };
    const cache = new Map();

    const inner = ctx.llm.registration(resolved.innerProvider)?.adapter;
    if (inner === undefined) {
        ctx.logger.error(`dsh-vision-proxy: no adapter registered for "${resolved.innerProvider}"; proxy route disabled`);
        return;
    }

    const keySource = resolved.apiKey !== ''
        ? 'config'
        : process.env.VISION_API_KEY !== undefined && process.env.VISION_API_KEY !== ''
            ? '$VISION_API_KEY'
            : process.env.DASHSCOPE_API_KEY !== undefined && process.env.DASHSCOPE_API_KEY !== ''
                ? '$DASHSCOPE_API_KEY'
                : 'UNSET (image transcription will fail)';
    ctx.logger.info(`dsh-vision-proxy: route "${resolved.providerId}" wraps "${resolved.innerProvider}" · VLM model "${resolved.model}" @ ${resolved.baseURL} · apiKey from ${keySource} (key itself is never logged)`);

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
            const messages = await transcribeMessages(ctx, resolved, options.messages, options.signal, cache);
            yield* inner.stream({ ...options, messages });
        },
    };

    ctx.llm.registerAdapter([resolved.providerId], proxy);
}
