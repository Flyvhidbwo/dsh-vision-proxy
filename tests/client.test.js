// Browser-half tests: the settings page bundle must follow the dsh client
// module format, register a Settings section through the documented slots /
// configForms contract, and render mode-scoped controls (DeepSeek official vs
// custom endpoint). Runs without a browser by evaluating the bundle in a vm
// sandbox with a recording JSX stub and stub cordis services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as plugin from '../lib/index.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Evaluate the bundle and return { id, module }. */
function loadBundle() {
    let captured;
    const sandbox = {
        window: {
            __ModuleLoader__: {
                load: (registration) => { captured = registration; },
            },
        },
        document: undefined,
        Symbol,
        Object,
    };
    runInNewContext(source, sandbox, { filename: 'client.js' });
    assert.ok(captured !== undefined, 'the bundle registers a module factory');

    const requireStub = (id) => {
        if (id === 'react') {
            return {
                useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
                useEffect: () => {},
                useRef: (value) => ({ current: value }),
                useId: () => 'id',
                useSyncExternalStore: () => undefined,
                createElement: () => null,
            };
        }
        if (id === 'react/jsx-runtime') {
            // Recording stubs: enough to inspect the rendered tree without React.
            return {
                jsx: (type, props) => ({ type, props: props ?? {} }),
                jsxs: (type, props) => ({ type, props: props ?? {} }),
            };
        }
        throw new Error(`unexpected require(${id}) in the browser half`);
    };

    const module = captured.factory(requireStub);
    return { id: captured.id, module };
}

/** Flatten text nodes (and placeholders) out of a recorded element tree. */
function flattenText(node, out = []) {
    if (node === null || node === undefined || node === false) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const item of node) flattenText(item, out);
        return out;
    }
    if (typeof node === 'object' && node.props !== undefined) {
        if (typeof node.props.placeholder === 'string') out.push(node.props.placeholder);
        if (typeof node.props.children === 'string') out.push(node.props.children);
        else flattenText(node.props.children, out);
    }
    return out;
}

/** Minimal cordis-like context recording what the plugin registers. */
function makeClientCtx({ served = true, snapshot = { status: 'ready', value: {}, user: {}, revision: 1, writable: true } } = {}) {
    const state = { sections: [], slots: [], dictionaries: [], disposed: 0 };
    const form = {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        mutate: async () => true,
        unset: async () => true,
        set: async () => true,
        dispose: async () => { state.disposed += 1; },
    };
    const ctx = {
        effect: (callback, _label) => {
            const disposer = callback();
            return typeof disposer === 'function' ? disposer : () => {};
        },
        locale: {
            register: (namespace, dictionaries) => {
                state.dictionaries.push({ namespace, dictionaries });
                return () => {};
            },
            bind: (namespace) => (key, params) => key,
        },
        slots: {
            inject: (slotName, callback) => {
                state.slots.push(slotName);
                const disposer = callback();
                return typeof disposer === 'function' ? disposer : () => {};
            },
            register: (options, component) => {
                state.sections.push({ options, component });
                return () => {};
            },
        },
        configForms: {
            get: (entryId) => {
                state.formEntryId = entryId;
                return form;
            },
            whileServed: (namespaces, callback) => {
                state.watched = namespaces;
                if (!served) return () => {};
                const disposer = callback(new Set(namespaces));
                return typeof disposer === 'function' ? disposer : () => {};
            },
        },
    };
    return { ctx, state, form };
}

/** Render the registered section with a fixed snapshot. */
function renderSection({ value = {}, user = {}, revision = 1, writable = true } = {}) {
    const { module } = loadBundle();
    const { ctx, state } = makeClientCtx({ snapshot: { status: 'ready', value, user, revision, writable } });
    module.apply(ctx);
    const { options, component } = state.sections[0];
    const injected = options.inject();
    const tree = component({
        t: (key) => key,
        form: injected.form,
        useForm: () => ({ status: 'ready', value, user, revision, writable }),
    });
    return { text: flattenText(tree).join(' '), tree, options };
}

test('client bundle: registers the module under the package name and exports apply/inject', () => {
    const { id, module } = loadBundle();
    assert.equal(id, 'dsh-vision-proxy', 'module id must equal the package name');
    assert.equal(typeof module.apply, 'function');
    assert.deepEqual([...module.inject].sort(), ['configForms', 'locale', 'slots']);
});

test('client bundle: registers a Settings section bound to the plugin entry config', () => {
    const { module } = loadBundle();
    const { ctx, state } = makeClientCtx();
    module.apply(ctx);

    assert.equal(state.dictionaries.length, 1);
    assert.equal(state.dictionaries[0].namespace, 'settings.visionProxy');
    assert.ok(state.dictionaries[0].dictionaries.zh.nav.includes('识图代理'));
    assert.ok(state.dictionaries[0].dictionaries.en.nav.includes('Vision proxy'));

    assert.deepEqual([...state.watched], ['dsh-vision-proxy'], 'page follows the plugin entry namespace');
    assert.equal(state.formEntryId, 'dsh-vision-proxy');
    assert.ok(state.slots.includes('settings.section'));

    assert.equal(state.sections.length, 1);
    const { options, component } = state.sections[0];
    assert.equal(options.name, 'settings.section');
    assert.equal(options.id, 'vision-proxy');
    assert.equal(options.order, 20);
    assert.equal(options.locale, 'settings.visionProxy');
    assert.equal(typeof options.label, 'function');
    assert.equal(typeof component, 'function');

    const injected = options.inject();
    assert.ok(injected.form, 'the page receives the shared config form');
    assert.equal(typeof injected.useForm, 'function', 'the page receives a store hook for the form');
});

test('client bundle: no page is registered when the host does not serve the namespace', () => {
    const { module } = loadBundle();
    const { ctx, state } = makeClientCtx({ served: false });
    module.apply(ctx);
    assert.equal(state.sections.length, 0);
    assert.equal(state.dictionaries.length, 1, 'dictionaries are always registered');
});

test('client bundle: every edited field is a volatile field of the Host schema', () => {
    const { module } = loadBundle();
    const schema = plugin.Config({});
    // Spread into a host-realm array: the bundle runs in its own vm realm.
    const fields = [...module._fields];
    const keys = fields.map((field) => field.key).sort();
    assert.deepEqual(keys, [
        'abortWithSession', 'anonymous', 'apiKey', 'baseURL', 'deepseekVisionModel', 'failureMode',
        'keepAlive', 'localOllamaModel', 'marker', 'maxImagePixels', 'maxTokens', 'model',
        'nativeVisionPassThrough', 'source', 'timeoutMs',
    ]);
    for (const field of fields) {
        const hostValue = schema[field.key];
        assert.ok(hostValue === undefined || typeof hostValue?.get === 'function', `${field.key} must be a Host volatile field`);
    }
    // Restart-only knobs are not offered as live settings.
    assert.ok(!keys.includes('providerId'));
    assert.ok(!keys.includes('fallbackModels'));
    assert.ok(!keys.includes('autoLocalOllama'));
});

test('client bundle: default (deepseek) mode shows only the mode switch, no endpoint fields', () => {
    const { text } = renderSection({ value: {} });
    assert.ok(text.includes('modeTitle'), 'mode selector title present');
    assert.ok(text.includes('modeDeepseek'), 'official DeepSeek mode card present');
    assert.ok(text.includes('modeCustom'), 'custom mode card present');
    assert.ok(text.includes('deepseekActive'), 'zero-config status line present');
    assert.ok(!text.includes('field.baseURL'), 'custom endpoint field hidden in default mode');
    assert.ok(!text.includes('field.apiKey'), 'API key field hidden in default mode');
    assert.ok(!text.includes('field.model'), 'custom model field hidden in default mode');
    assert.ok(text.includes('advanced'), 'advanced section still reachable');
});

test('client bundle: custom mode shows the endpoint fields', () => {
    const { text } = renderSection({ value: { source: 'custom', baseURL: 'https://example.test/v1', model: 'qwen3-vl-flash' } });
    assert.ok(text.includes('customHint'));
    assert.ok(text.includes('field.baseURL'), 'endpoint field visible in custom mode');
    assert.ok(text.includes('field.apiKey'));
    assert.ok(text.includes('field.model'));
    assert.ok(!text.includes('deepseekActive'), 'zero-config status line hidden in custom mode');
});

test('client bundle: legacy custom config without an explicit source renders custom mode', () => {
    const { text } = renderSection({ value: { apiKey: '', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus' } });
    assert.ok(text.includes('field.baseURL'), 'a non-default endpoint implies custom mode');
});

test('client bundle: read-only hosts render the same tree without edits enabled', () => {
    const { text } = renderSection({ value: {}, writable: false });
    assert.ok(text.includes('readOnly'));
    assert.ok(text.includes('modeDeepseek'));
});
