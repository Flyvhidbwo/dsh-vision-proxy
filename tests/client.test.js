// Browser-half tests: the settings page bundle must follow the dsh client
// module format and register a Settings section through the documented slots /
// configForms contract. Run without a browser by evaluating the bundle in a vm
// sandbox with stub React + stub cordis services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Evaluate the bundle and return { id, exports, registeredSections, dictionaries }. */
function loadBundle({ configForms } = {}) {
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
            return { jsx: () => null, jsxs: () => null };
        }
        throw new Error(`unexpected require(${id}) in the browser half`);
    };

    const module = captured.factory(requireStub);
    return { id: captured.id, module };
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

test('client bundle: writes the volatile config fields the plugin actually declares', () => {
    const { module } = loadBundle();
    // Spread into a host-realm array: the bundle runs in its own vm realm.
    const edited = [...module._fields].map((field) => field.key).sort();
    // Every field the page edits must be a real volatile key of the Host schema.
    assert.deepEqual(edited, [
        'abortWithSession', 'anonymous', 'apiKey', 'baseURL', 'deepseekVision', 'deepseekVisionModel',
        'failureMode', 'keepAlive', 'localOllamaModel', 'marker', 'maxImagePixels', 'maxTokens',
        'model', 'nativeVisionPassThrough', 'timeoutMs',
    ]);
    // The two restart-only knobs must not be offered as live settings.
    assert.ok(!edited.includes('providerId'));
    assert.ok(!edited.includes('fallbackModels'));
});

test('client bundle: server-side render of the page does not throw on an empty document', () => {
    const { module } = loadBundle();
    const { ctx, state } = makeClientCtx();
    module.apply(ctx);
    const component = state.sections[0].component;
    // react stub returns nulls; the component must still run its hooks/logic.
    const tree = component({
        t: (key) => key,
        form: state.sections[0].options.inject().form,
        useForm: () => ({ status: 'ready', value: { model: 'qwen3.7-flash' }, user: {}, revision: 3, writable: true }),
    });
    assert.equal(tree, null); // stub jsx returns null; the logic above must not have thrown
});
