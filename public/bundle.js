(function () {
    'use strict';

    function noop() { }
    function assign(tar, src) {
        // @ts-ignore
        for (const k in src)
            tar[k] = src[k];
        return tar;
    }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    let src_url_equal_anchor;
    function src_url_equal(element_src, url) {
        if (!src_url_equal_anchor) {
            src_url_equal_anchor = document.createElement('a');
        }
        src_url_equal_anchor.href = url;
        return element_src === src_url_equal_anchor.href;
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }
    function subscribe(store, ...callbacks) {
        if (store == null) {
            return noop;
        }
        const unsub = store.subscribe(...callbacks);
        return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
    }
    function component_subscribe(component, store, callback) {
        component.$$.on_destroy.push(subscribe(store, callback));
    }
    function set_store_value(store, ret, value) {
        store.set(value);
        return ret;
    }

    const is_client = typeof window !== 'undefined';
    let now$1 = is_client
        ? () => window.performance.now()
        : () => Date.now();
    let raf = is_client ? cb => requestAnimationFrame(cb) : noop;

    const tasks = new Set();
    function run_tasks(now) {
        tasks.forEach(task => {
            if (!task.c(now)) {
                tasks.delete(task);
                task.f();
            }
        });
        if (tasks.size !== 0)
            raf(run_tasks);
    }
    /**
     * Creates a new task that runs on each raf frame
     * until it returns a falsy value or is aborted
     */
    function loop(callback) {
        let task;
        if (tasks.size === 0)
            raf(run_tasks);
        return {
            promise: new Promise(fulfill => {
                tasks.add(task = { c: callback, f: fulfill });
            }),
            abort() {
                tasks.delete(task);
            }
        };
    }
    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
    }
    function destroy_each(iterations, detaching) {
        for (let i = 0; i < iterations.length; i += 1) {
            if (iterations[i])
                iterations[i].d(detaching);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function svg_element(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function empty() {
        return text('');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function prevent_default(fn) {
        return function (event) {
            event.preventDefault();
            // @ts-ignore
            return fn.call(this, event);
        };
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function set_svg_attributes(node, attributes) {
        for (const key in attributes) {
            attr(node, key, attributes[key]);
        }
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.wholeText !== data)
            text.data = data;
    }
    function set_style(node, key, value, important) {
        if (value === null) {
            node.style.removeProperty(key);
        }
        else {
            node.style.setProperty(key, value, important ? 'important' : '');
        }
    }
    function toggle_class(element, name, toggle) {
        element.classList[toggle ? 'add' : 'remove'](name);
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function get_current_component() {
        if (!current_component)
            throw new Error('Function called outside component initialization');
        return current_component;
    }
    /**
     * The `onMount` function schedules a callback to run as soon as the component has been mounted to the DOM.
     * It must be called during the component's initialisation (but doesn't need to live *inside* the component;
     * it can be called from an external module).
     *
     * `onMount` does not run inside a [server-side component](/docs#run-time-server-side-component-api).
     *
     * https://svelte.dev/docs#run-time-svelte-onmount
     */
    function onMount(fn) {
        get_current_component().$$.on_mount.push(fn);
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    // flush() calls callbacks in this order:
    // 1. All beforeUpdate callbacks, in order: parents before children
    // 2. All bind:this callbacks, in reverse order: children before parents.
    // 3. All afterUpdate callbacks, in order: parents before children. EXCEPT
    //    for afterUpdates called during the initial onMount, which are called in
    //    reverse order: children before parents.
    // Since callbacks might update component values, which could trigger another
    // call to flush(), the following steps guard against this:
    // 1. During beforeUpdate, any updated components will be added to the
    //    dirty_components array and will cause a reentrant call to flush(). Because
    //    the flush index is kept outside the function, the reentrant call will pick
    //    up where the earlier call left off and go through all dirty components. The
    //    current_component value is saved and restored so that the reentrant call will
    //    not interfere with the "parent" flush() call.
    // 2. bind:this callbacks cannot trigger new flush() calls.
    // 3. During afterUpdate, any updated components will NOT have their afterUpdate
    //    callback called a second time; the seen_callbacks set, outside the flush()
    //    function, guarantees this behavior.
    const seen_callbacks = new Set();
    let flushidx = 0; // Do *not* move this inside the flush() function
    function flush() {
        // Do not reenter flush while dirty components are updated, as this can
        // result in an infinite loop. Instead, let the inner flush handle it.
        // Reentrancy is ok afterwards for bindings etc.
        if (flushidx !== 0) {
            return;
        }
        const saved_component = current_component;
        do {
            // first, call beforeUpdate functions
            // and update components
            try {
                while (flushidx < dirty_components.length) {
                    const component = dirty_components[flushidx];
                    flushidx++;
                    set_current_component(component);
                    update(component.$$);
                }
            }
            catch (e) {
                // reset dirty state to not end up in a deadlocked state and then rethrow
                dirty_components.length = 0;
                flushidx = 0;
                throw e;
            }
            set_current_component(null);
            dirty_components.length = 0;
            flushidx = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        seen_callbacks.clear();
        set_current_component(saved_component);
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    let outros;
    function group_outros() {
        outros = {
            r: 0,
            c: [],
            p: outros // parent group
        };
    }
    function check_outros() {
        if (!outros.r) {
            run_all(outros.c);
        }
        outros = outros.p;
    }
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
        else if (callback) {
            callback();
        }
    }

    function get_spread_update(levels, updates) {
        const update = {};
        const to_null_out = {};
        const accounted_for = { $$scope: 1 };
        let i = levels.length;
        while (i--) {
            const o = levels[i];
            const n = updates[i];
            if (n) {
                for (const key in o) {
                    if (!(key in n))
                        to_null_out[key] = 1;
                }
                for (const key in n) {
                    if (!accounted_for[key]) {
                        update[key] = n[key];
                        accounted_for[key] = 1;
                    }
                }
                levels[i] = n;
            }
            else {
                for (const key in o) {
                    accounted_for[key] = 1;
                }
            }
        }
        for (const key in to_null_out) {
            if (!(key in update))
                update[key] = undefined;
        }
        return update;
    }
    function create_component(block) {
        block && block.c();
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = component.$$.on_mount.map(run).filter(is_function);
                // if the component was destroyed immediately
                // it will update the `$$.on_destroy` reference to `null`.
                // the destructured on_destroy may still reference to the old array
                if (component.$$.on_destroy) {
                    component.$$.on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, append_styles, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: [],
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(options.context || (parent_component ? parent_component.$$.context : [])),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false,
            root: options.target || parent_component.$$.root
        };
        append_styles && append_styles($$.root);
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    /**
     * Base class for Svelte components. Used when dev=false.
     */
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            if (!is_function(callback)) {
                return noop;
            }
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set($$props) {
            if (this.$$set && !is_empty($$props)) {
                this.$$.skip_bound = true;
                this.$$set($$props);
                this.$$.skip_bound = false;
            }
        }
    }

    const subscriber_queue = [];
    /**
     * Create a `Writable` store that allows both updating and reading by subscription.
     * @param {*=}value initial value
     * @param {StartStopNotifier=}start start and stop notifications for subscriptions
     */
    function writable(value, start = noop) {
        let stop;
        const subscribers = new Set();
        function set(new_value) {
            if (safe_not_equal(value, new_value)) {
                value = new_value;
                if (stop) { // store is ready
                    const run_queue = !subscriber_queue.length;
                    for (const subscriber of subscribers) {
                        subscriber[1]();
                        subscriber_queue.push(subscriber, value);
                    }
                    if (run_queue) {
                        for (let i = 0; i < subscriber_queue.length; i += 2) {
                            subscriber_queue[i][0](subscriber_queue[i + 1]);
                        }
                        subscriber_queue.length = 0;
                    }
                }
            }
        }
        function update(fn) {
            set(fn(value));
        }
        function subscribe(run, invalidate = noop) {
            const subscriber = [run, invalidate];
            subscribers.add(subscriber);
            if (subscribers.size === 1) {
                stop = start(set) || noop;
            }
            run(value);
            return () => {
                subscribers.delete(subscriber);
                if (subscribers.size === 0) {
                    stop();
                    stop = null;
                }
            };
        }
        return { set, update, subscribe };
    }

    const chatAdapter = writable(null);
    const chatData = writable({ events: [], profiles: {}});
    const selectedMessage = writable(null);

    var Mode = {
        MODE_NUMBER: 1 << 0,
        MODE_ALPHA_NUM: 1 << 1,
        MODE_8BIT_BYTE: 1 << 2,
        MODE_KANJI: 1 << 3,
    };

    function QR8bitByte(data) {
        this.mode = Mode.MODE_8BIT_BYTE;
        this.data = data;
    }

    QR8bitByte.prototype = {
        getLength: function () {
            return this.data.length
        },

        write: function (buffer) {
            for (var i = 0; i < this.data.length; i++) {
                // not JIS ...
                buffer.put(this.data.charCodeAt(i), 8);
            }
        },
    };

    var ErrorCorrectLevel = {
        L: 1,
        M: 0,
        Q: 3,
        H: 2,
    };

    // ErrorCorrectLevel

    function QRRSBlock(totalCount, dataCount) {
        this.totalCount = totalCount;
        this.dataCount = dataCount;
    }

    QRRSBlock.RS_BLOCK_TABLE = [
        // L
        // M
        // Q
        // H

        // 1
        [1, 26, 19],
        [1, 26, 16],
        [1, 26, 13],
        [1, 26, 9],

        // 2
        [1, 44, 34],
        [1, 44, 28],
        [1, 44, 22],
        [1, 44, 16],

        // 3
        [1, 70, 55],
        [1, 70, 44],
        [2, 35, 17],
        [2, 35, 13],

        // 4
        [1, 100, 80],
        [2, 50, 32],
        [2, 50, 24],
        [4, 25, 9],

        // 5
        [1, 134, 108],
        [2, 67, 43],
        [2, 33, 15, 2, 34, 16],
        [2, 33, 11, 2, 34, 12],

        // 6
        [2, 86, 68],
        [4, 43, 27],
        [4, 43, 19],
        [4, 43, 15],

        // 7
        [2, 98, 78],
        [4, 49, 31],
        [2, 32, 14, 4, 33, 15],
        [4, 39, 13, 1, 40, 14],

        // 8
        [2, 121, 97],
        [2, 60, 38, 2, 61, 39],
        [4, 40, 18, 2, 41, 19],
        [4, 40, 14, 2, 41, 15],

        // 9
        [2, 146, 116],
        [3, 58, 36, 2, 59, 37],
        [4, 36, 16, 4, 37, 17],
        [4, 36, 12, 4, 37, 13],

        // 10
        [2, 86, 68, 2, 87, 69],
        [4, 69, 43, 1, 70, 44],
        [6, 43, 19, 2, 44, 20],
        [6, 43, 15, 2, 44, 16],

        // 11
        [4, 101, 81],
        [1, 80, 50, 4, 81, 51],
        [4, 50, 22, 4, 51, 23],
        [3, 36, 12, 8, 37, 13],

        // 12
        [2, 116, 92, 2, 117, 93],
        [6, 58, 36, 2, 59, 37],
        [4, 46, 20, 6, 47, 21],
        [7, 42, 14, 4, 43, 15],

        // 13
        [4, 133, 107],
        [8, 59, 37, 1, 60, 38],
        [8, 44, 20, 4, 45, 21],
        [12, 33, 11, 4, 34, 12],

        // 14
        [3, 145, 115, 1, 146, 116],
        [4, 64, 40, 5, 65, 41],
        [11, 36, 16, 5, 37, 17],
        [11, 36, 12, 5, 37, 13],

        // 15
        [5, 109, 87, 1, 110, 88],
        [5, 65, 41, 5, 66, 42],
        [5, 54, 24, 7, 55, 25],
        [11, 36, 12],

        // 16
        [5, 122, 98, 1, 123, 99],
        [7, 73, 45, 3, 74, 46],
        [15, 43, 19, 2, 44, 20],
        [3, 45, 15, 13, 46, 16],

        // 17
        [1, 135, 107, 5, 136, 108],
        [10, 74, 46, 1, 75, 47],
        [1, 50, 22, 15, 51, 23],
        [2, 42, 14, 17, 43, 15],

        // 18
        [5, 150, 120, 1, 151, 121],
        [9, 69, 43, 4, 70, 44],
        [17, 50, 22, 1, 51, 23],
        [2, 42, 14, 19, 43, 15],

        // 19
        [3, 141, 113, 4, 142, 114],
        [3, 70, 44, 11, 71, 45],
        [17, 47, 21, 4, 48, 22],
        [9, 39, 13, 16, 40, 14],

        // 20
        [3, 135, 107, 5, 136, 108],
        [3, 67, 41, 13, 68, 42],
        [15, 54, 24, 5, 55, 25],
        [15, 43, 15, 10, 44, 16],

        // 21
        [4, 144, 116, 4, 145, 117],
        [17, 68, 42],
        [17, 50, 22, 6, 51, 23],
        [19, 46, 16, 6, 47, 17],

        // 22
        [2, 139, 111, 7, 140, 112],
        [17, 74, 46],
        [7, 54, 24, 16, 55, 25],
        [34, 37, 13],

        // 23
        [4, 151, 121, 5, 152, 122],
        [4, 75, 47, 14, 76, 48],
        [11, 54, 24, 14, 55, 25],
        [16, 45, 15, 14, 46, 16],

        // 24
        [6, 147, 117, 4, 148, 118],
        [6, 73, 45, 14, 74, 46],
        [11, 54, 24, 16, 55, 25],
        [30, 46, 16, 2, 47, 17],

        // 25
        [8, 132, 106, 4, 133, 107],
        [8, 75, 47, 13, 76, 48],
        [7, 54, 24, 22, 55, 25],
        [22, 45, 15, 13, 46, 16],

        // 26
        [10, 142, 114, 2, 143, 115],
        [19, 74, 46, 4, 75, 47],
        [28, 50, 22, 6, 51, 23],
        [33, 46, 16, 4, 47, 17],

        // 27
        [8, 152, 122, 4, 153, 123],
        [22, 73, 45, 3, 74, 46],
        [8, 53, 23, 26, 54, 24],
        [12, 45, 15, 28, 46, 16],

        // 28
        [3, 147, 117, 10, 148, 118],
        [3, 73, 45, 23, 74, 46],
        [4, 54, 24, 31, 55, 25],
        [11, 45, 15, 31, 46, 16],

        // 29
        [7, 146, 116, 7, 147, 117],
        [21, 73, 45, 7, 74, 46],
        [1, 53, 23, 37, 54, 24],
        [19, 45, 15, 26, 46, 16],

        // 30
        [5, 145, 115, 10, 146, 116],
        [19, 75, 47, 10, 76, 48],
        [15, 54, 24, 25, 55, 25],
        [23, 45, 15, 25, 46, 16],

        // 31
        [13, 145, 115, 3, 146, 116],
        [2, 74, 46, 29, 75, 47],
        [42, 54, 24, 1, 55, 25],
        [23, 45, 15, 28, 46, 16],

        // 32
        [17, 145, 115],
        [10, 74, 46, 23, 75, 47],
        [10, 54, 24, 35, 55, 25],
        [19, 45, 15, 35, 46, 16],

        // 33
        [17, 145, 115, 1, 146, 116],
        [14, 74, 46, 21, 75, 47],
        [29, 54, 24, 19, 55, 25],
        [11, 45, 15, 46, 46, 16],

        // 34
        [13, 145, 115, 6, 146, 116],
        [14, 74, 46, 23, 75, 47],
        [44, 54, 24, 7, 55, 25],
        [59, 46, 16, 1, 47, 17],

        // 35
        [12, 151, 121, 7, 152, 122],
        [12, 75, 47, 26, 76, 48],
        [39, 54, 24, 14, 55, 25],
        [22, 45, 15, 41, 46, 16],

        // 36
        [6, 151, 121, 14, 152, 122],
        [6, 75, 47, 34, 76, 48],
        [46, 54, 24, 10, 55, 25],
        [2, 45, 15, 64, 46, 16],

        // 37
        [17, 152, 122, 4, 153, 123],
        [29, 74, 46, 14, 75, 47],
        [49, 54, 24, 10, 55, 25],
        [24, 45, 15, 46, 46, 16],

        // 38
        [4, 152, 122, 18, 153, 123],
        [13, 74, 46, 32, 75, 47],
        [48, 54, 24, 14, 55, 25],
        [42, 45, 15, 32, 46, 16],

        // 39
        [20, 147, 117, 4, 148, 118],
        [40, 75, 47, 7, 76, 48],
        [43, 54, 24, 22, 55, 25],
        [10, 45, 15, 67, 46, 16],

        // 40
        [19, 148, 118, 6, 149, 119],
        [18, 75, 47, 31, 76, 48],
        [34, 54, 24, 34, 55, 25],
        [20, 45, 15, 61, 46, 16],
    ];

    QRRSBlock.getRSBlocks = function (typeNumber, errorCorrectLevel) {
        var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectLevel);

        if (rsBlock == undefined) {
            throw new Error(
                'bad rs block @ typeNumber:' + typeNumber + '/errorCorrectLevel:' + errorCorrectLevel
            )
        }

        var length = rsBlock.length / 3;

        var list = new Array();

        for (var i = 0; i < length; i++) {
            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];

            for (var j = 0; j < count; j++) {
                list.push(new QRRSBlock(totalCount, dataCount));
            }
        }

        return list
    };

    QRRSBlock.getRsBlockTable = function (typeNumber, errorCorrectLevel) {
        switch (errorCorrectLevel) {
            case ErrorCorrectLevel.L:
                return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0]
            case ErrorCorrectLevel.M:
                return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1]
            case ErrorCorrectLevel.Q:
                return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2]
            case ErrorCorrectLevel.H:
                return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3]
            default:
                return undefined
        }
    };

    function QRBitBuffer() {
        this.buffer = new Array();
        this.length = 0;
    }

    QRBitBuffer.prototype = {
        get: function (index) {
            var bufIndex = Math.floor(index / 8);
            return ((this.buffer[bufIndex] >>> (7 - (index % 8))) & 1) == 1
        },

        put: function (num, length) {
            for (var i = 0; i < length; i++) {
                this.putBit(((num >>> (length - i - 1)) & 1) == 1);
            }
        },

        getLengthInBits: function () {
            return this.length
        },

        putBit: function (bit) {
            var bufIndex = Math.floor(this.length / 8);
            if (this.buffer.length <= bufIndex) {
                this.buffer.push(0);
            }

            if (bit) {
                this.buffer[bufIndex] |= 0x80 >>> this.length % 8;
            }

            this.length++;
        },
    };

    const QRMath = {
        glog: function (n) {
            if (n < 1) {
                throw new Error('glog(' + n + ')')
            }

            return QRMath.LOG_TABLE[n]
        },

        gexp: function (n) {
            while (n < 0) {
                n += 255;
            }

            while (n >= 256) {
                n -= 255;
            }

            return QRMath.EXP_TABLE[n]
        },

        EXP_TABLE: new Array(256),

        LOG_TABLE: new Array(256),
    };

    for (var i = 0; i < 8; i++) {
        QRMath.EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i++) {
        QRMath.EXP_TABLE[i] =
            QRMath.EXP_TABLE[i - 4] ^
            QRMath.EXP_TABLE[i - 5] ^
            QRMath.EXP_TABLE[i - 6] ^
            QRMath.EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i++) {
        QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;
    }

    function QRPolynomial(num, shift) {
        if (num.length == undefined) {
            throw new Error(num.length + '/' + shift)
        }

        var offset = 0;

        while (offset < num.length && num[offset] == 0) {
            offset++;
        }

        this.num = new Array(num.length - offset + shift);
        for (var i = 0; i < num.length - offset; i++) {
            this.num[i] = num[i + offset];
        }
    }

    QRPolynomial.prototype = {
        get: function (index) {
            return this.num[index]
        },

        getLength: function () {
            return this.num.length
        },

        multiply: function (e) {
            var num = new Array(this.getLength() + e.getLength() - 1);

            for (var i = 0; i < this.getLength(); i++) {
                for (var j = 0; j < e.getLength(); j++) {
                    num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
                }
            }

            return new QRPolynomial(num, 0)
        },

        mod: function (e) {
            if (this.getLength() - e.getLength() < 0) {
                return this
            }

            var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));

            var num = new Array(this.getLength());

            for (var i = 0; i < this.getLength(); i++) {
                num[i] = this.get(i);
            }

            for (var i = 0; i < e.getLength(); i++) {
                num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
            }

            // recursive call
            return new QRPolynomial(num, 0).mod(e)
        },
    };

    const QRMaskPattern = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7,
    };

    const QRUtil = {
        PATTERN_POSITION_TABLE: [
            [],
            [6, 18],
            [6, 22],
            [6, 26],
            [6, 30],
            [6, 34],
            [6, 22, 38],
            [6, 24, 42],
            [6, 26, 46],
            [6, 28, 50],
            [6, 30, 54],
            [6, 32, 58],
            [6, 34, 62],
            [6, 26, 46, 66],
            [6, 26, 48, 70],
            [6, 26, 50, 74],
            [6, 30, 54, 78],
            [6, 30, 56, 82],
            [6, 30, 58, 86],
            [6, 34, 62, 90],
            [6, 28, 50, 72, 94],
            [6, 26, 50, 74, 98],
            [6, 30, 54, 78, 102],
            [6, 28, 54, 80, 106],
            [6, 32, 58, 84, 110],
            [6, 30, 58, 86, 114],
            [6, 34, 62, 90, 118],
            [6, 26, 50, 74, 98, 122],
            [6, 30, 54, 78, 102, 126],
            [6, 26, 52, 78, 104, 130],
            [6, 30, 56, 82, 108, 134],
            [6, 34, 60, 86, 112, 138],
            [6, 30, 58, 86, 114, 142],
            [6, 34, 62, 90, 118, 146],
            [6, 30, 54, 78, 102, 126, 150],
            [6, 24, 50, 76, 102, 128, 154],
            [6, 28, 54, 80, 106, 132, 158],
            [6, 32, 58, 84, 110, 136, 162],
            [6, 26, 54, 82, 110, 138, 166],
            [6, 30, 58, 86, 114, 142, 170],
        ],

        G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
        G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
        G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),

        getBCHTypeInfo: function (data) {
            var d = data << 10;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
                d ^= QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15));
            }
            return ((data << 10) | d) ^ QRUtil.G15_MASK
        },

        getBCHTypeNumber: function (data) {
            var d = data << 12;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
                d ^= QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18));
            }
            return (data << 12) | d
        },

        getBCHDigit: function (data) {
            var digit = 0;

            while (data != 0) {
                digit++;
                data >>>= 1;
            }

            return digit
        },

        getPatternPosition: function (typeNumber) {
            return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1]
        },

        getMask: function (maskPattern, i, j) {
            switch (maskPattern) {
                case QRMaskPattern.PATTERN000:
                    return (i + j) % 2 == 0
                case QRMaskPattern.PATTERN001:
                    return i % 2 == 0
                case QRMaskPattern.PATTERN010:
                    return j % 3 == 0
                case QRMaskPattern.PATTERN011:
                    return (i + j) % 3 == 0
                case QRMaskPattern.PATTERN100:
                    return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0
                case QRMaskPattern.PATTERN101:
                    return ((i * j) % 2) + ((i * j) % 3) == 0
                case QRMaskPattern.PATTERN110:
                    return (((i * j) % 2) + ((i * j) % 3)) % 2 == 0
                case QRMaskPattern.PATTERN111:
                    return (((i * j) % 3) + ((i + j) % 2)) % 2 == 0

                default:
                    throw new Error('bad maskPattern:' + maskPattern)
            }
        },

        getErrorCorrectPolynomial: function (errorCorrectLength) {
            var a = new QRPolynomial([1], 0);

            for (var i = 0; i < errorCorrectLength; i++) {
                a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
            }

            return a
        },

        getLengthInBits: function (mode, type) {
            if (1 <= type && type < 10) {
                // 1 - 9

                switch (mode) {
                    case Mode.MODE_NUMBER:
                        return 10
                    case Mode.MODE_ALPHA_NUM:
                        return 9
                    case Mode.MODE_8BIT_BYTE:
                        return 8
                    case Mode.MODE_KANJI:
                        return 8
                    default:
                        throw new Error('mode:' + mode)
                }
            } else if (type < 27) {
                // 10 - 26

                switch (mode) {
                    case Mode.MODE_NUMBER:
                        return 12
                    case Mode.MODE_ALPHA_NUM:
                        return 11
                    case Mode.MODE_8BIT_BYTE:
                        return 16
                    case Mode.MODE_KANJI:
                        return 10
                    default:
                        throw new Error('mode:' + mode)
                }
            } else if (type < 41) {
                // 27 - 40

                switch (mode) {
                    case Mode.MODE_NUMBER:
                        return 14
                    case Mode.MODE_ALPHA_NUM:
                        return 13
                    case Mode.MODE_8BIT_BYTE:
                        return 16
                    case Mode.MODE_KANJI:
                        return 12
                    default:
                        throw new Error('mode:' + mode)
                }
            } else {
                throw new Error('type:' + type)
            }
        },

        getLostPoint: function (qrCode) {
            var moduleCount = qrCode.getModuleCount();

            var lostPoint = 0;

            // LEVEL1

            for (var row = 0; row < moduleCount; row++) {
                for (var col = 0; col < moduleCount; col++) {
                    var sameCount = 0;
                    var dark = qrCode.isDark(row, col);

                    for (var r = -1; r <= 1; r++) {
                        if (row + r < 0 || moduleCount <= row + r) {
                            continue
                        }

                        for (var c = -1; c <= 1; c++) {
                            if (col + c < 0 || moduleCount <= col + c) {
                                continue
                            }

                            if (r == 0 && c == 0) {
                                continue
                            }

                            if (dark == qrCode.isDark(row + r, col + c)) {
                                sameCount++;
                            }
                        }
                    }

                    if (sameCount > 5) {
                        lostPoint += 3 + sameCount - 5;
                    }
                }
            }

            // LEVEL2

            for (var row = 0; row < moduleCount - 1; row++) {
                for (var col = 0; col < moduleCount - 1; col++) {
                    var count = 0;
                    if (qrCode.isDark(row, col)) count++;
                    if (qrCode.isDark(row + 1, col)) count++;
                    if (qrCode.isDark(row, col + 1)) count++;
                    if (qrCode.isDark(row + 1, col + 1)) count++;
                    if (count == 0 || count == 4) {
                        lostPoint += 3;
                    }
                }
            }

            // LEVEL3

            for (var row = 0; row < moduleCount; row++) {
                for (var col = 0; col < moduleCount - 6; col++) {
                    if (
                        qrCode.isDark(row, col) &&
                        !qrCode.isDark(row, col + 1) &&
                        qrCode.isDark(row, col + 2) &&
                        qrCode.isDark(row, col + 3) &&
                        qrCode.isDark(row, col + 4) &&
                        !qrCode.isDark(row, col + 5) &&
                        qrCode.isDark(row, col + 6)
                    ) {
                        lostPoint += 40;
                    }
                }
            }

            for (var col = 0; col < moduleCount; col++) {
                for (var row = 0; row < moduleCount - 6; row++) {
                    if (
                        qrCode.isDark(row, col) &&
                        !qrCode.isDark(row + 1, col) &&
                        qrCode.isDark(row + 2, col) &&
                        qrCode.isDark(row + 3, col) &&
                        qrCode.isDark(row + 4, col) &&
                        !qrCode.isDark(row + 5, col) &&
                        qrCode.isDark(row + 6, col)
                    ) {
                        lostPoint += 40;
                    }
                }
            }

            // LEVEL4

            var darkCount = 0;

            for (var col = 0; col < moduleCount; col++) {
                for (var row = 0; row < moduleCount; row++) {
                    if (qrCode.isDark(row, col)) {
                        darkCount++;
                    }
                }
            }

            var ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
            lostPoint += ratio * 10;

            return lostPoint
        },
    };

    function QRCode(typeNumber, errorCorrectLevel) {
        this.typeNumber = typeNumber;
        this.errorCorrectLevel = errorCorrectLevel;
        this.modules = null;
        this.moduleCount = 0;
        this.dataCache = null;
        this.dataList = [];
    }

    // for client side minification
    var proto = QRCode.prototype;

    proto.addData = function (data) {
        var newData = new QR8bitByte(data);
        this.dataList.push(newData);
        this.dataCache = null;
    };

    proto.isDark = function (row, col) {
        if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
            throw new Error(row + ',' + col)
        }
        return this.modules[row][col]
    };

    proto.getModuleCount = function () {
        return this.moduleCount
    };

    proto.make = function () {
        // Calculate automatically typeNumber if provided is < 1
        if (this.typeNumber < 1) {
            var typeNumber = 1;
            for (typeNumber = 1; typeNumber < 40; typeNumber++) {
                var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, this.errorCorrectLevel);

                var buffer = new QRBitBuffer();
                var totalDataCount = 0;
                for (var i = 0; i < rsBlocks.length; i++) {
                    totalDataCount += rsBlocks[i].dataCount;
                }

                for (var i = 0; i < this.dataList.length; i++) {
                    var data = this.dataList[i];
                    buffer.put(data.mode, 4);
                    buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
                    data.write(buffer);
                }
                if (buffer.getLengthInBits() <= totalDataCount * 8) break
            }
            this.typeNumber = typeNumber;
        }
        this.makeImpl(false, this.getBestMaskPattern());
    };

    proto.makeImpl = function (test, maskPattern) {
        this.moduleCount = this.typeNumber * 4 + 17;
        this.modules = new Array(this.moduleCount);

        for (var row = 0; row < this.moduleCount; row++) {
            this.modules[row] = new Array(this.moduleCount);

            for (var col = 0; col < this.moduleCount; col++) {
                this.modules[row][col] = null; //(col + row) % 3;
            }
        }

        this.setupPositionProbePattern(0, 0);
        this.setupPositionProbePattern(this.moduleCount - 7, 0);
        this.setupPositionProbePattern(0, this.moduleCount - 7);
        this.setupPositionAdjustPattern();
        this.setupTimingPattern();
        this.setupTypeInfo(test, maskPattern);

        if (this.typeNumber >= 7) {
            this.setupTypeNumber(test);
        }

        if (this.dataCache == null) {
            this.dataCache = QRCode.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
        }

        this.mapData(this.dataCache, maskPattern);
    };

    proto.setupPositionProbePattern = function (row, col) {
        for (var r = -1; r <= 7; r++) {
            if (row + r <= -1 || this.moduleCount <= row + r) continue

            for (var c = -1; c <= 7; c++) {
                if (col + c <= -1 || this.moduleCount <= col + c) continue

                if (
                    (0 <= r && r <= 6 && (c == 0 || c == 6)) ||
                    (0 <= c && c <= 6 && (r == 0 || r == 6)) ||
                    (2 <= r && r <= 4 && 2 <= c && c <= 4)
                ) {
                    this.modules[row + r][col + c] = true;
                } else {
                    this.modules[row + r][col + c] = false;
                }
            }
        }
    };

    proto.getBestMaskPattern = function () {
        var minLostPoint = 0;
        var pattern = 0;

        for (var i = 0; i < 8; i++) {
            this.makeImpl(true, i);

            var lostPoint = QRUtil.getLostPoint(this);

            if (i == 0 || minLostPoint > lostPoint) {
                minLostPoint = lostPoint;
                pattern = i;
            }
        }

        return pattern
    };

    proto.setupTimingPattern = function () {
        for (var r = 8; r < this.moduleCount - 8; r++) {
            if (this.modules[r][6] != null) {
                continue
            }
            this.modules[r][6] = r % 2 == 0;
        }

        for (var c = 8; c < this.moduleCount - 8; c++) {
            if (this.modules[6][c] != null) {
                continue
            }
            this.modules[6][c] = c % 2 == 0;
        }
    };

    proto.setupPositionAdjustPattern = function () {
        var pos = QRUtil.getPatternPosition(this.typeNumber);

        for (var i = 0; i < pos.length; i++) {
            for (var j = 0; j < pos.length; j++) {
                var row = pos[i];
                var col = pos[j];

                if (this.modules[row][col] != null) {
                    continue
                }

                for (var r = -2; r <= 2; r++) {
                    for (var c = -2; c <= 2; c++) {
                        if (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0)) {
                            this.modules[row + r][col + c] = true;
                        } else {
                            this.modules[row + r][col + c] = false;
                        }
                    }
                }
            }
        }
    };

    proto.setupTypeNumber = function (test) {
        var bits = QRUtil.getBCHTypeNumber(this.typeNumber);

        for (var i = 0; i < 18; i++) {
            var mod = !test && ((bits >> i) & 1) == 1;
            this.modules[Math.floor(i / 3)][(i % 3) + this.moduleCount - 8 - 3] = mod;
        }

        for (var i = 0; i < 18; i++) {
            var mod = !test && ((bits >> i) & 1) == 1;
            this.modules[(i % 3) + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
        }
    };

    proto.setupTypeInfo = function (test, maskPattern) {
        var data = (this.errorCorrectLevel << 3) | maskPattern;
        var bits = QRUtil.getBCHTypeInfo(data);

        // vertical
        for (var i = 0; i < 15; i++) {
            var mod = !test && ((bits >> i) & 1) == 1;

            if (i < 6) {
                this.modules[i][8] = mod;
            } else if (i < 8) {
                this.modules[i + 1][8] = mod;
            } else {
                this.modules[this.moduleCount - 15 + i][8] = mod;
            }
        }

        // horizontal
        for (var i = 0; i < 15; i++) {
            var mod = !test && ((bits >> i) & 1) == 1;

            if (i < 8) {
                this.modules[8][this.moduleCount - i - 1] = mod;
            } else if (i < 9) {
                this.modules[8][15 - i - 1 + 1] = mod;
            } else {
                this.modules[8][15 - i - 1] = mod;
            }
        }

        // fixed module
        this.modules[this.moduleCount - 8][8] = !test;
    };

    proto.mapData = function (data, maskPattern) {
        var inc = -1;
        var row = this.moduleCount - 1;
        var bitIndex = 7;
        var byteIndex = 0;

        for (var col = this.moduleCount - 1; col > 0; col -= 2) {
            if (col == 6) col--;

            while (true) {
                for (var c = 0; c < 2; c++) {
                    if (this.modules[row][col - c] == null) {
                        var dark = false;

                        if (byteIndex < data.length) {
                            dark = ((data[byteIndex] >>> bitIndex) & 1) == 1;
                        }

                        var mask = QRUtil.getMask(maskPattern, row, col - c);

                        if (mask) {
                            dark = !dark;
                        }

                        this.modules[row][col - c] = dark;
                        bitIndex--;

                        if (bitIndex == -1) {
                            byteIndex++;
                            bitIndex = 7;
                        }
                    }
                }

                row += inc;

                if (row < 0 || this.moduleCount <= row) {
                    row -= inc;
                    inc = -inc;
                    break
                }
            }
        }
    };

    QRCode.PAD0 = 0xec;
    QRCode.PAD1 = 0x11;

    QRCode.createData = function (typeNumber, errorCorrectLevel, dataList) {
        var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel);

        var buffer = new QRBitBuffer();

        for (var i = 0; i < dataList.length; i++) {
            var data = dataList[i];
            buffer.put(data.mode, 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
            data.write(buffer);
        }

        // calc num max data.
        var totalDataCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
        }

        if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw new Error(
                'code length overflow. (' + buffer.getLengthInBits() + '>' + totalDataCount * 8 + ')'
            )
        }

        // end code
        if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
        }

        // padding
        while (buffer.getLengthInBits() % 8 != 0) {
            buffer.putBit(false);
        }

        // padding
        while (true) {
            if (buffer.getLengthInBits() >= totalDataCount * 8) {
                break
            }
            buffer.put(QRCode.PAD0, 8);

            if (buffer.getLengthInBits() >= totalDataCount * 8) {
                break
            }
            buffer.put(QRCode.PAD1, 8);
        }

        return QRCode.createBytes(buffer, rsBlocks)
    };

    QRCode.createBytes = function (buffer, rsBlocks) {
        var offset = 0;

        var maxDcCount = 0;
        var maxEcCount = 0;

        var dcdata = new Array(rsBlocks.length);
        var ecdata = new Array(rsBlocks.length);

        for (var r = 0; r < rsBlocks.length; r++) {
            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;

            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);

            dcdata[r] = new Array(dcCount);

            for (var i = 0; i < dcdata[r].length; i++) {
                dcdata[r][i] = 0xff & buffer.buffer[i + offset];
            }
            offset += dcCount;

            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);

            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i++) {
                var modIndex = i + modPoly.getLength() - ecdata[r].length;
                ecdata[r][i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
            }
        }

        var totalCodeCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) {
            totalCodeCount += rsBlocks[i].totalCount;
        }

        var data = new Array(totalCodeCount);
        var index = 0;

        for (var i = 0; i < maxDcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) {
                if (i < dcdata[r].length) {
                    data[index++] = dcdata[r][i];
                }
            }
        }

        for (var i = 0; i < maxEcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) {
                if (i < ecdata[r].length) {
                    data[index++] = ecdata[r][i];
                }
            }
        }

        return data
    };

    /* node_modules/svelte-qr/src/QR.svelte generated by Svelte v3.55.1 */

    function get_each_context$2(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[5] = list[i];
    	return child_ctx;
    }

    // (48:4) {#each rects as rect}
    function create_each_block$2(ctx) {
    	let rect;
    	let rect_levels = [/*rect*/ ctx[5]];
    	let rect_data = {};

    	for (let i = 0; i < rect_levels.length; i += 1) {
    		rect_data = assign(rect_data, rect_levels[i]);
    	}

    	return {
    		c() {
    			rect = svg_element("rect");
    			set_svg_attributes(rect, rect_data);
    			toggle_class(rect, "svelte-2fcki1", true);
    		},
    		m(target, anchor) {
    			insert(target, rect, anchor);
    		},
    		p(ctx, dirty) {
    			set_svg_attributes(rect, rect_data = get_spread_update(rect_levels, [/*rect*/ ctx[5]]));
    			toggle_class(rect, "svelte-2fcki1", true);
    		},
    		d(detaching) {
    			if (detaching) detach(rect);
    		}
    	};
    }

    function create_fragment$5(ctx) {
    	let svg;
    	let svg_viewBox_value;
    	let each_value = /*rects*/ ctx[1];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
    	}

    	return {
    		c() {
    			svg = svg_element("svg");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr(svg, "class", "qr svelte-2fcki1");
    			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
    			attr(svg, "viewBox", svg_viewBox_value = "0 0 " + /*size*/ ctx[0] + " " + /*size*/ ctx[0]);
    		},
    		m(target, anchor) {
    			insert(target, svg, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(svg, null);
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*rects*/ 2) {
    				each_value = /*rects*/ ctx[1];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$2(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block$2(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(svg, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value.length;
    			}

    			if (dirty & /*size*/ 1 && svg_viewBox_value !== (svg_viewBox_value = "0 0 " + /*size*/ ctx[0] + " " + /*size*/ ctx[0])) {
    				attr(svg, "viewBox", svg_viewBox_value);
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(svg);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$5($$self, $$props, $$invalidate) {
    	let { text } = $$props;
    	let { level = "L" } = $$props;
    	let { version = -1 } = $$props;
    	let size;
    	let rects = [];

    	$$self.$$set = $$props => {
    		if ('text' in $$props) $$invalidate(2, text = $$props.text);
    		if ('level' in $$props) $$invalidate(3, level = $$props.level);
    		if ('version' in $$props) $$invalidate(4, version = $$props.version);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*version, level, text*/ 28) {
    			{
    				let qr = new QRCode(version, ErrorCorrectLevel[level]);
    				qr.addData(text);
    				qr.make();
    				const rows = qr.modules;
    				$$invalidate(0, size = rows.length);

    				for (const [y, row] of rows.entries()) {
    					let rect;

    					for (const [x, on] of row.entries()) {
    						if (on) {
    							if (!rect) rect = { x, y, width: 0, height: 1 };
    							rect.width++;
    						} else {
    							if (rect && rect.width > 0) {
    								rects.push(rect);
    							}

    							rect = void 0;
    						}
    					}

    					if (rect && rect.width > 0) {
    						rects.push(rect);
    					}
    				}
    			}
    		}
    	};

    	return [size, rects, text, level, version];
    }

    class QR extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance$5, create_fragment$5, safe_not_equal, { text: 2, level: 3, version: 4 });
    	}
    }

    var _nodeResolve_empty = {};

    var nodeCrypto = /*#__PURE__*/Object.freeze({
        __proto__: null,
        default: _nodeResolve_empty
    });

    /*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
    const _0n = BigInt(0);
    const _1n = BigInt(1);
    const _2n = BigInt(2);
    const _3n = BigInt(3);
    const _8n = BigInt(8);
    const CURVE = Object.freeze({
        a: _0n,
        b: BigInt(7),
        P: BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f'),
        n: BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'),
        h: _1n,
        Gx: BigInt('55066263022277343669578718895168534326250603453777594175500187360389116729240'),
        Gy: BigInt('32670510020758816978083085130507043184471273380659243275938904335757337482424'),
        beta: BigInt('0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee'),
    });
    const divNearest = (a, b) => (a + b / _2n) / b;
    const endo = {
        beta: BigInt('0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee'),
        splitScalar(k) {
            const { n } = CURVE;
            const a1 = BigInt('0x3086d221a7d46bcde86c90e49284eb15');
            const b1 = -_1n * BigInt('0xe4437ed6010e88286f547fa90abfe4c3');
            const a2 = BigInt('0x114ca50f7a8e2f3f657c1108d9d44cfd8');
            const b2 = a1;
            const POW_2_128 = BigInt('0x100000000000000000000000000000000');
            const c1 = divNearest(b2 * k, n);
            const c2 = divNearest(-b1 * k, n);
            let k1 = mod(k - c1 * a1 - c2 * a2, n);
            let k2 = mod(-c1 * b1 - c2 * b2, n);
            const k1neg = k1 > POW_2_128;
            const k2neg = k2 > POW_2_128;
            if (k1neg)
                k1 = n - k1;
            if (k2neg)
                k2 = n - k2;
            if (k1 > POW_2_128 || k2 > POW_2_128) {
                throw new Error('splitScalarEndo: Endomorphism failed, k=' + k);
            }
            return { k1neg, k1, k2neg, k2 };
        },
    };
    const fieldLen = 32;
    const groupLen = 32;
    const hashLen = 32;
    const compressedLen = fieldLen + 1;
    const uncompressedLen = 2 * fieldLen + 1;
    function weierstrass(x) {
        const { a, b } = CURVE;
        const x2 = mod(x * x);
        const x3 = mod(x2 * x);
        return mod(x3 + a * x + b);
    }
    const USE_ENDOMORPHISM = CURVE.a === _0n;
    class ShaError extends Error {
        constructor(message) {
            super(message);
        }
    }
    function assertJacPoint(other) {
        if (!(other instanceof JacobianPoint))
            throw new TypeError('JacobianPoint expected');
    }
    class JacobianPoint {
        constructor(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        static fromAffine(p) {
            if (!(p instanceof Point)) {
                throw new TypeError('JacobianPoint#fromAffine: expected Point');
            }
            if (p.equals(Point.ZERO))
                return JacobianPoint.ZERO;
            return new JacobianPoint(p.x, p.y, _1n);
        }
        static toAffineBatch(points) {
            const toInv = invertBatch(points.map((p) => p.z));
            return points.map((p, i) => p.toAffine(toInv[i]));
        }
        static normalizeZ(points) {
            return JacobianPoint.toAffineBatch(points).map(JacobianPoint.fromAffine);
        }
        equals(other) {
            assertJacPoint(other);
            const { x: X1, y: Y1, z: Z1 } = this;
            const { x: X2, y: Y2, z: Z2 } = other;
            const Z1Z1 = mod(Z1 * Z1);
            const Z2Z2 = mod(Z2 * Z2);
            const U1 = mod(X1 * Z2Z2);
            const U2 = mod(X2 * Z1Z1);
            const S1 = mod(mod(Y1 * Z2) * Z2Z2);
            const S2 = mod(mod(Y2 * Z1) * Z1Z1);
            return U1 === U2 && S1 === S2;
        }
        negate() {
            return new JacobianPoint(this.x, mod(-this.y), this.z);
        }
        double() {
            const { x: X1, y: Y1, z: Z1 } = this;
            const A = mod(X1 * X1);
            const B = mod(Y1 * Y1);
            const C = mod(B * B);
            const x1b = X1 + B;
            const D = mod(_2n * (mod(x1b * x1b) - A - C));
            const E = mod(_3n * A);
            const F = mod(E * E);
            const X3 = mod(F - _2n * D);
            const Y3 = mod(E * (D - X3) - _8n * C);
            const Z3 = mod(_2n * Y1 * Z1);
            return new JacobianPoint(X3, Y3, Z3);
        }
        add(other) {
            assertJacPoint(other);
            const { x: X1, y: Y1, z: Z1 } = this;
            const { x: X2, y: Y2, z: Z2 } = other;
            if (X2 === _0n || Y2 === _0n)
                return this;
            if (X1 === _0n || Y1 === _0n)
                return other;
            const Z1Z1 = mod(Z1 * Z1);
            const Z2Z2 = mod(Z2 * Z2);
            const U1 = mod(X1 * Z2Z2);
            const U2 = mod(X2 * Z1Z1);
            const S1 = mod(mod(Y1 * Z2) * Z2Z2);
            const S2 = mod(mod(Y2 * Z1) * Z1Z1);
            const H = mod(U2 - U1);
            const r = mod(S2 - S1);
            if (H === _0n) {
                if (r === _0n) {
                    return this.double();
                }
                else {
                    return JacobianPoint.ZERO;
                }
            }
            const HH = mod(H * H);
            const HHH = mod(H * HH);
            const V = mod(U1 * HH);
            const X3 = mod(r * r - HHH - _2n * V);
            const Y3 = mod(r * (V - X3) - S1 * HHH);
            const Z3 = mod(Z1 * Z2 * H);
            return new JacobianPoint(X3, Y3, Z3);
        }
        subtract(other) {
            return this.add(other.negate());
        }
        multiplyUnsafe(scalar) {
            const P0 = JacobianPoint.ZERO;
            if (typeof scalar === 'bigint' && scalar === _0n)
                return P0;
            let n = normalizeScalar(scalar);
            if (n === _1n)
                return this;
            if (!USE_ENDOMORPHISM) {
                let p = P0;
                let d = this;
                while (n > _0n) {
                    if (n & _1n)
                        p = p.add(d);
                    d = d.double();
                    n >>= _1n;
                }
                return p;
            }
            let { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
            let k1p = P0;
            let k2p = P0;
            let d = this;
            while (k1 > _0n || k2 > _0n) {
                if (k1 & _1n)
                    k1p = k1p.add(d);
                if (k2 & _1n)
                    k2p = k2p.add(d);
                d = d.double();
                k1 >>= _1n;
                k2 >>= _1n;
            }
            if (k1neg)
                k1p = k1p.negate();
            if (k2neg)
                k2p = k2p.negate();
            k2p = new JacobianPoint(mod(k2p.x * endo.beta), k2p.y, k2p.z);
            return k1p.add(k2p);
        }
        precomputeWindow(W) {
            const windows = USE_ENDOMORPHISM ? 128 / W + 1 : 256 / W + 1;
            const points = [];
            let p = this;
            let base = p;
            for (let window = 0; window < windows; window++) {
                base = p;
                points.push(base);
                for (let i = 1; i < 2 ** (W - 1); i++) {
                    base = base.add(p);
                    points.push(base);
                }
                p = base.double();
            }
            return points;
        }
        wNAF(n, affinePoint) {
            if (!affinePoint && this.equals(JacobianPoint.BASE))
                affinePoint = Point.BASE;
            const W = (affinePoint && affinePoint._WINDOW_SIZE) || 1;
            if (256 % W) {
                throw new Error('Point#wNAF: Invalid precomputation window, must be power of 2');
            }
            let precomputes = affinePoint && pointPrecomputes.get(affinePoint);
            if (!precomputes) {
                precomputes = this.precomputeWindow(W);
                if (affinePoint && W !== 1) {
                    precomputes = JacobianPoint.normalizeZ(precomputes);
                    pointPrecomputes.set(affinePoint, precomputes);
                }
            }
            let p = JacobianPoint.ZERO;
            let f = JacobianPoint.BASE;
            const windows = 1 + (USE_ENDOMORPHISM ? 128 / W : 256 / W);
            const windowSize = 2 ** (W - 1);
            const mask = BigInt(2 ** W - 1);
            const maxNumber = 2 ** W;
            const shiftBy = BigInt(W);
            for (let window = 0; window < windows; window++) {
                const offset = window * windowSize;
                let wbits = Number(n & mask);
                n >>= shiftBy;
                if (wbits > windowSize) {
                    wbits -= maxNumber;
                    n += _1n;
                }
                const offset1 = offset;
                const offset2 = offset + Math.abs(wbits) - 1;
                const cond1 = window % 2 !== 0;
                const cond2 = wbits < 0;
                if (wbits === 0) {
                    f = f.add(constTimeNegate(cond1, precomputes[offset1]));
                }
                else {
                    p = p.add(constTimeNegate(cond2, precomputes[offset2]));
                }
            }
            return { p, f };
        }
        multiply(scalar, affinePoint) {
            let n = normalizeScalar(scalar);
            let point;
            let fake;
            if (USE_ENDOMORPHISM) {
                const { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
                let { p: k1p, f: f1p } = this.wNAF(k1, affinePoint);
                let { p: k2p, f: f2p } = this.wNAF(k2, affinePoint);
                k1p = constTimeNegate(k1neg, k1p);
                k2p = constTimeNegate(k2neg, k2p);
                k2p = new JacobianPoint(mod(k2p.x * endo.beta), k2p.y, k2p.z);
                point = k1p.add(k2p);
                fake = f1p.add(f2p);
            }
            else {
                const { p, f } = this.wNAF(n, affinePoint);
                point = p;
                fake = f;
            }
            return JacobianPoint.normalizeZ([point, fake])[0];
        }
        toAffine(invZ) {
            const { x, y, z } = this;
            const is0 = this.equals(JacobianPoint.ZERO);
            if (invZ == null)
                invZ = is0 ? _8n : invert(z);
            const iz1 = invZ;
            const iz2 = mod(iz1 * iz1);
            const iz3 = mod(iz2 * iz1);
            const ax = mod(x * iz2);
            const ay = mod(y * iz3);
            const zz = mod(z * iz1);
            if (is0)
                return Point.ZERO;
            if (zz !== _1n)
                throw new Error('invZ was invalid');
            return new Point(ax, ay);
        }
    }
    JacobianPoint.BASE = new JacobianPoint(CURVE.Gx, CURVE.Gy, _1n);
    JacobianPoint.ZERO = new JacobianPoint(_0n, _1n, _0n);
    function constTimeNegate(condition, item) {
        const neg = item.negate();
        return condition ? neg : item;
    }
    const pointPrecomputes = new WeakMap();
    class Point {
        constructor(x, y) {
            this.x = x;
            this.y = y;
        }
        _setWindowSize(windowSize) {
            this._WINDOW_SIZE = windowSize;
            pointPrecomputes.delete(this);
        }
        hasEvenY() {
            return this.y % _2n === _0n;
        }
        static fromCompressedHex(bytes) {
            const isShort = bytes.length === 32;
            const x = bytesToNumber$1(isShort ? bytes : bytes.subarray(1));
            if (!isValidFieldElement(x))
                throw new Error('Point is not on curve');
            const y2 = weierstrass(x);
            let y = sqrtMod(y2);
            const isYOdd = (y & _1n) === _1n;
            if (isShort) {
                if (isYOdd)
                    y = mod(-y);
            }
            else {
                const isFirstByteOdd = (bytes[0] & 1) === 1;
                if (isFirstByteOdd !== isYOdd)
                    y = mod(-y);
            }
            const point = new Point(x, y);
            point.assertValidity();
            return point;
        }
        static fromUncompressedHex(bytes) {
            const x = bytesToNumber$1(bytes.subarray(1, fieldLen + 1));
            const y = bytesToNumber$1(bytes.subarray(fieldLen + 1, fieldLen * 2 + 1));
            const point = new Point(x, y);
            point.assertValidity();
            return point;
        }
        static fromHex(hex) {
            const bytes = ensureBytes(hex);
            const len = bytes.length;
            const header = bytes[0];
            if (len === fieldLen)
                return this.fromCompressedHex(bytes);
            if (len === compressedLen && (header === 0x02 || header === 0x03)) {
                return this.fromCompressedHex(bytes);
            }
            if (len === uncompressedLen && header === 0x04)
                return this.fromUncompressedHex(bytes);
            throw new Error(`Point.fromHex: received invalid point. Expected 32-${compressedLen} compressed bytes or ${uncompressedLen} uncompressed bytes, not ${len}`);
        }
        static fromPrivateKey(privateKey) {
            return Point.BASE.multiply(normalizePrivateKey(privateKey));
        }
        static fromSignature(msgHash, signature, recovery) {
            const { r, s } = normalizeSignature(signature);
            if (![0, 1, 2, 3].includes(recovery))
                throw new Error('Cannot recover: invalid recovery bit');
            const h = truncateHash(ensureBytes(msgHash));
            const { n } = CURVE;
            const radj = recovery === 2 || recovery === 3 ? r + n : r;
            const rinv = invert(radj, n);
            const u1 = mod(-h * rinv, n);
            const u2 = mod(s * rinv, n);
            const prefix = recovery & 1 ? '03' : '02';
            const R = Point.fromHex(prefix + numTo32bStr(radj));
            const Q = Point.BASE.multiplyAndAddUnsafe(R, u1, u2);
            if (!Q)
                throw new Error('Cannot recover signature: point at infinify');
            Q.assertValidity();
            return Q;
        }
        toRawBytes(isCompressed = false) {
            return hexToBytes$1(this.toHex(isCompressed));
        }
        toHex(isCompressed = false) {
            const x = numTo32bStr(this.x);
            if (isCompressed) {
                const prefix = this.hasEvenY() ? '02' : '03';
                return `${prefix}${x}`;
            }
            else {
                return `04${x}${numTo32bStr(this.y)}`;
            }
        }
        toHexX() {
            return this.toHex(true).slice(2);
        }
        toRawX() {
            return this.toRawBytes(true).slice(1);
        }
        assertValidity() {
            const msg = 'Point is not on elliptic curve';
            const { x, y } = this;
            if (!isValidFieldElement(x) || !isValidFieldElement(y))
                throw new Error(msg);
            const left = mod(y * y);
            const right = weierstrass(x);
            if (mod(left - right) !== _0n)
                throw new Error(msg);
        }
        equals(other) {
            return this.x === other.x && this.y === other.y;
        }
        negate() {
            return new Point(this.x, mod(-this.y));
        }
        double() {
            return JacobianPoint.fromAffine(this).double().toAffine();
        }
        add(other) {
            return JacobianPoint.fromAffine(this).add(JacobianPoint.fromAffine(other)).toAffine();
        }
        subtract(other) {
            return this.add(other.negate());
        }
        multiply(scalar) {
            return JacobianPoint.fromAffine(this).multiply(scalar, this).toAffine();
        }
        multiplyAndAddUnsafe(Q, a, b) {
            const P = JacobianPoint.fromAffine(this);
            const aP = a === _0n || a === _1n || this !== Point.BASE ? P.multiplyUnsafe(a) : P.multiply(a);
            const bQ = JacobianPoint.fromAffine(Q).multiplyUnsafe(b);
            const sum = aP.add(bQ);
            return sum.equals(JacobianPoint.ZERO) ? undefined : sum.toAffine();
        }
    }
    Point.BASE = new Point(CURVE.Gx, CURVE.Gy);
    Point.ZERO = new Point(_0n, _0n);
    function sliceDER(s) {
        return Number.parseInt(s[0], 16) >= 8 ? '00' + s : s;
    }
    function parseDERInt(data) {
        if (data.length < 2 || data[0] !== 0x02) {
            throw new Error(`Invalid signature integer tag: ${bytesToHex$1(data)}`);
        }
        const len = data[1];
        const res = data.subarray(2, len + 2);
        if (!len || res.length !== len) {
            throw new Error(`Invalid signature integer: wrong length`);
        }
        if (res[0] === 0x00 && res[1] <= 0x7f) {
            throw new Error('Invalid signature integer: trailing length');
        }
        return { data: bytesToNumber$1(res), left: data.subarray(len + 2) };
    }
    function parseDERSignature(data) {
        if (data.length < 2 || data[0] != 0x30) {
            throw new Error(`Invalid signature tag: ${bytesToHex$1(data)}`);
        }
        if (data[1] !== data.length - 2) {
            throw new Error('Invalid signature: incorrect length');
        }
        const { data: r, left: sBytes } = parseDERInt(data.subarray(2));
        const { data: s, left: rBytesLeft } = parseDERInt(sBytes);
        if (rBytesLeft.length) {
            throw new Error(`Invalid signature: left bytes after parsing: ${bytesToHex$1(rBytesLeft)}`);
        }
        return { r, s };
    }
    class Signature {
        constructor(r, s) {
            this.r = r;
            this.s = s;
            this.assertValidity();
        }
        static fromCompact(hex) {
            const arr = hex instanceof Uint8Array;
            const name = 'Signature.fromCompact';
            if (typeof hex !== 'string' && !arr)
                throw new TypeError(`${name}: Expected string or Uint8Array`);
            const str = arr ? bytesToHex$1(hex) : hex;
            if (str.length !== 128)
                throw new Error(`${name}: Expected 64-byte hex`);
            return new Signature(hexToNumber(str.slice(0, 64)), hexToNumber(str.slice(64, 128)));
        }
        static fromDER(hex) {
            const arr = hex instanceof Uint8Array;
            if (typeof hex !== 'string' && !arr)
                throw new TypeError(`Signature.fromDER: Expected string or Uint8Array`);
            const { r, s } = parseDERSignature(arr ? hex : hexToBytes$1(hex));
            return new Signature(r, s);
        }
        static fromHex(hex) {
            return this.fromDER(hex);
        }
        assertValidity() {
            const { r, s } = this;
            if (!isWithinCurveOrder(r))
                throw new Error('Invalid Signature: r must be 0 < r < n');
            if (!isWithinCurveOrder(s))
                throw new Error('Invalid Signature: s must be 0 < s < n');
        }
        hasHighS() {
            const HALF = CURVE.n >> _1n;
            return this.s > HALF;
        }
        normalizeS() {
            return this.hasHighS() ? new Signature(this.r, mod(-this.s, CURVE.n)) : this;
        }
        toDERRawBytes() {
            return hexToBytes$1(this.toDERHex());
        }
        toDERHex() {
            const sHex = sliceDER(numberToHexUnpadded(this.s));
            const rHex = sliceDER(numberToHexUnpadded(this.r));
            const sHexL = sHex.length / 2;
            const rHexL = rHex.length / 2;
            const sLen = numberToHexUnpadded(sHexL);
            const rLen = numberToHexUnpadded(rHexL);
            const length = numberToHexUnpadded(rHexL + sHexL + 4);
            return `30${length}02${rLen}${rHex}02${sLen}${sHex}`;
        }
        toRawBytes() {
            return this.toDERRawBytes();
        }
        toHex() {
            return this.toDERHex();
        }
        toCompactRawBytes() {
            return hexToBytes$1(this.toCompactHex());
        }
        toCompactHex() {
            return numTo32bStr(this.r) + numTo32bStr(this.s);
        }
    }
    function concatBytes$1(...arrays) {
        if (!arrays.every((b) => b instanceof Uint8Array))
            throw new Error('Uint8Array list expected');
        if (arrays.length === 1)
            return arrays[0];
        const length = arrays.reduce((a, arr) => a + arr.length, 0);
        const result = new Uint8Array(length);
        for (let i = 0, pad = 0; i < arrays.length; i++) {
            const arr = arrays[i];
            result.set(arr, pad);
            pad += arr.length;
        }
        return result;
    }
    const hexes$1 = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));
    function bytesToHex$1(uint8a) {
        if (!(uint8a instanceof Uint8Array))
            throw new Error('Expected Uint8Array');
        let hex = '';
        for (let i = 0; i < uint8a.length; i++) {
            hex += hexes$1[uint8a[i]];
        }
        return hex;
    }
    const POW_2_256 = BigInt('0x10000000000000000000000000000000000000000000000000000000000000000');
    function numTo32bStr(num) {
        if (typeof num !== 'bigint')
            throw new Error('Expected bigint');
        if (!(_0n <= num && num < POW_2_256))
            throw new Error('Expected number 0 <= n < 2^256');
        return num.toString(16).padStart(64, '0');
    }
    function numTo32b(num) {
        const b = hexToBytes$1(numTo32bStr(num));
        if (b.length !== 32)
            throw new Error('Error: expected 32 bytes');
        return b;
    }
    function numberToHexUnpadded(num) {
        const hex = num.toString(16);
        return hex.length & 1 ? `0${hex}` : hex;
    }
    function hexToNumber(hex) {
        if (typeof hex !== 'string') {
            throw new TypeError('hexToNumber: expected string, got ' + typeof hex);
        }
        return BigInt(`0x${hex}`);
    }
    function hexToBytes$1(hex) {
        if (typeof hex !== 'string') {
            throw new TypeError('hexToBytes: expected string, got ' + typeof hex);
        }
        if (hex.length % 2)
            throw new Error('hexToBytes: received invalid unpadded hex' + hex.length);
        const array = new Uint8Array(hex.length / 2);
        for (let i = 0; i < array.length; i++) {
            const j = i * 2;
            const hexByte = hex.slice(j, j + 2);
            const byte = Number.parseInt(hexByte, 16);
            if (Number.isNaN(byte) || byte < 0)
                throw new Error('Invalid byte sequence');
            array[i] = byte;
        }
        return array;
    }
    function bytesToNumber$1(bytes) {
        return hexToNumber(bytesToHex$1(bytes));
    }
    function ensureBytes(hex) {
        return hex instanceof Uint8Array ? Uint8Array.from(hex) : hexToBytes$1(hex);
    }
    function normalizeScalar(num) {
        if (typeof num === 'number' && Number.isSafeInteger(num) && num > 0)
            return BigInt(num);
        if (typeof num === 'bigint' && isWithinCurveOrder(num))
            return num;
        throw new TypeError('Expected valid private scalar: 0 < scalar < curve.n');
    }
    function mod(a, b = CURVE.P) {
        const result = a % b;
        return result >= _0n ? result : b + result;
    }
    function pow2(x, power) {
        const { P } = CURVE;
        let res = x;
        while (power-- > _0n) {
            res *= res;
            res %= P;
        }
        return res;
    }
    function sqrtMod(x) {
        const { P } = CURVE;
        const _6n = BigInt(6);
        const _11n = BigInt(11);
        const _22n = BigInt(22);
        const _23n = BigInt(23);
        const _44n = BigInt(44);
        const _88n = BigInt(88);
        const b2 = (x * x * x) % P;
        const b3 = (b2 * b2 * x) % P;
        const b6 = (pow2(b3, _3n) * b3) % P;
        const b9 = (pow2(b6, _3n) * b3) % P;
        const b11 = (pow2(b9, _2n) * b2) % P;
        const b22 = (pow2(b11, _11n) * b11) % P;
        const b44 = (pow2(b22, _22n) * b22) % P;
        const b88 = (pow2(b44, _44n) * b44) % P;
        const b176 = (pow2(b88, _88n) * b88) % P;
        const b220 = (pow2(b176, _44n) * b44) % P;
        const b223 = (pow2(b220, _3n) * b3) % P;
        const t1 = (pow2(b223, _23n) * b22) % P;
        const t2 = (pow2(t1, _6n) * b2) % P;
        const rt = pow2(t2, _2n);
        const xc = (rt * rt) % P;
        if (xc !== x)
            throw new Error('Cannot find square root');
        return rt;
    }
    function invert(number, modulo = CURVE.P) {
        if (number === _0n || modulo <= _0n) {
            throw new Error(`invert: expected positive integers, got n=${number} mod=${modulo}`);
        }
        let a = mod(number, modulo);
        let b = modulo;
        let x = _0n, u = _1n;
        while (a !== _0n) {
            const q = b / a;
            const r = b % a;
            const m = x - u * q;
            b = a, a = r, x = u, u = m;
        }
        const gcd = b;
        if (gcd !== _1n)
            throw new Error('invert: does not exist');
        return mod(x, modulo);
    }
    function invertBatch(nums, p = CURVE.P) {
        const scratch = new Array(nums.length);
        const lastMultiplied = nums.reduce((acc, num, i) => {
            if (num === _0n)
                return acc;
            scratch[i] = acc;
            return mod(acc * num, p);
        }, _1n);
        const inverted = invert(lastMultiplied, p);
        nums.reduceRight((acc, num, i) => {
            if (num === _0n)
                return acc;
            scratch[i] = mod(acc * scratch[i], p);
            return mod(acc * num, p);
        }, inverted);
        return scratch;
    }
    function bits2int_2(bytes) {
        const delta = bytes.length * 8 - groupLen * 8;
        const num = bytesToNumber$1(bytes);
        return delta > 0 ? num >> BigInt(delta) : num;
    }
    function truncateHash(hash, truncateOnly = false) {
        const h = bits2int_2(hash);
        if (truncateOnly)
            return h;
        const { n } = CURVE;
        return h >= n ? h - n : h;
    }
    let _sha256Sync;
    let _hmacSha256Sync;
    class HmacDrbg {
        constructor(hashLen, qByteLen) {
            this.hashLen = hashLen;
            this.qByteLen = qByteLen;
            if (typeof hashLen !== 'number' || hashLen < 2)
                throw new Error('hashLen must be a number');
            if (typeof qByteLen !== 'number' || qByteLen < 2)
                throw new Error('qByteLen must be a number');
            this.v = new Uint8Array(hashLen).fill(1);
            this.k = new Uint8Array(hashLen).fill(0);
            this.counter = 0;
        }
        hmac(...values) {
            return utils$1.hmacSha256(this.k, ...values);
        }
        hmacSync(...values) {
            return _hmacSha256Sync(this.k, ...values);
        }
        checkSync() {
            if (typeof _hmacSha256Sync !== 'function')
                throw new ShaError('hmacSha256Sync needs to be set');
        }
        incr() {
            if (this.counter >= 1000)
                throw new Error('Tried 1,000 k values for sign(), all were invalid');
            this.counter += 1;
        }
        async reseed(seed = new Uint8Array()) {
            this.k = await this.hmac(this.v, Uint8Array.from([0x00]), seed);
            this.v = await this.hmac(this.v);
            if (seed.length === 0)
                return;
            this.k = await this.hmac(this.v, Uint8Array.from([0x01]), seed);
            this.v = await this.hmac(this.v);
        }
        reseedSync(seed = new Uint8Array()) {
            this.checkSync();
            this.k = this.hmacSync(this.v, Uint8Array.from([0x00]), seed);
            this.v = this.hmacSync(this.v);
            if (seed.length === 0)
                return;
            this.k = this.hmacSync(this.v, Uint8Array.from([0x01]), seed);
            this.v = this.hmacSync(this.v);
        }
        async generate() {
            this.incr();
            let len = 0;
            const out = [];
            while (len < this.qByteLen) {
                this.v = await this.hmac(this.v);
                const sl = this.v.slice();
                out.push(sl);
                len += this.v.length;
            }
            return concatBytes$1(...out);
        }
        generateSync() {
            this.checkSync();
            this.incr();
            let len = 0;
            const out = [];
            while (len < this.qByteLen) {
                this.v = this.hmacSync(this.v);
                const sl = this.v.slice();
                out.push(sl);
                len += this.v.length;
            }
            return concatBytes$1(...out);
        }
    }
    function isWithinCurveOrder(num) {
        return _0n < num && num < CURVE.n;
    }
    function isValidFieldElement(num) {
        return _0n < num && num < CURVE.P;
    }
    function kmdToSig(kBytes, m, d, lowS = true) {
        const { n } = CURVE;
        const k = truncateHash(kBytes, true);
        if (!isWithinCurveOrder(k))
            return;
        const kinv = invert(k, n);
        const q = Point.BASE.multiply(k);
        const r = mod(q.x, n);
        if (r === _0n)
            return;
        const s = mod(kinv * mod(m + d * r, n), n);
        if (s === _0n)
            return;
        let sig = new Signature(r, s);
        let recovery = (q.x === sig.r ? 0 : 2) | Number(q.y & _1n);
        if (lowS && sig.hasHighS()) {
            sig = sig.normalizeS();
            recovery ^= 1;
        }
        return { sig, recovery };
    }
    function normalizePrivateKey(key) {
        let num;
        if (typeof key === 'bigint') {
            num = key;
        }
        else if (typeof key === 'number' && Number.isSafeInteger(key) && key > 0) {
            num = BigInt(key);
        }
        else if (typeof key === 'string') {
            if (key.length !== 2 * groupLen)
                throw new Error('Expected 32 bytes of private key');
            num = hexToNumber(key);
        }
        else if (key instanceof Uint8Array) {
            if (key.length !== groupLen)
                throw new Error('Expected 32 bytes of private key');
            num = bytesToNumber$1(key);
        }
        else {
            throw new TypeError('Expected valid private key');
        }
        if (!isWithinCurveOrder(num))
            throw new Error('Expected private key: 0 < key < n');
        return num;
    }
    function normalizePublicKey(publicKey) {
        if (publicKey instanceof Point) {
            publicKey.assertValidity();
            return publicKey;
        }
        else {
            return Point.fromHex(publicKey);
        }
    }
    function normalizeSignature(signature) {
        if (signature instanceof Signature) {
            signature.assertValidity();
            return signature;
        }
        try {
            return Signature.fromDER(signature);
        }
        catch (error) {
            return Signature.fromCompact(signature);
        }
    }
    function getPublicKey$1(privateKey, isCompressed = false) {
        return Point.fromPrivateKey(privateKey).toRawBytes(isCompressed);
    }
    function isProbPub(item) {
        const arr = item instanceof Uint8Array;
        const str = typeof item === 'string';
        const len = (arr || str) && item.length;
        if (arr)
            return len === compressedLen || len === uncompressedLen;
        if (str)
            return len === compressedLen * 2 || len === uncompressedLen * 2;
        if (item instanceof Point)
            return true;
        return false;
    }
    function getSharedSecret(privateA, publicB, isCompressed = false) {
        if (isProbPub(privateA))
            throw new TypeError('getSharedSecret: first arg must be private key');
        if (!isProbPub(publicB))
            throw new TypeError('getSharedSecret: second arg must be public key');
        const b = normalizePublicKey(publicB);
        b.assertValidity();
        return b.multiply(normalizePrivateKey(privateA)).toRawBytes(isCompressed);
    }
    function bits2int(bytes) {
        const slice = bytes.length > fieldLen ? bytes.slice(0, fieldLen) : bytes;
        return bytesToNumber$1(slice);
    }
    function bits2octets(bytes) {
        const z1 = bits2int(bytes);
        const z2 = mod(z1, CURVE.n);
        return int2octets(z2 < _0n ? z1 : z2);
    }
    function int2octets(num) {
        return numTo32b(num);
    }
    function initSigArgs(msgHash, privateKey, extraEntropy) {
        if (msgHash == null)
            throw new Error(`sign: expected valid message hash, not "${msgHash}"`);
        const h1 = ensureBytes(msgHash);
        const d = normalizePrivateKey(privateKey);
        const seedArgs = [int2octets(d), bits2octets(h1)];
        if (extraEntropy != null) {
            if (extraEntropy === true)
                extraEntropy = utils$1.randomBytes(fieldLen);
            const e = ensureBytes(extraEntropy);
            if (e.length !== fieldLen)
                throw new Error(`sign: Expected ${fieldLen} bytes of extra data`);
            seedArgs.push(e);
        }
        const seed = concatBytes$1(...seedArgs);
        const m = bits2int(h1);
        return { seed, m, d };
    }
    function finalizeSig(recSig, opts) {
        const { sig, recovery } = recSig;
        const { der, recovered } = Object.assign({ canonical: true, der: true }, opts);
        const hashed = der ? sig.toDERRawBytes() : sig.toCompactRawBytes();
        return recovered ? [hashed, recovery] : hashed;
    }
    function signSync(msgHash, privKey, opts = {}) {
        const { seed, m, d } = initSigArgs(msgHash, privKey, opts.extraEntropy);
        const drbg = new HmacDrbg(hashLen, groupLen);
        drbg.reseedSync(seed);
        let sig;
        while (!(sig = kmdToSig(drbg.generateSync(), m, d, opts.canonical)))
            drbg.reseedSync();
        return finalizeSig(sig, opts);
    }
    const vopts = { strict: true };
    function verify(signature, msgHash, publicKey, opts = vopts) {
        let sig;
        try {
            sig = normalizeSignature(signature);
            msgHash = ensureBytes(msgHash);
        }
        catch (error) {
            return false;
        }
        const { r, s } = sig;
        if (opts.strict && sig.hasHighS())
            return false;
        const h = truncateHash(msgHash);
        let P;
        try {
            P = normalizePublicKey(publicKey);
        }
        catch (error) {
            return false;
        }
        const { n } = CURVE;
        const sinv = invert(s, n);
        const u1 = mod(h * sinv, n);
        const u2 = mod(r * sinv, n);
        const R = Point.BASE.multiplyAndAddUnsafe(P, u1, u2);
        if (!R)
            return false;
        const v = mod(R.x, n);
        return v === r;
    }
    function schnorrChallengeFinalize(ch) {
        return mod(bytesToNumber$1(ch), CURVE.n);
    }
    class SchnorrSignature {
        constructor(r, s) {
            this.r = r;
            this.s = s;
            this.assertValidity();
        }
        static fromHex(hex) {
            const bytes = ensureBytes(hex);
            if (bytes.length !== 64)
                throw new TypeError(`SchnorrSignature.fromHex: expected 64 bytes, not ${bytes.length}`);
            const r = bytesToNumber$1(bytes.subarray(0, 32));
            const s = bytesToNumber$1(bytes.subarray(32, 64));
            return new SchnorrSignature(r, s);
        }
        assertValidity() {
            const { r, s } = this;
            if (!isValidFieldElement(r) || !isWithinCurveOrder(s))
                throw new Error('Invalid signature');
        }
        toHex() {
            return numTo32bStr(this.r) + numTo32bStr(this.s);
        }
        toRawBytes() {
            return hexToBytes$1(this.toHex());
        }
    }
    function schnorrGetPublicKey(privateKey) {
        return Point.fromPrivateKey(privateKey).toRawX();
    }
    class InternalSchnorrSignature {
        constructor(message, privateKey, auxRand = utils$1.randomBytes()) {
            if (message == null)
                throw new TypeError(`sign: Expected valid message, not "${message}"`);
            this.m = ensureBytes(message);
            const { x, scalar } = this.getScalar(normalizePrivateKey(privateKey));
            this.px = x;
            this.d = scalar;
            this.rand = ensureBytes(auxRand);
            if (this.rand.length !== 32)
                throw new TypeError('sign: Expected 32 bytes of aux randomness');
        }
        getScalar(priv) {
            const point = Point.fromPrivateKey(priv);
            const scalar = point.hasEvenY() ? priv : CURVE.n - priv;
            return { point, scalar, x: point.toRawX() };
        }
        initNonce(d, t0h) {
            return numTo32b(d ^ bytesToNumber$1(t0h));
        }
        finalizeNonce(k0h) {
            const k0 = mod(bytesToNumber$1(k0h), CURVE.n);
            if (k0 === _0n)
                throw new Error('sign: Creation of signature failed. k is zero');
            const { point: R, x: rx, scalar: k } = this.getScalar(k0);
            return { R, rx, k };
        }
        finalizeSig(R, k, e, d) {
            return new SchnorrSignature(R.x, mod(k + e * d, CURVE.n)).toRawBytes();
        }
        error() {
            throw new Error('sign: Invalid signature produced');
        }
        async calc() {
            const { m, d, px, rand } = this;
            const tag = utils$1.taggedHash;
            const t = this.initNonce(d, await tag(TAGS.aux, rand));
            const { R, rx, k } = this.finalizeNonce(await tag(TAGS.nonce, t, px, m));
            const e = schnorrChallengeFinalize(await tag(TAGS.challenge, rx, px, m));
            const sig = this.finalizeSig(R, k, e, d);
            if (!(await schnorrVerify(sig, m, px)))
                this.error();
            return sig;
        }
        calcSync() {
            const { m, d, px, rand } = this;
            const tag = utils$1.taggedHashSync;
            const t = this.initNonce(d, tag(TAGS.aux, rand));
            const { R, rx, k } = this.finalizeNonce(tag(TAGS.nonce, t, px, m));
            const e = schnorrChallengeFinalize(tag(TAGS.challenge, rx, px, m));
            const sig = this.finalizeSig(R, k, e, d);
            if (!schnorrVerifySync(sig, m, px))
                this.error();
            return sig;
        }
    }
    async function schnorrSign(msg, privKey, auxRand) {
        return new InternalSchnorrSignature(msg, privKey, auxRand).calc();
    }
    function schnorrSignSync(msg, privKey, auxRand) {
        return new InternalSchnorrSignature(msg, privKey, auxRand).calcSync();
    }
    function initSchnorrVerify(signature, message, publicKey) {
        const raw = signature instanceof SchnorrSignature;
        const sig = raw ? signature : SchnorrSignature.fromHex(signature);
        if (raw)
            sig.assertValidity();
        return {
            ...sig,
            m: ensureBytes(message),
            P: normalizePublicKey(publicKey),
        };
    }
    function finalizeSchnorrVerify(r, P, s, e) {
        const R = Point.BASE.multiplyAndAddUnsafe(P, normalizePrivateKey(s), mod(-e, CURVE.n));
        if (!R || !R.hasEvenY() || R.x !== r)
            return false;
        return true;
    }
    async function schnorrVerify(signature, message, publicKey) {
        try {
            const { r, s, m, P } = initSchnorrVerify(signature, message, publicKey);
            const e = schnorrChallengeFinalize(await utils$1.taggedHash(TAGS.challenge, numTo32b(r), P.toRawX(), m));
            return finalizeSchnorrVerify(r, P, s, e);
        }
        catch (error) {
            return false;
        }
    }
    function schnorrVerifySync(signature, message, publicKey) {
        try {
            const { r, s, m, P } = initSchnorrVerify(signature, message, publicKey);
            const e = schnorrChallengeFinalize(utils$1.taggedHashSync(TAGS.challenge, numTo32b(r), P.toRawX(), m));
            return finalizeSchnorrVerify(r, P, s, e);
        }
        catch (error) {
            if (error instanceof ShaError)
                throw error;
            return false;
        }
    }
    const schnorr = {
        Signature: SchnorrSignature,
        getPublicKey: schnorrGetPublicKey,
        sign: schnorrSign,
        verify: schnorrVerify,
        signSync: schnorrSignSync,
        verifySync: schnorrVerifySync,
    };
    Point.BASE._setWindowSize(8);
    const crypto$2 = {
        node: nodeCrypto,
        web: typeof self === 'object' && 'crypto' in self ? self.crypto : undefined,
    };
    const TAGS = {
        challenge: 'BIP0340/challenge',
        aux: 'BIP0340/aux',
        nonce: 'BIP0340/nonce',
    };
    const TAGGED_HASH_PREFIXES = {};
    const utils$1 = {
        bytesToHex: bytesToHex$1,
        hexToBytes: hexToBytes$1,
        concatBytes: concatBytes$1,
        mod,
        invert,
        isValidPrivateKey(privateKey) {
            try {
                normalizePrivateKey(privateKey);
                return true;
            }
            catch (error) {
                return false;
            }
        },
        _bigintTo32Bytes: numTo32b,
        _normalizePrivateKey: normalizePrivateKey,
        hashToPrivateKey: (hash) => {
            hash = ensureBytes(hash);
            const minLen = groupLen + 8;
            if (hash.length < minLen || hash.length > 1024) {
                throw new Error(`Expected valid bytes of private key as per FIPS 186`);
            }
            const num = mod(bytesToNumber$1(hash), CURVE.n - _1n) + _1n;
            return numTo32b(num);
        },
        randomBytes: (bytesLength = 32) => {
            if (crypto$2.web) {
                return crypto$2.web.getRandomValues(new Uint8Array(bytesLength));
            }
            else if (crypto$2.node) {
                const { randomBytes } = crypto$2.node;
                return Uint8Array.from(randomBytes(bytesLength));
            }
            else {
                throw new Error("The environment doesn't have randomBytes function");
            }
        },
        randomPrivateKey: () => utils$1.hashToPrivateKey(utils$1.randomBytes(groupLen + 8)),
        precompute(windowSize = 8, point = Point.BASE) {
            const cached = point === Point.BASE ? point : new Point(point.x, point.y);
            cached._setWindowSize(windowSize);
            cached.multiply(_3n);
            return cached;
        },
        sha256: async (...messages) => {
            if (crypto$2.web) {
                const buffer = await crypto$2.web.subtle.digest('SHA-256', concatBytes$1(...messages));
                return new Uint8Array(buffer);
            }
            else if (crypto$2.node) {
                const { createHash } = crypto$2.node;
                const hash = createHash('sha256');
                messages.forEach((m) => hash.update(m));
                return Uint8Array.from(hash.digest());
            }
            else {
                throw new Error("The environment doesn't have sha256 function");
            }
        },
        hmacSha256: async (key, ...messages) => {
            if (crypto$2.web) {
                const ckey = await crypto$2.web.subtle.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
                const message = concatBytes$1(...messages);
                const buffer = await crypto$2.web.subtle.sign('HMAC', ckey, message);
                return new Uint8Array(buffer);
            }
            else if (crypto$2.node) {
                const { createHmac } = crypto$2.node;
                const hash = createHmac('sha256', key);
                messages.forEach((m) => hash.update(m));
                return Uint8Array.from(hash.digest());
            }
            else {
                throw new Error("The environment doesn't have hmac-sha256 function");
            }
        },
        sha256Sync: undefined,
        hmacSha256Sync: undefined,
        taggedHash: async (tag, ...messages) => {
            let tagP = TAGGED_HASH_PREFIXES[tag];
            if (tagP === undefined) {
                const tagH = await utils$1.sha256(Uint8Array.from(tag, (c) => c.charCodeAt(0)));
                tagP = concatBytes$1(tagH, tagH);
                TAGGED_HASH_PREFIXES[tag] = tagP;
            }
            return utils$1.sha256(tagP, ...messages);
        },
        taggedHashSync: (tag, ...messages) => {
            if (typeof _sha256Sync !== 'function')
                throw new ShaError('sha256Sync is undefined, you need to set it');
            let tagP = TAGGED_HASH_PREFIXES[tag];
            if (tagP === undefined) {
                const tagH = _sha256Sync(Uint8Array.from(tag, (c) => c.charCodeAt(0)));
                tagP = concatBytes$1(tagH, tagH);
                TAGGED_HASH_PREFIXES[tag] = tagP;
            }
            return _sha256Sync(tagP, ...messages);
        },
        _JacobianPoint: JacobianPoint,
    };
    Object.defineProperties(utils$1, {
        sha256Sync: {
            configurable: false,
            get() {
                return _sha256Sync;
            },
            set(val) {
                if (!_sha256Sync)
                    _sha256Sync = val;
            },
        },
        hmacSha256Sync: {
            configurable: false,
            get() {
                return _hmacSha256Sync;
            },
            set(val) {
                if (!_hmacSha256Sync)
                    _hmacSha256Sync = val;
            },
        },
    });

    const crypto$1 = {
        node: undefined,
        web: typeof self === 'object' && 'crypto' in self ? self.crypto : undefined,
    };

    /*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
    // Cast array to view
    const createView$1 = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    // The rotate right (circular right shift) operation for uint32
    const rotr$1 = (word, shift) => (word << (32 - shift)) | (word >>> shift);
    const isLE$1 = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
    // There is almost no big endian hardware, but js typed arrays uses platform specific endianess.
    // So, just to be sure not to corrupt anything.
    if (!isLE$1)
        throw new Error('Non little-endian hardware is not supported');
    Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));
    // Currently avoid insertion of polyfills with packers (browserify/webpack/etc)
    // But setTimeout is pretty slow, maybe worth to investigate howto do minimal polyfill here
    (() => {
        const nodeRequire = typeof module !== 'undefined' &&
            typeof module.require === 'function' &&
            module.require.bind(module);
        try {
            if (nodeRequire) {
                const { setImmediate } = nodeRequire('timers');
                return () => new Promise((resolve) => setImmediate(resolve));
            }
        }
        catch (e) { }
        return () => new Promise((resolve) => setTimeout(resolve, 0));
    })();
    function utf8ToBytes$1(str) {
        if (typeof str !== 'string') {
            throw new TypeError(`utf8ToBytes expected string, got ${typeof str}`);
        }
        return new TextEncoder().encode(str);
    }
    function toBytes$1(data) {
        if (typeof data === 'string')
            data = utf8ToBytes$1(data);
        if (!(data instanceof Uint8Array))
            throw new TypeError(`Expected input type is Uint8Array (got ${typeof data})`);
        return data;
    }
    function assertNumber$1(n) {
        if (!Number.isSafeInteger(n) || n < 0)
            throw new Error(`Wrong positive integer: ${n}`);
    }
    function assertHash(hash) {
        if (typeof hash !== 'function' || typeof hash.create !== 'function')
            throw new Error('Hash should be wrapped by utils.wrapConstructor');
        assertNumber$1(hash.outputLen);
        assertNumber$1(hash.blockLen);
    }
    // For runtime check if class implements interface
    let Hash$1 = class Hash {
        // Safe version that clones internal state
        clone() {
            return this._cloneInto();
        }
    };
    function wrapConstructor$1(hashConstructor) {
        const hashC = (message) => hashConstructor().update(toBytes$1(message)).digest();
        const tmp = hashConstructor();
        hashC.outputLen = tmp.outputLen;
        hashC.blockLen = tmp.blockLen;
        hashC.create = () => hashConstructor();
        return hashC;
    }
    /**
     * Secure PRNG
     */
    function randomBytes(bytesLength = 32) {
        if (crypto$1.web) {
            return crypto$1.web.getRandomValues(new Uint8Array(bytesLength));
        }
        else {
            throw new Error("The environment doesn't have randomBytes function");
        }
    }

    // Polyfill for Safari 14
    function setBigUint64$2(view, byteOffset, value, isLE) {
        if (typeof view.setBigUint64 === 'function')
            return view.setBigUint64(byteOffset, value, isLE);
        const _32n = BigInt(32);
        const _u32_max = BigInt(0xffffffff);
        const wh = Number((value >> _32n) & _u32_max);
        const wl = Number(value & _u32_max);
        const h = isLE ? 4 : 0;
        const l = isLE ? 0 : 4;
        view.setUint32(byteOffset + h, wh, isLE);
        view.setUint32(byteOffset + l, wl, isLE);
    }
    // Base SHA2 class (RFC 6234)
    let SHA2$2 = class SHA2 extends Hash$1 {
        constructor(blockLen, outputLen, padOffset, isLE) {
            super();
            this.blockLen = blockLen;
            this.outputLen = outputLen;
            this.padOffset = padOffset;
            this.isLE = isLE;
            this.finished = false;
            this.length = 0;
            this.pos = 0;
            this.destroyed = false;
            this.buffer = new Uint8Array(blockLen);
            this.view = createView$1(this.buffer);
        }
        update(data) {
            if (this.destroyed)
                throw new Error('instance is destroyed');
            const { view, buffer, blockLen, finished } = this;
            if (finished)
                throw new Error('digest() was already called');
            data = toBytes$1(data);
            const len = data.length;
            for (let pos = 0; pos < len;) {
                const take = Math.min(blockLen - this.pos, len - pos);
                // Fast path: we have at least one block in input, cast it to view and process
                if (take === blockLen) {
                    const dataView = createView$1(data);
                    for (; blockLen <= len - pos; pos += blockLen)
                        this.process(dataView, pos);
                    continue;
                }
                buffer.set(data.subarray(pos, pos + take), this.pos);
                this.pos += take;
                pos += take;
                if (this.pos === blockLen) {
                    this.process(view, 0);
                    this.pos = 0;
                }
            }
            this.length += data.length;
            this.roundClean();
            return this;
        }
        digestInto(out) {
            if (this.destroyed)
                throw new Error('instance is destroyed');
            if (!(out instanceof Uint8Array) || out.length < this.outputLen)
                throw new Error('_Sha2: Invalid output buffer');
            if (this.finished)
                throw new Error('digest() was already called');
            this.finished = true;
            // Padding
            // We can avoid allocation of buffer for padding completely if it
            // was previously not allocated here. But it won't change performance.
            const { buffer, view, blockLen, isLE } = this;
            let { pos } = this;
            // append the bit '1' to the message
            buffer[pos++] = 0b10000000;
            this.buffer.subarray(pos).fill(0);
            // we have less than padOffset left in buffer, so we cannot put length in current block, need process it and pad again
            if (this.padOffset > blockLen - pos) {
                this.process(view, 0);
                pos = 0;
            }
            // Pad until full block byte with zeros
            for (let i = pos; i < blockLen; i++)
                buffer[i] = 0;
            // NOTE: sha512 requires length to be 128bit integer, but length in JS will overflow before that
            // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
            // So we just write lowest 64bit of that value.
            setBigUint64$2(view, blockLen - 8, BigInt(this.length * 8), isLE);
            this.process(view, 0);
            const oview = createView$1(out);
            this.get().forEach((v, i) => oview.setUint32(4 * i, v, isLE));
        }
        digest() {
            const { buffer, outputLen } = this;
            this.digestInto(buffer);
            const res = buffer.slice(0, outputLen);
            this.destroy();
            return res;
        }
        _cloneInto(to) {
            to || (to = new this.constructor());
            to.set(...this.get());
            const { blockLen, buffer, length, finished, destroyed, pos } = this;
            to.length = length;
            to.pos = pos;
            to.finished = finished;
            to.destroyed = destroyed;
            if (length % blockLen)
                to.buffer.set(buffer);
            return to;
        }
    };

    // Choice: a ? b : c
    const Chi$2 = (a, b, c) => (a & b) ^ (~a & c);
    // Majority function, true if any two inpust is true
    const Maj$2 = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
    // Round constants:
    // first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
    // prettier-ignore
    const SHA256_K$2 = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    // Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
    // prettier-ignore
    const IV$2 = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    // Temporary buffer, not used to store anything between runs
    // Named this way because it matches specification.
    const SHA256_W$2 = new Uint32Array(64);
    let SHA256$2 = class SHA256 extends SHA2$2 {
        constructor() {
            super(64, 32, 8, false);
            // We cannot use array here since array allows indexing by variable
            // which means optimizer/compiler cannot use registers.
            this.A = IV$2[0] | 0;
            this.B = IV$2[1] | 0;
            this.C = IV$2[2] | 0;
            this.D = IV$2[3] | 0;
            this.E = IV$2[4] | 0;
            this.F = IV$2[5] | 0;
            this.G = IV$2[6] | 0;
            this.H = IV$2[7] | 0;
        }
        get() {
            const { A, B, C, D, E, F, G, H } = this;
            return [A, B, C, D, E, F, G, H];
        }
        // prettier-ignore
        set(A, B, C, D, E, F, G, H) {
            this.A = A | 0;
            this.B = B | 0;
            this.C = C | 0;
            this.D = D | 0;
            this.E = E | 0;
            this.F = F | 0;
            this.G = G | 0;
            this.H = H | 0;
        }
        process(view, offset) {
            // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
            for (let i = 0; i < 16; i++, offset += 4)
                SHA256_W$2[i] = view.getUint32(offset, false);
            for (let i = 16; i < 64; i++) {
                const W15 = SHA256_W$2[i - 15];
                const W2 = SHA256_W$2[i - 2];
                const s0 = rotr$1(W15, 7) ^ rotr$1(W15, 18) ^ (W15 >>> 3);
                const s1 = rotr$1(W2, 17) ^ rotr$1(W2, 19) ^ (W2 >>> 10);
                SHA256_W$2[i] = (s1 + SHA256_W$2[i - 7] + s0 + SHA256_W$2[i - 16]) | 0;
            }
            // Compression function main loop, 64 rounds
            let { A, B, C, D, E, F, G, H } = this;
            for (let i = 0; i < 64; i++) {
                const sigma1 = rotr$1(E, 6) ^ rotr$1(E, 11) ^ rotr$1(E, 25);
                const T1 = (H + sigma1 + Chi$2(E, F, G) + SHA256_K$2[i] + SHA256_W$2[i]) | 0;
                const sigma0 = rotr$1(A, 2) ^ rotr$1(A, 13) ^ rotr$1(A, 22);
                const T2 = (sigma0 + Maj$2(A, B, C)) | 0;
                H = G;
                G = F;
                F = E;
                E = (D + T1) | 0;
                D = C;
                C = B;
                B = A;
                A = (T1 + T2) | 0;
            }
            // Add the compressed chunk to the current hash value
            A = (A + this.A) | 0;
            B = (B + this.B) | 0;
            C = (C + this.C) | 0;
            D = (D + this.D) | 0;
            E = (E + this.E) | 0;
            F = (F + this.F) | 0;
            G = (G + this.G) | 0;
            H = (H + this.H) | 0;
            this.set(A, B, C, D, E, F, G, H);
        }
        roundClean() {
            SHA256_W$2.fill(0);
        }
        destroy() {
            this.set(0, 0, 0, 0, 0, 0, 0, 0);
            this.buffer.fill(0);
        }
    };
    /**
     * SHA2-256 hash function
     * @param message - data that would be hashed
     */
    const sha256$2 = wrapConstructor$1(() => new SHA256$2());

    /*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
    function assertNumber(n) {
        if (!Number.isSafeInteger(n))
            throw new Error(`Wrong integer: ${n}`);
    }
    function chain(...args) {
        const wrap = (a, b) => (c) => a(b(c));
        const encode = Array.from(args)
            .reverse()
            .reduce((acc, i) => (acc ? wrap(acc, i.encode) : i.encode), undefined);
        const decode = args.reduce((acc, i) => (acc ? wrap(acc, i.decode) : i.decode), undefined);
        return { encode, decode };
    }
    function alphabet(alphabet) {
        return {
            encode: (digits) => {
                if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
                    throw new Error('alphabet.encode input should be an array of numbers');
                return digits.map((i) => {
                    assertNumber(i);
                    if (i < 0 || i >= alphabet.length)
                        throw new Error(`Digit index outside alphabet: ${i} (alphabet: ${alphabet.length})`);
                    return alphabet[i];
                });
            },
            decode: (input) => {
                if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
                    throw new Error('alphabet.decode input should be array of strings');
                return input.map((letter) => {
                    if (typeof letter !== 'string')
                        throw new Error(`alphabet.decode: not string element=${letter}`);
                    const index = alphabet.indexOf(letter);
                    if (index === -1)
                        throw new Error(`Unknown letter: "${letter}". Allowed: ${alphabet}`);
                    return index;
                });
            },
        };
    }
    function join(separator = '') {
        if (typeof separator !== 'string')
            throw new Error('join separator should be string');
        return {
            encode: (from) => {
                if (!Array.isArray(from) || (from.length && typeof from[0] !== 'string'))
                    throw new Error('join.encode input should be array of strings');
                for (let i of from)
                    if (typeof i !== 'string')
                        throw new Error(`join.encode: non-string input=${i}`);
                return from.join(separator);
            },
            decode: (to) => {
                if (typeof to !== 'string')
                    throw new Error('join.decode input should be string');
                return to.split(separator);
            },
        };
    }
    function padding(bits, chr = '=') {
        assertNumber(bits);
        if (typeof chr !== 'string')
            throw new Error('padding chr should be string');
        return {
            encode(data) {
                if (!Array.isArray(data) || (data.length && typeof data[0] !== 'string'))
                    throw new Error('padding.encode input should be array of strings');
                for (let i of data)
                    if (typeof i !== 'string')
                        throw new Error(`padding.encode: non-string input=${i}`);
                while ((data.length * bits) % 8)
                    data.push(chr);
                return data;
            },
            decode(input) {
                if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
                    throw new Error('padding.encode input should be array of strings');
                for (let i of input)
                    if (typeof i !== 'string')
                        throw new Error(`padding.decode: non-string input=${i}`);
                let end = input.length;
                if ((end * bits) % 8)
                    throw new Error('Invalid padding: string should have whole number of bytes');
                for (; end > 0 && input[end - 1] === chr; end--) {
                    if (!(((end - 1) * bits) % 8))
                        throw new Error('Invalid padding: string has too much padding');
                }
                return input.slice(0, end);
            },
        };
    }
    function normalize$1(fn) {
        if (typeof fn !== 'function')
            throw new Error('normalize fn should be function');
        return { encode: (from) => from, decode: (to) => fn(to) };
    }
    function convertRadix(data, from, to) {
        if (from < 2)
            throw new Error(`convertRadix: wrong from=${from}, base cannot be less than 2`);
        if (to < 2)
            throw new Error(`convertRadix: wrong to=${to}, base cannot be less than 2`);
        if (!Array.isArray(data))
            throw new Error('convertRadix: data should be array');
        if (!data.length)
            return [];
        let pos = 0;
        const res = [];
        const digits = Array.from(data);
        digits.forEach((d) => {
            assertNumber(d);
            if (d < 0 || d >= from)
                throw new Error(`Wrong integer: ${d}`);
        });
        while (true) {
            let carry = 0;
            let done = true;
            for (let i = pos; i < digits.length; i++) {
                const digit = digits[i];
                const digitBase = from * carry + digit;
                if (!Number.isSafeInteger(digitBase) ||
                    (from * carry) / from !== carry ||
                    digitBase - digit !== from * carry) {
                    throw new Error('convertRadix: carry overflow');
                }
                carry = digitBase % to;
                digits[i] = Math.floor(digitBase / to);
                if (!Number.isSafeInteger(digits[i]) || digits[i] * to + carry !== digitBase)
                    throw new Error('convertRadix: carry overflow');
                if (!done)
                    continue;
                else if (!digits[i])
                    pos = i;
                else
                    done = false;
            }
            res.push(carry);
            if (done)
                break;
        }
        for (let i = 0; i < data.length - 1 && data[i] === 0; i++)
            res.push(0);
        return res.reverse();
    }
    const gcd = (a, b) => (!b ? a : gcd(b, a % b));
    const radix2carry = (from, to) => from + (to - gcd(from, to));
    function convertRadix2(data, from, to, padding) {
        if (!Array.isArray(data))
            throw new Error('convertRadix2: data should be array');
        if (from <= 0 || from > 32)
            throw new Error(`convertRadix2: wrong from=${from}`);
        if (to <= 0 || to > 32)
            throw new Error(`convertRadix2: wrong to=${to}`);
        if (radix2carry(from, to) > 32) {
            throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`);
        }
        let carry = 0;
        let pos = 0;
        const mask = 2 ** to - 1;
        const res = [];
        for (const n of data) {
            assertNumber(n);
            if (n >= 2 ** from)
                throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
            carry = (carry << from) | n;
            if (pos + from > 32)
                throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
            pos += from;
            for (; pos >= to; pos -= to)
                res.push(((carry >> (pos - to)) & mask) >>> 0);
            carry &= 2 ** pos - 1;
        }
        carry = (carry << (to - pos)) & mask;
        if (!padding && pos >= from)
            throw new Error('Excess padding');
        if (!padding && carry)
            throw new Error(`Non-zero padding: ${carry}`);
        if (padding && pos > 0)
            res.push(carry >>> 0);
        return res;
    }
    function radix(num) {
        assertNumber(num);
        return {
            encode: (bytes) => {
                if (!(bytes instanceof Uint8Array))
                    throw new Error('radix.encode input should be Uint8Array');
                return convertRadix(Array.from(bytes), 2 ** 8, num);
            },
            decode: (digits) => {
                if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
                    throw new Error('radix.decode input should be array of strings');
                return Uint8Array.from(convertRadix(digits, num, 2 ** 8));
            },
        };
    }
    function radix2(bits, revPadding = false) {
        assertNumber(bits);
        if (bits <= 0 || bits > 32)
            throw new Error('radix2: bits should be in (0..32]');
        if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
            throw new Error('radix2: carry overflow');
        return {
            encode: (bytes) => {
                if (!(bytes instanceof Uint8Array))
                    throw new Error('radix2.encode input should be Uint8Array');
                return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
            },
            decode: (digits) => {
                if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
                    throw new Error('radix2.decode input should be array of strings');
                return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
            },
        };
    }
    function unsafeWrapper(fn) {
        if (typeof fn !== 'function')
            throw new Error('unsafeWrapper fn should be function');
        return function (...args) {
            try {
                return fn.apply(null, args);
            }
            catch (e) { }
        };
    }
    function checksum(len, fn) {
        assertNumber(len);
        if (typeof fn !== 'function')
            throw new Error('checksum fn should be function');
        return {
            encode(data) {
                if (!(data instanceof Uint8Array))
                    throw new Error('checksum.encode: input should be Uint8Array');
                const checksum = fn(data).slice(0, len);
                const res = new Uint8Array(data.length + len);
                res.set(data);
                res.set(checksum, data.length);
                return res;
            },
            decode(data) {
                if (!(data instanceof Uint8Array))
                    throw new Error('checksum.decode: input should be Uint8Array');
                const payload = data.slice(0, -len);
                const newChecksum = fn(payload).slice(0, len);
                const oldChecksum = data.slice(-len);
                for (let i = 0; i < len; i++)
                    if (newChecksum[i] !== oldChecksum[i])
                        throw new Error('Invalid checksum');
                return payload;
            },
        };
    }
    const base16 = chain(radix2(4), alphabet('0123456789ABCDEF'), join(''));
    const base32 = chain(radix2(5), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), padding(5), join(''));
    chain(radix2(5), alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUV'), padding(5), join(''));
    chain(radix2(5), alphabet('0123456789ABCDEFGHJKMNPQRSTVWXYZ'), join(''), normalize$1((s) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')));
    const base64 = chain(radix2(6), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'), padding(6), join(''));
    const base64url = chain(radix2(6), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), padding(6), join(''));
    const genBase58 = (abc) => chain(radix(58), alphabet(abc), join(''));
    const base58 = genBase58('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    genBase58('123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ');
    genBase58('rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz');
    const XMR_BLOCK_LEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    const base58xmr = {
        encode(data) {
            let res = '';
            for (let i = 0; i < data.length; i += 8) {
                const block = data.subarray(i, i + 8);
                res += base58.encode(block).padStart(XMR_BLOCK_LEN[block.length], '1');
            }
            return res;
        },
        decode(str) {
            let res = [];
            for (let i = 0; i < str.length; i += 11) {
                const slice = str.slice(i, i + 11);
                const blockLen = XMR_BLOCK_LEN.indexOf(slice.length);
                const block = base58.decode(slice);
                for (let j = 0; j < block.length - blockLen; j++) {
                    if (block[j] !== 0)
                        throw new Error('base58xmr: wrong padding');
                }
                res = res.concat(Array.from(block.slice(block.length - blockLen)));
            }
            return Uint8Array.from(res);
        },
    };
    const base58check$1 = (sha256) => chain(checksum(4, (data) => sha256(sha256(data))), base58);
    const BECH_ALPHABET = chain(alphabet('qpzry9x8gf2tvdw0s3jn54khce6mua7l'), join(''));
    const POLYMOD_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    function bech32Polymod(pre) {
        const b = pre >> 25;
        let chk = (pre & 0x1ffffff) << 5;
        for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
            if (((b >> i) & 1) === 1)
                chk ^= POLYMOD_GENERATORS[i];
        }
        return chk;
    }
    function bechChecksum(prefix, words, encodingConst = 1) {
        const len = prefix.length;
        let chk = 1;
        for (let i = 0; i < len; i++) {
            const c = prefix.charCodeAt(i);
            if (c < 33 || c > 126)
                throw new Error(`Invalid prefix (${prefix})`);
            chk = bech32Polymod(chk) ^ (c >> 5);
        }
        chk = bech32Polymod(chk);
        for (let i = 0; i < len; i++)
            chk = bech32Polymod(chk) ^ (prefix.charCodeAt(i) & 0x1f);
        for (let v of words)
            chk = bech32Polymod(chk) ^ v;
        for (let i = 0; i < 6; i++)
            chk = bech32Polymod(chk);
        chk ^= encodingConst;
        return BECH_ALPHABET.encode(convertRadix2([chk % 2 ** 30], 30, 5, false));
    }
    function genBech32(encoding) {
        const ENCODING_CONST = encoding === 'bech32' ? 1 : 0x2bc830a3;
        const _words = radix2(5);
        const fromWords = _words.decode;
        const toWords = _words.encode;
        const fromWordsUnsafe = unsafeWrapper(fromWords);
        function encode(prefix, words, limit = 90) {
            if (typeof prefix !== 'string')
                throw new Error(`bech32.encode prefix should be string, not ${typeof prefix}`);
            if (!Array.isArray(words) || (words.length && typeof words[0] !== 'number'))
                throw new Error(`bech32.encode words should be array of numbers, not ${typeof words}`);
            const actualLength = prefix.length + 7 + words.length;
            if (limit !== false && actualLength > limit)
                throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
            prefix = prefix.toLowerCase();
            return `${prefix}1${BECH_ALPHABET.encode(words)}${bechChecksum(prefix, words, ENCODING_CONST)}`;
        }
        function decode(str, limit = 90) {
            if (typeof str !== 'string')
                throw new Error(`bech32.decode input should be string, not ${typeof str}`);
            if (str.length < 8 || (limit !== false && str.length > limit))
                throw new TypeError(`Wrong string length: ${str.length} (${str}). Expected (8..${limit})`);
            const lowered = str.toLowerCase();
            if (str !== lowered && str !== str.toUpperCase())
                throw new Error(`String must be lowercase or uppercase`);
            str = lowered;
            const sepIndex = str.lastIndexOf('1');
            if (sepIndex === 0 || sepIndex === -1)
                throw new Error(`Letter "1" must be present between prefix and data only`);
            const prefix = str.slice(0, sepIndex);
            const _words = str.slice(sepIndex + 1);
            if (_words.length < 6)
                throw new Error('Data must be at least 6 characters long');
            const words = BECH_ALPHABET.decode(_words).slice(0, -6);
            const sum = bechChecksum(prefix, words, ENCODING_CONST);
            if (!_words.endsWith(sum))
                throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
            return { prefix, words };
        }
        const decodeUnsafe = unsafeWrapper(decode);
        function decodeToBytes(str) {
            const { prefix, words } = decode(str, false);
            return { prefix, words, bytes: fromWords(words) };
        }
        return { encode, decode, decodeToBytes, decodeUnsafe, fromWords, fromWordsUnsafe, toWords };
    }
    const bech32 = genBech32('bech32');
    genBech32('bech32m');
    const utf8 = {
        encode: (data) => new TextDecoder().decode(data),
        decode: (str) => new TextEncoder().encode(str),
    };
    const hex = chain(radix2(4), alphabet('0123456789abcdef'), join(''), normalize$1((s) => {
        if (typeof s !== 'string' || s.length % 2)
            throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
        return s.toLowerCase();
    }));
    const CODERS = {
        utf8, hex, base16, base32, base64, base64url, base58, base58xmr
    };
`Invalid encoding type. Available types: ${Object.keys(CODERS).join(', ')}`;

    var english = {};

    Object.defineProperty(english, "__esModule", { value: true });
    var wordlist = english.wordlist = void 0;
    wordlist = english.wordlist = `abandon
ability
able
about
above
absent
absorb
abstract
absurd
abuse
access
accident
account
accuse
achieve
acid
acoustic
acquire
across
act
action
actor
actress
actual
adapt
add
addict
address
adjust
admit
adult
advance
advice
aerobic
affair
afford
afraid
again
age
agent
agree
ahead
aim
air
airport
aisle
alarm
album
alcohol
alert
alien
all
alley
allow
almost
alone
alpha
already
also
alter
always
amateur
amazing
among
amount
amused
analyst
anchor
ancient
anger
angle
angry
animal
ankle
announce
annual
another
answer
antenna
antique
anxiety
any
apart
apology
appear
apple
approve
april
arch
arctic
area
arena
argue
arm
armed
armor
army
around
arrange
arrest
arrive
arrow
art
artefact
artist
artwork
ask
aspect
assault
asset
assist
assume
asthma
athlete
atom
attack
attend
attitude
attract
auction
audit
august
aunt
author
auto
autumn
average
avocado
avoid
awake
aware
away
awesome
awful
awkward
axis
baby
bachelor
bacon
badge
bag
balance
balcony
ball
bamboo
banana
banner
bar
barely
bargain
barrel
base
basic
basket
battle
beach
bean
beauty
because
become
beef
before
begin
behave
behind
believe
below
belt
bench
benefit
best
betray
better
between
beyond
bicycle
bid
bike
bind
biology
bird
birth
bitter
black
blade
blame
blanket
blast
bleak
bless
blind
blood
blossom
blouse
blue
blur
blush
board
boat
body
boil
bomb
bone
bonus
book
boost
border
boring
borrow
boss
bottom
bounce
box
boy
bracket
brain
brand
brass
brave
bread
breeze
brick
bridge
brief
bright
bring
brisk
broccoli
broken
bronze
broom
brother
brown
brush
bubble
buddy
budget
buffalo
build
bulb
bulk
bullet
bundle
bunker
burden
burger
burst
bus
business
busy
butter
buyer
buzz
cabbage
cabin
cable
cactus
cage
cake
call
calm
camera
camp
can
canal
cancel
candy
cannon
canoe
canvas
canyon
capable
capital
captain
car
carbon
card
cargo
carpet
carry
cart
case
cash
casino
castle
casual
cat
catalog
catch
category
cattle
caught
cause
caution
cave
ceiling
celery
cement
census
century
cereal
certain
chair
chalk
champion
change
chaos
chapter
charge
chase
chat
cheap
check
cheese
chef
cherry
chest
chicken
chief
child
chimney
choice
choose
chronic
chuckle
chunk
churn
cigar
cinnamon
circle
citizen
city
civil
claim
clap
clarify
claw
clay
clean
clerk
clever
click
client
cliff
climb
clinic
clip
clock
clog
close
cloth
cloud
clown
club
clump
cluster
clutch
coach
coast
coconut
code
coffee
coil
coin
collect
color
column
combine
come
comfort
comic
common
company
concert
conduct
confirm
congress
connect
consider
control
convince
cook
cool
copper
copy
coral
core
corn
correct
cost
cotton
couch
country
couple
course
cousin
cover
coyote
crack
cradle
craft
cram
crane
crash
crater
crawl
crazy
cream
credit
creek
crew
cricket
crime
crisp
critic
crop
cross
crouch
crowd
crucial
cruel
cruise
crumble
crunch
crush
cry
crystal
cube
culture
cup
cupboard
curious
current
curtain
curve
cushion
custom
cute
cycle
dad
damage
damp
dance
danger
daring
dash
daughter
dawn
day
deal
debate
debris
decade
december
decide
decline
decorate
decrease
deer
defense
define
defy
degree
delay
deliver
demand
demise
denial
dentist
deny
depart
depend
deposit
depth
deputy
derive
describe
desert
design
desk
despair
destroy
detail
detect
develop
device
devote
diagram
dial
diamond
diary
dice
diesel
diet
differ
digital
dignity
dilemma
dinner
dinosaur
direct
dirt
disagree
discover
disease
dish
dismiss
disorder
display
distance
divert
divide
divorce
dizzy
doctor
document
dog
doll
dolphin
domain
donate
donkey
donor
door
dose
double
dove
draft
dragon
drama
drastic
draw
dream
dress
drift
drill
drink
drip
drive
drop
drum
dry
duck
dumb
dune
during
dust
dutch
duty
dwarf
dynamic
eager
eagle
early
earn
earth
easily
east
easy
echo
ecology
economy
edge
edit
educate
effort
egg
eight
either
elbow
elder
electric
elegant
element
elephant
elevator
elite
else
embark
embody
embrace
emerge
emotion
employ
empower
empty
enable
enact
end
endless
endorse
enemy
energy
enforce
engage
engine
enhance
enjoy
enlist
enough
enrich
enroll
ensure
enter
entire
entry
envelope
episode
equal
equip
era
erase
erode
erosion
error
erupt
escape
essay
essence
estate
eternal
ethics
evidence
evil
evoke
evolve
exact
example
excess
exchange
excite
exclude
excuse
execute
exercise
exhaust
exhibit
exile
exist
exit
exotic
expand
expect
expire
explain
expose
express
extend
extra
eye
eyebrow
fabric
face
faculty
fade
faint
faith
fall
false
fame
family
famous
fan
fancy
fantasy
farm
fashion
fat
fatal
father
fatigue
fault
favorite
feature
february
federal
fee
feed
feel
female
fence
festival
fetch
fever
few
fiber
fiction
field
figure
file
film
filter
final
find
fine
finger
finish
fire
firm
first
fiscal
fish
fit
fitness
fix
flag
flame
flash
flat
flavor
flee
flight
flip
float
flock
floor
flower
fluid
flush
fly
foam
focus
fog
foil
fold
follow
food
foot
force
forest
forget
fork
fortune
forum
forward
fossil
foster
found
fox
fragile
frame
frequent
fresh
friend
fringe
frog
front
frost
frown
frozen
fruit
fuel
fun
funny
furnace
fury
future
gadget
gain
galaxy
gallery
game
gap
garage
garbage
garden
garlic
garment
gas
gasp
gate
gather
gauge
gaze
general
genius
genre
gentle
genuine
gesture
ghost
giant
gift
giggle
ginger
giraffe
girl
give
glad
glance
glare
glass
glide
glimpse
globe
gloom
glory
glove
glow
glue
goat
goddess
gold
good
goose
gorilla
gospel
gossip
govern
gown
grab
grace
grain
grant
grape
grass
gravity
great
green
grid
grief
grit
grocery
group
grow
grunt
guard
guess
guide
guilt
guitar
gun
gym
habit
hair
half
hammer
hamster
hand
happy
harbor
hard
harsh
harvest
hat
have
hawk
hazard
head
health
heart
heavy
hedgehog
height
hello
helmet
help
hen
hero
hidden
high
hill
hint
hip
hire
history
hobby
hockey
hold
hole
holiday
hollow
home
honey
hood
hope
horn
horror
horse
hospital
host
hotel
hour
hover
hub
huge
human
humble
humor
hundred
hungry
hunt
hurdle
hurry
hurt
husband
hybrid
ice
icon
idea
identify
idle
ignore
ill
illegal
illness
image
imitate
immense
immune
impact
impose
improve
impulse
inch
include
income
increase
index
indicate
indoor
industry
infant
inflict
inform
inhale
inherit
initial
inject
injury
inmate
inner
innocent
input
inquiry
insane
insect
inside
inspire
install
intact
interest
into
invest
invite
involve
iron
island
isolate
issue
item
ivory
jacket
jaguar
jar
jazz
jealous
jeans
jelly
jewel
job
join
joke
journey
joy
judge
juice
jump
jungle
junior
junk
just
kangaroo
keen
keep
ketchup
key
kick
kid
kidney
kind
kingdom
kiss
kit
kitchen
kite
kitten
kiwi
knee
knife
knock
know
lab
label
labor
ladder
lady
lake
lamp
language
laptop
large
later
latin
laugh
laundry
lava
law
lawn
lawsuit
layer
lazy
leader
leaf
learn
leave
lecture
left
leg
legal
legend
leisure
lemon
lend
length
lens
leopard
lesson
letter
level
liar
liberty
library
license
life
lift
light
like
limb
limit
link
lion
liquid
list
little
live
lizard
load
loan
lobster
local
lock
logic
lonely
long
loop
lottery
loud
lounge
love
loyal
lucky
luggage
lumber
lunar
lunch
luxury
lyrics
machine
mad
magic
magnet
maid
mail
main
major
make
mammal
man
manage
mandate
mango
mansion
manual
maple
marble
march
margin
marine
market
marriage
mask
mass
master
match
material
math
matrix
matter
maximum
maze
meadow
mean
measure
meat
mechanic
medal
media
melody
melt
member
memory
mention
menu
mercy
merge
merit
merry
mesh
message
metal
method
middle
midnight
milk
million
mimic
mind
minimum
minor
minute
miracle
mirror
misery
miss
mistake
mix
mixed
mixture
mobile
model
modify
mom
moment
monitor
monkey
monster
month
moon
moral
more
morning
mosquito
mother
motion
motor
mountain
mouse
move
movie
much
muffin
mule
multiply
muscle
museum
mushroom
music
must
mutual
myself
mystery
myth
naive
name
napkin
narrow
nasty
nation
nature
near
neck
need
negative
neglect
neither
nephew
nerve
nest
net
network
neutral
never
news
next
nice
night
noble
noise
nominee
noodle
normal
north
nose
notable
note
nothing
notice
novel
now
nuclear
number
nurse
nut
oak
obey
object
oblige
obscure
observe
obtain
obvious
occur
ocean
october
odor
off
offer
office
often
oil
okay
old
olive
olympic
omit
once
one
onion
online
only
open
opera
opinion
oppose
option
orange
orbit
orchard
order
ordinary
organ
orient
original
orphan
ostrich
other
outdoor
outer
output
outside
oval
oven
over
own
owner
oxygen
oyster
ozone
pact
paddle
page
pair
palace
palm
panda
panel
panic
panther
paper
parade
parent
park
parrot
party
pass
patch
path
patient
patrol
pattern
pause
pave
payment
peace
peanut
pear
peasant
pelican
pen
penalty
pencil
people
pepper
perfect
permit
person
pet
phone
photo
phrase
physical
piano
picnic
picture
piece
pig
pigeon
pill
pilot
pink
pioneer
pipe
pistol
pitch
pizza
place
planet
plastic
plate
play
please
pledge
pluck
plug
plunge
poem
poet
point
polar
pole
police
pond
pony
pool
popular
portion
position
possible
post
potato
pottery
poverty
powder
power
practice
praise
predict
prefer
prepare
present
pretty
prevent
price
pride
primary
print
priority
prison
private
prize
problem
process
produce
profit
program
project
promote
proof
property
prosper
protect
proud
provide
public
pudding
pull
pulp
pulse
pumpkin
punch
pupil
puppy
purchase
purity
purpose
purse
push
put
puzzle
pyramid
quality
quantum
quarter
question
quick
quit
quiz
quote
rabbit
raccoon
race
rack
radar
radio
rail
rain
raise
rally
ramp
ranch
random
range
rapid
rare
rate
rather
raven
raw
razor
ready
real
reason
rebel
rebuild
recall
receive
recipe
record
recycle
reduce
reflect
reform
refuse
region
regret
regular
reject
relax
release
relief
rely
remain
remember
remind
remove
render
renew
rent
reopen
repair
repeat
replace
report
require
rescue
resemble
resist
resource
response
result
retire
retreat
return
reunion
reveal
review
reward
rhythm
rib
ribbon
rice
rich
ride
ridge
rifle
right
rigid
ring
riot
ripple
risk
ritual
rival
river
road
roast
robot
robust
rocket
romance
roof
rookie
room
rose
rotate
rough
round
route
royal
rubber
rude
rug
rule
run
runway
rural
sad
saddle
sadness
safe
sail
salad
salmon
salon
salt
salute
same
sample
sand
satisfy
satoshi
sauce
sausage
save
say
scale
scan
scare
scatter
scene
scheme
school
science
scissors
scorpion
scout
scrap
screen
script
scrub
sea
search
season
seat
second
secret
section
security
seed
seek
segment
select
sell
seminar
senior
sense
sentence
series
service
session
settle
setup
seven
shadow
shaft
shallow
share
shed
shell
sheriff
shield
shift
shine
ship
shiver
shock
shoe
shoot
shop
short
shoulder
shove
shrimp
shrug
shuffle
shy
sibling
sick
side
siege
sight
sign
silent
silk
silly
silver
similar
simple
since
sing
siren
sister
situate
six
size
skate
sketch
ski
skill
skin
skirt
skull
slab
slam
sleep
slender
slice
slide
slight
slim
slogan
slot
slow
slush
small
smart
smile
smoke
smooth
snack
snake
snap
sniff
snow
soap
soccer
social
sock
soda
soft
solar
soldier
solid
solution
solve
someone
song
soon
sorry
sort
soul
sound
soup
source
south
space
spare
spatial
spawn
speak
special
speed
spell
spend
sphere
spice
spider
spike
spin
spirit
split
spoil
sponsor
spoon
sport
spot
spray
spread
spring
spy
square
squeeze
squirrel
stable
stadium
staff
stage
stairs
stamp
stand
start
state
stay
steak
steel
stem
step
stereo
stick
still
sting
stock
stomach
stone
stool
story
stove
strategy
street
strike
strong
struggle
student
stuff
stumble
style
subject
submit
subway
success
such
sudden
suffer
sugar
suggest
suit
summer
sun
sunny
sunset
super
supply
supreme
sure
surface
surge
surprise
surround
survey
suspect
sustain
swallow
swamp
swap
swarm
swear
sweet
swift
swim
swing
switch
sword
symbol
symptom
syrup
system
table
tackle
tag
tail
talent
talk
tank
tape
target
task
taste
tattoo
taxi
teach
team
tell
ten
tenant
tennis
tent
term
test
text
thank
that
theme
then
theory
there
they
thing
this
thought
three
thrive
throw
thumb
thunder
ticket
tide
tiger
tilt
timber
time
tiny
tip
tired
tissue
title
toast
tobacco
today
toddler
toe
together
toilet
token
tomato
tomorrow
tone
tongue
tonight
tool
tooth
top
topic
topple
torch
tornado
tortoise
toss
total
tourist
toward
tower
town
toy
track
trade
traffic
tragic
train
transfer
trap
trash
travel
tray
treat
tree
trend
trial
tribe
trick
trigger
trim
trip
trophy
trouble
truck
true
truly
trumpet
trust
truth
try
tube
tuition
tumble
tuna
tunnel
turkey
turn
turtle
twelve
twenty
twice
twin
twist
two
type
typical
ugly
umbrella
unable
unaware
uncle
uncover
under
undo
unfair
unfold
unhappy
uniform
unique
unit
universe
unknown
unlock
until
unusual
unveil
update
upgrade
uphold
upon
upper
upset
urban
urge
usage
use
used
useful
useless
usual
utility
vacant
vacuum
vague
valid
valley
valve
van
vanish
vapor
various
vast
vault
vehicle
velvet
vendor
venture
venue
verb
verify
version
very
vessel
veteran
viable
vibrant
vicious
victory
video
view
village
vintage
violin
virtual
virus
visa
visit
visual
vital
vivid
vocal
voice
void
volcano
volume
vote
voyage
wage
wagon
wait
walk
wall
walnut
want
warfare
warm
warrior
wash
wasp
waste
water
wave
way
wealth
weapon
wear
weasel
weather
web
wedding
weekend
weird
welcome
west
wet
whale
what
wheat
wheel
when
where
whip
whisper
wide
width
wife
wild
will
win
window
wine
wing
wink
winner
winter
wire
wisdom
wise
wish
witness
wolf
woman
wonder
wood
wool
word
work
world
worry
worth
wrap
wreck
wrestle
wrist
write
wrong
yard
year
yellow
you
young
youth
zebra
zero
zone
zoo`.split('\n');

    var bip39 = {};

    var _assert = {};

    Object.defineProperty(_assert, "__esModule", { value: true });
    _assert.output = _assert.exists = _assert.hash = _assert.bytes = _assert.bool = _assert.number = void 0;
    function number$1(n) {
        if (!Number.isSafeInteger(n) || n < 0)
            throw new Error(`Wrong positive integer: ${n}`);
    }
    _assert.number = number$1;
    function bool$1(b) {
        if (typeof b !== 'boolean')
            throw new Error(`Expected boolean, not ${b}`);
    }
    _assert.bool = bool$1;
    function bytes$1(b, ...lengths) {
        if (!(b instanceof Uint8Array))
            throw new TypeError('Expected Uint8Array');
        if (lengths.length > 0 && !lengths.includes(b.length))
            throw new TypeError(`Expected Uint8Array of length ${lengths}, not of length=${b.length}`);
    }
    _assert.bytes = bytes$1;
    function hash$1(hash) {
        if (typeof hash !== 'function' || typeof hash.create !== 'function')
            throw new Error('Hash should be wrapped by utils.wrapConstructor');
        number$1(hash.outputLen);
        number$1(hash.blockLen);
    }
    _assert.hash = hash$1;
    function exists$1(instance, checkFinished = true) {
        if (instance.destroyed)
            throw new Error('Hash instance has been destroyed');
        if (checkFinished && instance.finished)
            throw new Error('Hash#digest() has already been called');
    }
    _assert.exists = exists$1;
    function output$1(out, instance) {
        bytes$1(out);
        const min = instance.outputLen;
        if (out.length < min) {
            throw new Error(`digestInto() expects output buffer of length at least ${min}`);
        }
    }
    _assert.output = output$1;
    const assert$1 = {
        number: number$1,
        bool: bool$1,
        bytes: bytes$1,
        hash: hash$1,
        exists: exists$1,
        output: output$1,
    };
    _assert.default = assert$1;

    var pbkdf2$1 = {};

    var hmac$2 = {};

    var utils = {};

    var cryptoBrowser = {};

    Object.defineProperty(cryptoBrowser, "__esModule", { value: true });
    cryptoBrowser.crypto = void 0;
    cryptoBrowser.crypto = {
        node: undefined,
        web: typeof self === 'object' && 'crypto' in self ? self.crypto : undefined,
    };

    (function (exports) {
    	/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
    	Object.defineProperty(exports, "__esModule", { value: true });
    	exports.randomBytes = exports.wrapConstructorWithOpts = exports.wrapConstructor = exports.checkOpts = exports.Hash = exports.concatBytes = exports.toBytes = exports.utf8ToBytes = exports.asyncLoop = exports.nextTick = exports.hexToBytes = exports.bytesToHex = exports.isLE = exports.rotr = exports.createView = exports.u32 = exports.u8 = void 0;
    	// The import here is via the package name. This is to ensure
    	// that exports mapping/resolution does fall into place.
    	const crypto_1 = cryptoBrowser;
    	// Cast array to different type
    	const u8 = (arr) => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    	exports.u8 = u8;
    	const u32 = (arr) => new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
    	exports.u32 = u32;
    	// Cast array to view
    	const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    	exports.createView = createView;
    	// The rotate right (circular right shift) operation for uint32
    	const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);
    	exports.rotr = rotr;
    	exports.isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
    	// There is almost no big endian hardware, but js typed arrays uses platform specific endianness.
    	// So, just to be sure not to corrupt anything.
    	if (!exports.isLE)
    	    throw new Error('Non little-endian hardware is not supported');
    	const hexes = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));
    	/**
    	 * @example bytesToHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
    	 */
    	function bytesToHex(uint8a) {
    	    // pre-caching improves the speed 6x
    	    if (!(uint8a instanceof Uint8Array))
    	        throw new Error('Uint8Array expected');
    	    let hex = '';
    	    for (let i = 0; i < uint8a.length; i++) {
    	        hex += hexes[uint8a[i]];
    	    }
    	    return hex;
    	}
    	exports.bytesToHex = bytesToHex;
    	/**
    	 * @example hexToBytes('deadbeef')
    	 */
    	function hexToBytes(hex) {
    	    if (typeof hex !== 'string') {
    	        throw new TypeError('hexToBytes: expected string, got ' + typeof hex);
    	    }
    	    if (hex.length % 2)
    	        throw new Error('hexToBytes: received invalid unpadded hex');
    	    const array = new Uint8Array(hex.length / 2);
    	    for (let i = 0; i < array.length; i++) {
    	        const j = i * 2;
    	        const hexByte = hex.slice(j, j + 2);
    	        const byte = Number.parseInt(hexByte, 16);
    	        if (Number.isNaN(byte) || byte < 0)
    	            throw new Error('Invalid byte sequence');
    	        array[i] = byte;
    	    }
    	    return array;
    	}
    	exports.hexToBytes = hexToBytes;
    	// There is no setImmediate in browser and setTimeout is slow. However, call to async function will return Promise
    	// which will be fullfiled only on next scheduler queue processing step and this is exactly what we need.
    	const nextTick = async () => { };
    	exports.nextTick = nextTick;
    	// Returns control to thread each 'tick' ms to avoid blocking
    	async function asyncLoop(iters, tick, cb) {
    	    let ts = Date.now();
    	    for (let i = 0; i < iters; i++) {
    	        cb(i);
    	        // Date.now() is not monotonic, so in case if clock goes backwards we return return control too
    	        const diff = Date.now() - ts;
    	        if (diff >= 0 && diff < tick)
    	            continue;
    	        await (0, exports.nextTick)();
    	        ts += diff;
    	    }
    	}
    	exports.asyncLoop = asyncLoop;
    	function utf8ToBytes(str) {
    	    if (typeof str !== 'string') {
    	        throw new TypeError(`utf8ToBytes expected string, got ${typeof str}`);
    	    }
    	    return new TextEncoder().encode(str);
    	}
    	exports.utf8ToBytes = utf8ToBytes;
    	function toBytes(data) {
    	    if (typeof data === 'string')
    	        data = utf8ToBytes(data);
    	    if (!(data instanceof Uint8Array))
    	        throw new TypeError(`Expected input type is Uint8Array (got ${typeof data})`);
    	    return data;
    	}
    	exports.toBytes = toBytes;
    	/**
    	 * Concats Uint8Array-s into one; like `Buffer.concat([buf1, buf2])`
    	 * @example concatBytes(buf1, buf2)
    	 */
    	function concatBytes(...arrays) {
    	    if (!arrays.every((a) => a instanceof Uint8Array))
    	        throw new Error('Uint8Array list expected');
    	    if (arrays.length === 1)
    	        return arrays[0];
    	    const length = arrays.reduce((a, arr) => a + arr.length, 0);
    	    const result = new Uint8Array(length);
    	    for (let i = 0, pad = 0; i < arrays.length; i++) {
    	        const arr = arrays[i];
    	        result.set(arr, pad);
    	        pad += arr.length;
    	    }
    	    return result;
    	}
    	exports.concatBytes = concatBytes;
    	// For runtime check if class implements interface
    	class Hash {
    	    // Safe version that clones internal state
    	    clone() {
    	        return this._cloneInto();
    	    }
    	}
    	exports.Hash = Hash;
    	// Check if object doens't have custom constructor (like Uint8Array/Array)
    	const isPlainObject = (obj) => Object.prototype.toString.call(obj) === '[object Object]' && obj.constructor === Object;
    	function checkOpts(defaults, opts) {
    	    if (opts !== undefined && (typeof opts !== 'object' || !isPlainObject(opts)))
    	        throw new TypeError('Options should be object or undefined');
    	    const merged = Object.assign(defaults, opts);
    	    return merged;
    	}
    	exports.checkOpts = checkOpts;
    	function wrapConstructor(hashConstructor) {
    	    const hashC = (message) => hashConstructor().update(toBytes(message)).digest();
    	    const tmp = hashConstructor();
    	    hashC.outputLen = tmp.outputLen;
    	    hashC.blockLen = tmp.blockLen;
    	    hashC.create = () => hashConstructor();
    	    return hashC;
    	}
    	exports.wrapConstructor = wrapConstructor;
    	function wrapConstructorWithOpts(hashCons) {
    	    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    	    const tmp = hashCons({});
    	    hashC.outputLen = tmp.outputLen;
    	    hashC.blockLen = tmp.blockLen;
    	    hashC.create = (opts) => hashCons(opts);
    	    return hashC;
    	}
    	exports.wrapConstructorWithOpts = wrapConstructorWithOpts;
    	/**
    	 * Secure PRNG
    	 */
    	function randomBytes(bytesLength = 32) {
    	    if (crypto_1.crypto.web) {
    	        return crypto_1.crypto.web.getRandomValues(new Uint8Array(bytesLength));
    	    }
    	    else if (crypto_1.crypto.node) {
    	        return new Uint8Array(crypto_1.crypto.node.randomBytes(bytesLength).buffer);
    	    }
    	    else {
    	        throw new Error("The environment doesn't have randomBytes function");
    	    }
    	}
    	exports.randomBytes = randomBytes;
    	
    } (utils));

    (function (exports) {
    	Object.defineProperty(exports, "__esModule", { value: true });
    	exports.hmac = void 0;
    	const _assert_js_1 = _assert;
    	const utils_js_1 = utils;
    	// HMAC (RFC 2104)
    	class HMAC extends utils_js_1.Hash {
    	    constructor(hash, _key) {
    	        super();
    	        this.finished = false;
    	        this.destroyed = false;
    	        _assert_js_1.default.hash(hash);
    	        const key = (0, utils_js_1.toBytes)(_key);
    	        this.iHash = hash.create();
    	        if (typeof this.iHash.update !== 'function')
    	            throw new TypeError('Expected instance of class which extends utils.Hash');
    	        this.blockLen = this.iHash.blockLen;
    	        this.outputLen = this.iHash.outputLen;
    	        const blockLen = this.blockLen;
    	        const pad = new Uint8Array(blockLen);
    	        // blockLen can be bigger than outputLen
    	        pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    	        for (let i = 0; i < pad.length; i++)
    	            pad[i] ^= 0x36;
    	        this.iHash.update(pad);
    	        // By doing update (processing of first block) of outer hash here we can re-use it between multiple calls via clone
    	        this.oHash = hash.create();
    	        // Undo internal XOR && apply outer XOR
    	        for (let i = 0; i < pad.length; i++)
    	            pad[i] ^= 0x36 ^ 0x5c;
    	        this.oHash.update(pad);
    	        pad.fill(0);
    	    }
    	    update(buf) {
    	        _assert_js_1.default.exists(this);
    	        this.iHash.update(buf);
    	        return this;
    	    }
    	    digestInto(out) {
    	        _assert_js_1.default.exists(this);
    	        _assert_js_1.default.bytes(out, this.outputLen);
    	        this.finished = true;
    	        this.iHash.digestInto(out);
    	        this.oHash.update(out);
    	        this.oHash.digestInto(out);
    	        this.destroy();
    	    }
    	    digest() {
    	        const out = new Uint8Array(this.oHash.outputLen);
    	        this.digestInto(out);
    	        return out;
    	    }
    	    _cloneInto(to) {
    	        // Create new instance without calling constructor since key already in state and we don't know it.
    	        to || (to = Object.create(Object.getPrototypeOf(this), {}));
    	        const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    	        to = to;
    	        to.finished = finished;
    	        to.destroyed = destroyed;
    	        to.blockLen = blockLen;
    	        to.outputLen = outputLen;
    	        to.oHash = oHash._cloneInto(to.oHash);
    	        to.iHash = iHash._cloneInto(to.iHash);
    	        return to;
    	    }
    	    destroy() {
    	        this.destroyed = true;
    	        this.oHash.destroy();
    	        this.iHash.destroy();
    	    }
    	}
    	/**
    	 * HMAC: RFC2104 message authentication code.
    	 * @param hash - function that would be used e.g. sha256
    	 * @param key - message key
    	 * @param message - message data
    	 */
    	const hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
    	exports.hmac = hmac;
    	exports.hmac.create = (hash, key) => new HMAC(hash, key);
    	
    } (hmac$2));

    Object.defineProperty(pbkdf2$1, "__esModule", { value: true });
    pbkdf2$1.pbkdf2Async = pbkdf2$1.pbkdf2 = void 0;
    const _assert_js_1$1 = _assert;
    const hmac_js_1 = hmac$2;
    const utils_js_1$3 = utils;
    // Common prologue and epilogue for sync/async functions
    function pbkdf2Init(hash, _password, _salt, _opts) {
        _assert_js_1$1.default.hash(hash);
        const opts = (0, utils_js_1$3.checkOpts)({ dkLen: 32, asyncTick: 10 }, _opts);
        const { c, dkLen, asyncTick } = opts;
        _assert_js_1$1.default.number(c);
        _assert_js_1$1.default.number(dkLen);
        _assert_js_1$1.default.number(asyncTick);
        if (c < 1)
            throw new Error('PBKDF2: iterations (c) should be >= 1');
        const password = (0, utils_js_1$3.toBytes)(_password);
        const salt = (0, utils_js_1$3.toBytes)(_salt);
        // DK = PBKDF2(PRF, Password, Salt, c, dkLen);
        const DK = new Uint8Array(dkLen);
        // U1 = PRF(Password, Salt + INT_32_BE(i))
        const PRF = hmac_js_1.hmac.create(hash, password);
        const PRFSalt = PRF._cloneInto().update(salt);
        return { c, dkLen, asyncTick, DK, PRF, PRFSalt };
    }
    function pbkdf2Output(PRF, PRFSalt, DK, prfW, u) {
        PRF.destroy();
        PRFSalt.destroy();
        if (prfW)
            prfW.destroy();
        u.fill(0);
        return DK;
    }
    /**
     * PBKDF2-HMAC: RFC 2898 key derivation function
     * @param hash - hash function that would be used e.g. sha256
     * @param password - password from which a derived key is generated
     * @param salt - cryptographic salt
     * @param opts - {c, dkLen} where c is work factor and dkLen is output message size
     */
    function pbkdf2(hash, password, salt, opts) {
        const { c, dkLen, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);
        let prfW; // Working copy
        const arr = new Uint8Array(4);
        const view = (0, utils_js_1$3.createView)(arr);
        const u = new Uint8Array(PRF.outputLen);
        // DK = T1 + T2 + ⋯ + Tdklen/hlen
        for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
            // Ti = F(Password, Salt, c, i)
            const Ti = DK.subarray(pos, pos + PRF.outputLen);
            view.setInt32(0, ti, false);
            // F(Password, Salt, c, i) = U1 ^ U2 ^ ⋯ ^ Uc
            // U1 = PRF(Password, Salt + INT_32_BE(i))
            (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
            Ti.set(u.subarray(0, Ti.length));
            for (let ui = 1; ui < c; ui++) {
                // Uc = PRF(Password, Uc−1)
                PRF._cloneInto(prfW).update(u).digestInto(u);
                for (let i = 0; i < Ti.length; i++)
                    Ti[i] ^= u[i];
            }
        }
        return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
    }
    pbkdf2$1.pbkdf2 = pbkdf2;
    async function pbkdf2Async(hash, password, salt, opts) {
        const { c, dkLen, asyncTick, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);
        let prfW; // Working copy
        const arr = new Uint8Array(4);
        const view = (0, utils_js_1$3.createView)(arr);
        const u = new Uint8Array(PRF.outputLen);
        // DK = T1 + T2 + ⋯ + Tdklen/hlen
        for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
            // Ti = F(Password, Salt, c, i)
            const Ti = DK.subarray(pos, pos + PRF.outputLen);
            view.setInt32(0, ti, false);
            // F(Password, Salt, c, i) = U1 ^ U2 ^ ⋯ ^ Uc
            // U1 = PRF(Password, Salt + INT_32_BE(i))
            (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
            Ti.set(u.subarray(0, Ti.length));
            await (0, utils_js_1$3.asyncLoop)(c - 1, asyncTick, (i) => {
                // Uc = PRF(Password, Uc−1)
                PRF._cloneInto(prfW).update(u).digestInto(u);
                for (let i = 0; i < Ti.length; i++)
                    Ti[i] ^= u[i];
            });
        }
        return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
    }
    pbkdf2$1.pbkdf2Async = pbkdf2Async;

    var sha256$1 = {};

    var _sha2 = {};

    Object.defineProperty(_sha2, "__esModule", { value: true });
    _sha2.SHA2 = void 0;
    const _assert_js_1 = _assert;
    const utils_js_1$2 = utils;
    // Polyfill for Safari 14
    function setBigUint64$1(view, byteOffset, value, isLE) {
        if (typeof view.setBigUint64 === 'function')
            return view.setBigUint64(byteOffset, value, isLE);
        const _32n = BigInt(32);
        const _u32_max = BigInt(0xffffffff);
        const wh = Number((value >> _32n) & _u32_max);
        const wl = Number(value & _u32_max);
        const h = isLE ? 4 : 0;
        const l = isLE ? 0 : 4;
        view.setUint32(byteOffset + h, wh, isLE);
        view.setUint32(byteOffset + l, wl, isLE);
    }
    // Base SHA2 class (RFC 6234)
    let SHA2$1 = class SHA2 extends utils_js_1$2.Hash {
        constructor(blockLen, outputLen, padOffset, isLE) {
            super();
            this.blockLen = blockLen;
            this.outputLen = outputLen;
            this.padOffset = padOffset;
            this.isLE = isLE;
            this.finished = false;
            this.length = 0;
            this.pos = 0;
            this.destroyed = false;
            this.buffer = new Uint8Array(blockLen);
            this.view = (0, utils_js_1$2.createView)(this.buffer);
        }
        update(data) {
            _assert_js_1.default.exists(this);
            const { view, buffer, blockLen } = this;
            data = (0, utils_js_1$2.toBytes)(data);
            const len = data.length;
            for (let pos = 0; pos < len;) {
                const take = Math.min(blockLen - this.pos, len - pos);
                // Fast path: we have at least one block in input, cast it to view and process
                if (take === blockLen) {
                    const dataView = (0, utils_js_1$2.createView)(data);
                    for (; blockLen <= len - pos; pos += blockLen)
                        this.process(dataView, pos);
                    continue;
                }
                buffer.set(data.subarray(pos, pos + take), this.pos);
                this.pos += take;
                pos += take;
                if (this.pos === blockLen) {
                    this.process(view, 0);
                    this.pos = 0;
                }
            }
            this.length += data.length;
            this.roundClean();
            return this;
        }
        digestInto(out) {
            _assert_js_1.default.exists(this);
            _assert_js_1.default.output(out, this);
            this.finished = true;
            // Padding
            // We can avoid allocation of buffer for padding completely if it
            // was previously not allocated here. But it won't change performance.
            const { buffer, view, blockLen, isLE } = this;
            let { pos } = this;
            // append the bit '1' to the message
            buffer[pos++] = 0b10000000;
            this.buffer.subarray(pos).fill(0);
            // we have less than padOffset left in buffer, so we cannot put length in current block, need process it and pad again
            if (this.padOffset > blockLen - pos) {
                this.process(view, 0);
                pos = 0;
            }
            // Pad until full block byte with zeros
            for (let i = pos; i < blockLen; i++)
                buffer[i] = 0;
            // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
            // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
            // So we just write lowest 64 bits of that value.
            setBigUint64$1(view, blockLen - 8, BigInt(this.length * 8), isLE);
            this.process(view, 0);
            const oview = (0, utils_js_1$2.createView)(out);
            const len = this.outputLen;
            // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
            if (len % 4)
                throw new Error('_sha2: outputLen should be aligned to 32bit');
            const outLen = len / 4;
            const state = this.get();
            if (outLen > state.length)
                throw new Error('_sha2: outputLen bigger than state');
            for (let i = 0; i < outLen; i++)
                oview.setUint32(4 * i, state[i], isLE);
        }
        digest() {
            const { buffer, outputLen } = this;
            this.digestInto(buffer);
            const res = buffer.slice(0, outputLen);
            this.destroy();
            return res;
        }
        _cloneInto(to) {
            to || (to = new this.constructor());
            to.set(...this.get());
            const { blockLen, buffer, length, finished, destroyed, pos } = this;
            to.length = length;
            to.pos = pos;
            to.finished = finished;
            to.destroyed = destroyed;
            if (length % blockLen)
                to.buffer.set(buffer);
            return to;
        }
    };
    _sha2.SHA2 = SHA2$1;

    Object.defineProperty(sha256$1, "__esModule", { value: true });
    sha256$1.sha224 = sha256$1.sha256 = void 0;
    const _sha2_js_1$1 = _sha2;
    const utils_js_1$1 = utils;
    // Choice: a ? b : c
    const Chi$1 = (a, b, c) => (a & b) ^ (~a & c);
    // Majority function, true if any two inpust is true
    const Maj$1 = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
    // Round constants:
    // first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
    // prettier-ignore
    const SHA256_K$1 = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    // Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
    // prettier-ignore
    const IV$1 = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    // Temporary buffer, not used to store anything between runs
    // Named this way because it matches specification.
    const SHA256_W$1 = new Uint32Array(64);
    let SHA256$1 = class SHA256 extends _sha2_js_1$1.SHA2 {
        constructor() {
            super(64, 32, 8, false);
            // We cannot use array here since array allows indexing by variable
            // which means optimizer/compiler cannot use registers.
            this.A = IV$1[0] | 0;
            this.B = IV$1[1] | 0;
            this.C = IV$1[2] | 0;
            this.D = IV$1[3] | 0;
            this.E = IV$1[4] | 0;
            this.F = IV$1[5] | 0;
            this.G = IV$1[6] | 0;
            this.H = IV$1[7] | 0;
        }
        get() {
            const { A, B, C, D, E, F, G, H } = this;
            return [A, B, C, D, E, F, G, H];
        }
        // prettier-ignore
        set(A, B, C, D, E, F, G, H) {
            this.A = A | 0;
            this.B = B | 0;
            this.C = C | 0;
            this.D = D | 0;
            this.E = E | 0;
            this.F = F | 0;
            this.G = G | 0;
            this.H = H | 0;
        }
        process(view, offset) {
            // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
            for (let i = 0; i < 16; i++, offset += 4)
                SHA256_W$1[i] = view.getUint32(offset, false);
            for (let i = 16; i < 64; i++) {
                const W15 = SHA256_W$1[i - 15];
                const W2 = SHA256_W$1[i - 2];
                const s0 = (0, utils_js_1$1.rotr)(W15, 7) ^ (0, utils_js_1$1.rotr)(W15, 18) ^ (W15 >>> 3);
                const s1 = (0, utils_js_1$1.rotr)(W2, 17) ^ (0, utils_js_1$1.rotr)(W2, 19) ^ (W2 >>> 10);
                SHA256_W$1[i] = (s1 + SHA256_W$1[i - 7] + s0 + SHA256_W$1[i - 16]) | 0;
            }
            // Compression function main loop, 64 rounds
            let { A, B, C, D, E, F, G, H } = this;
            for (let i = 0; i < 64; i++) {
                const sigma1 = (0, utils_js_1$1.rotr)(E, 6) ^ (0, utils_js_1$1.rotr)(E, 11) ^ (0, utils_js_1$1.rotr)(E, 25);
                const T1 = (H + sigma1 + Chi$1(E, F, G) + SHA256_K$1[i] + SHA256_W$1[i]) | 0;
                const sigma0 = (0, utils_js_1$1.rotr)(A, 2) ^ (0, utils_js_1$1.rotr)(A, 13) ^ (0, utils_js_1$1.rotr)(A, 22);
                const T2 = (sigma0 + Maj$1(A, B, C)) | 0;
                H = G;
                G = F;
                F = E;
                E = (D + T1) | 0;
                D = C;
                C = B;
                B = A;
                A = (T1 + T2) | 0;
            }
            // Add the compressed chunk to the current hash value
            A = (A + this.A) | 0;
            B = (B + this.B) | 0;
            C = (C + this.C) | 0;
            D = (D + this.D) | 0;
            E = (E + this.E) | 0;
            F = (F + this.F) | 0;
            G = (G + this.G) | 0;
            H = (H + this.H) | 0;
            this.set(A, B, C, D, E, F, G, H);
        }
        roundClean() {
            SHA256_W$1.fill(0);
        }
        destroy() {
            this.set(0, 0, 0, 0, 0, 0, 0, 0);
            this.buffer.fill(0);
        }
    };
    // Constants from https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
    let SHA224$1 = class SHA224 extends SHA256$1 {
        constructor() {
            super();
            this.A = 0xc1059ed8 | 0;
            this.B = 0x367cd507 | 0;
            this.C = 0x3070dd17 | 0;
            this.D = 0xf70e5939 | 0;
            this.E = 0xffc00b31 | 0;
            this.F = 0x68581511 | 0;
            this.G = 0x64f98fa7 | 0;
            this.H = 0xbefa4fa4 | 0;
            this.outputLen = 28;
        }
    };
    /**
     * SHA2-256 hash function
     * @param message - data that would be hashed
     */
    sha256$1.sha256 = (0, utils_js_1$1.wrapConstructor)(() => new SHA256$1());
    sha256$1.sha224 = (0, utils_js_1$1.wrapConstructor)(() => new SHA224$1());

    var sha512$1 = {};

    var _u64 = {};

    (function (exports) {
    	Object.defineProperty(exports, "__esModule", { value: true });
    	exports.add = exports.toBig = exports.split = exports.fromBig = void 0;
    	const U32_MASK64 = BigInt(2 ** 32 - 1);
    	const _32n = BigInt(32);
    	// We are not using BigUint64Array, because they are extremely slow as per 2022
    	function fromBig(n, le = false) {
    	    if (le)
    	        return { h: Number(n & U32_MASK64), l: Number((n >> _32n) & U32_MASK64) };
    	    return { h: Number((n >> _32n) & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
    	}
    	exports.fromBig = fromBig;
    	function split(lst, le = false) {
    	    let Ah = new Uint32Array(lst.length);
    	    let Al = new Uint32Array(lst.length);
    	    for (let i = 0; i < lst.length; i++) {
    	        const { h, l } = fromBig(lst[i], le);
    	        [Ah[i], Al[i]] = [h, l];
    	    }
    	    return [Ah, Al];
    	}
    	exports.split = split;
    	const toBig = (h, l) => (BigInt(h >>> 0) << _32n) | BigInt(l >>> 0);
    	exports.toBig = toBig;
    	// for Shift in [0, 32)
    	const shrSH = (h, l, s) => h >>> s;
    	const shrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
    	// Right rotate for Shift in [1, 32)
    	const rotrSH = (h, l, s) => (h >>> s) | (l << (32 - s));
    	const rotrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
    	// Right rotate for Shift in (32, 64), NOTE: 32 is special case.
    	const rotrBH = (h, l, s) => (h << (64 - s)) | (l >>> (s - 32));
    	const rotrBL = (h, l, s) => (h >>> (s - 32)) | (l << (64 - s));
    	// Right rotate for shift===32 (just swaps l&h)
    	const rotr32H = (h, l) => l;
    	const rotr32L = (h, l) => h;
    	// Left rotate for Shift in [1, 32)
    	const rotlSH = (h, l, s) => (h << s) | (l >>> (32 - s));
    	const rotlSL = (h, l, s) => (l << s) | (h >>> (32 - s));
    	// Left rotate for Shift in (32, 64), NOTE: 32 is special case.
    	const rotlBH = (h, l, s) => (l << (s - 32)) | (h >>> (64 - s));
    	const rotlBL = (h, l, s) => (h << (s - 32)) | (l >>> (64 - s));
    	// JS uses 32-bit signed integers for bitwise operations which means we cannot
    	// simple take carry out of low bit sum by shift, we need to use division.
    	// Removing "export" has 5% perf penalty -_-
    	function add(Ah, Al, Bh, Bl) {
    	    const l = (Al >>> 0) + (Bl >>> 0);
    	    return { h: (Ah + Bh + ((l / 2 ** 32) | 0)) | 0, l: l | 0 };
    	}
    	exports.add = add;
    	// Addition with more than 2 elements
    	const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    	const add3H = (low, Ah, Bh, Ch) => (Ah + Bh + Ch + ((low / 2 ** 32) | 0)) | 0;
    	const add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    	const add4H = (low, Ah, Bh, Ch, Dh) => (Ah + Bh + Ch + Dh + ((low / 2 ** 32) | 0)) | 0;
    	const add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    	const add5H = (low, Ah, Bh, Ch, Dh, Eh) => (Ah + Bh + Ch + Dh + Eh + ((low / 2 ** 32) | 0)) | 0;
    	// prettier-ignore
    	const u64 = {
    	    fromBig, split, toBig: exports.toBig,
    	    shrSH, shrSL,
    	    rotrSH, rotrSL, rotrBH, rotrBL,
    	    rotr32H, rotr32L,
    	    rotlSH, rotlSL, rotlBH, rotlBL,
    	    add, add3L, add3H, add4L, add4H, add5H, add5L,
    	};
    	exports.default = u64;
    	
    } (_u64));

    Object.defineProperty(sha512$1, "__esModule", { value: true });
    sha512$1.sha384 = sha512$1.sha512_256 = sha512$1.sha512_224 = sha512$1.sha512 = sha512$1.SHA512 = void 0;
    const _sha2_js_1 = _sha2;
    const _u64_js_1 = _u64;
    const utils_js_1 = utils;
    // Round contants (first 32 bits of the fractional parts of the cube roots of the first 80 primes 2..409):
    // prettier-ignore
    const [SHA512_Kh$1, SHA512_Kl$1] = _u64_js_1.default.split([
        '0x428a2f98d728ae22', '0x7137449123ef65cd', '0xb5c0fbcfec4d3b2f', '0xe9b5dba58189dbbc',
        '0x3956c25bf348b538', '0x59f111f1b605d019', '0x923f82a4af194f9b', '0xab1c5ed5da6d8118',
        '0xd807aa98a3030242', '0x12835b0145706fbe', '0x243185be4ee4b28c', '0x550c7dc3d5ffb4e2',
        '0x72be5d74f27b896f', '0x80deb1fe3b1696b1', '0x9bdc06a725c71235', '0xc19bf174cf692694',
        '0xe49b69c19ef14ad2', '0xefbe4786384f25e3', '0x0fc19dc68b8cd5b5', '0x240ca1cc77ac9c65',
        '0x2de92c6f592b0275', '0x4a7484aa6ea6e483', '0x5cb0a9dcbd41fbd4', '0x76f988da831153b5',
        '0x983e5152ee66dfab', '0xa831c66d2db43210', '0xb00327c898fb213f', '0xbf597fc7beef0ee4',
        '0xc6e00bf33da88fc2', '0xd5a79147930aa725', '0x06ca6351e003826f', '0x142929670a0e6e70',
        '0x27b70a8546d22ffc', '0x2e1b21385c26c926', '0x4d2c6dfc5ac42aed', '0x53380d139d95b3df',
        '0x650a73548baf63de', '0x766a0abb3c77b2a8', '0x81c2c92e47edaee6', '0x92722c851482353b',
        '0xa2bfe8a14cf10364', '0xa81a664bbc423001', '0xc24b8b70d0f89791', '0xc76c51a30654be30',
        '0xd192e819d6ef5218', '0xd69906245565a910', '0xf40e35855771202a', '0x106aa07032bbd1b8',
        '0x19a4c116b8d2d0c8', '0x1e376c085141ab53', '0x2748774cdf8eeb99', '0x34b0bcb5e19b48a8',
        '0x391c0cb3c5c95a63', '0x4ed8aa4ae3418acb', '0x5b9cca4f7763e373', '0x682e6ff3d6b2b8a3',
        '0x748f82ee5defb2fc', '0x78a5636f43172f60', '0x84c87814a1f0ab72', '0x8cc702081a6439ec',
        '0x90befffa23631e28', '0xa4506cebde82bde9', '0xbef9a3f7b2c67915', '0xc67178f2e372532b',
        '0xca273eceea26619c', '0xd186b8c721c0c207', '0xeada7dd6cde0eb1e', '0xf57d4f7fee6ed178',
        '0x06f067aa72176fba', '0x0a637dc5a2c898a6', '0x113f9804bef90dae', '0x1b710b35131c471b',
        '0x28db77f523047d84', '0x32caab7b40c72493', '0x3c9ebe0a15c9bebc', '0x431d67c49c100d4c',
        '0x4cc5d4becb3e42b6', '0x597f299cfc657e2a', '0x5fcb6fab3ad6faec', '0x6c44198c4a475817'
    ].map(n => BigInt(n)));
    // Temporary buffer, not used to store anything between runs
    const SHA512_W_H$1 = new Uint32Array(80);
    const SHA512_W_L$1 = new Uint32Array(80);
    let SHA512$1 = class SHA512 extends _sha2_js_1.SHA2 {
        constructor() {
            super(128, 64, 16, false);
            // We cannot use array here since array allows indexing by variable which means optimizer/compiler cannot use registers.
            // Also looks cleaner and easier to verify with spec.
            // Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x6a09e667 | 0;
            this.Al = 0xf3bcc908 | 0;
            this.Bh = 0xbb67ae85 | 0;
            this.Bl = 0x84caa73b | 0;
            this.Ch = 0x3c6ef372 | 0;
            this.Cl = 0xfe94f82b | 0;
            this.Dh = 0xa54ff53a | 0;
            this.Dl = 0x5f1d36f1 | 0;
            this.Eh = 0x510e527f | 0;
            this.El = 0xade682d1 | 0;
            this.Fh = 0x9b05688c | 0;
            this.Fl = 0x2b3e6c1f | 0;
            this.Gh = 0x1f83d9ab | 0;
            this.Gl = 0xfb41bd6b | 0;
            this.Hh = 0x5be0cd19 | 0;
            this.Hl = 0x137e2179 | 0;
        }
        // prettier-ignore
        get() {
            const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
            return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
        }
        // prettier-ignore
        set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
            this.Ah = Ah | 0;
            this.Al = Al | 0;
            this.Bh = Bh | 0;
            this.Bl = Bl | 0;
            this.Ch = Ch | 0;
            this.Cl = Cl | 0;
            this.Dh = Dh | 0;
            this.Dl = Dl | 0;
            this.Eh = Eh | 0;
            this.El = El | 0;
            this.Fh = Fh | 0;
            this.Fl = Fl | 0;
            this.Gh = Gh | 0;
            this.Gl = Gl | 0;
            this.Hh = Hh | 0;
            this.Hl = Hl | 0;
        }
        process(view, offset) {
            // Extend the first 16 words into the remaining 64 words w[16..79] of the message schedule array
            for (let i = 0; i < 16; i++, offset += 4) {
                SHA512_W_H$1[i] = view.getUint32(offset);
                SHA512_W_L$1[i] = view.getUint32((offset += 4));
            }
            for (let i = 16; i < 80; i++) {
                // s0 := (w[i-15] rightrotate 1) xor (w[i-15] rightrotate 8) xor (w[i-15] rightshift 7)
                const W15h = SHA512_W_H$1[i - 15] | 0;
                const W15l = SHA512_W_L$1[i - 15] | 0;
                const s0h = _u64_js_1.default.rotrSH(W15h, W15l, 1) ^ _u64_js_1.default.rotrSH(W15h, W15l, 8) ^ _u64_js_1.default.shrSH(W15h, W15l, 7);
                const s0l = _u64_js_1.default.rotrSL(W15h, W15l, 1) ^ _u64_js_1.default.rotrSL(W15h, W15l, 8) ^ _u64_js_1.default.shrSL(W15h, W15l, 7);
                // s1 := (w[i-2] rightrotate 19) xor (w[i-2] rightrotate 61) xor (w[i-2] rightshift 6)
                const W2h = SHA512_W_H$1[i - 2] | 0;
                const W2l = SHA512_W_L$1[i - 2] | 0;
                const s1h = _u64_js_1.default.rotrSH(W2h, W2l, 19) ^ _u64_js_1.default.rotrBH(W2h, W2l, 61) ^ _u64_js_1.default.shrSH(W2h, W2l, 6);
                const s1l = _u64_js_1.default.rotrSL(W2h, W2l, 19) ^ _u64_js_1.default.rotrBL(W2h, W2l, 61) ^ _u64_js_1.default.shrSL(W2h, W2l, 6);
                // SHA256_W[i] = s0 + s1 + SHA256_W[i - 7] + SHA256_W[i - 16];
                const SUMl = _u64_js_1.default.add4L(s0l, s1l, SHA512_W_L$1[i - 7], SHA512_W_L$1[i - 16]);
                const SUMh = _u64_js_1.default.add4H(SUMl, s0h, s1h, SHA512_W_H$1[i - 7], SHA512_W_H$1[i - 16]);
                SHA512_W_H$1[i] = SUMh | 0;
                SHA512_W_L$1[i] = SUMl | 0;
            }
            let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
            // Compression function main loop, 80 rounds
            for (let i = 0; i < 80; i++) {
                // S1 := (e rightrotate 14) xor (e rightrotate 18) xor (e rightrotate 41)
                const sigma1h = _u64_js_1.default.rotrSH(Eh, El, 14) ^ _u64_js_1.default.rotrSH(Eh, El, 18) ^ _u64_js_1.default.rotrBH(Eh, El, 41);
                const sigma1l = _u64_js_1.default.rotrSL(Eh, El, 14) ^ _u64_js_1.default.rotrSL(Eh, El, 18) ^ _u64_js_1.default.rotrBL(Eh, El, 41);
                //const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
                const CHIh = (Eh & Fh) ^ (~Eh & Gh);
                const CHIl = (El & Fl) ^ (~El & Gl);
                // T1 = H + sigma1 + Chi(E, F, G) + SHA512_K[i] + SHA512_W[i]
                // prettier-ignore
                const T1ll = _u64_js_1.default.add5L(Hl, sigma1l, CHIl, SHA512_Kl$1[i], SHA512_W_L$1[i]);
                const T1h = _u64_js_1.default.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh$1[i], SHA512_W_H$1[i]);
                const T1l = T1ll | 0;
                // S0 := (a rightrotate 28) xor (a rightrotate 34) xor (a rightrotate 39)
                const sigma0h = _u64_js_1.default.rotrSH(Ah, Al, 28) ^ _u64_js_1.default.rotrBH(Ah, Al, 34) ^ _u64_js_1.default.rotrBH(Ah, Al, 39);
                const sigma0l = _u64_js_1.default.rotrSL(Ah, Al, 28) ^ _u64_js_1.default.rotrBL(Ah, Al, 34) ^ _u64_js_1.default.rotrBL(Ah, Al, 39);
                const MAJh = (Ah & Bh) ^ (Ah & Ch) ^ (Bh & Ch);
                const MAJl = (Al & Bl) ^ (Al & Cl) ^ (Bl & Cl);
                Hh = Gh | 0;
                Hl = Gl | 0;
                Gh = Fh | 0;
                Gl = Fl | 0;
                Fh = Eh | 0;
                Fl = El | 0;
                ({ h: Eh, l: El } = _u64_js_1.default.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
                Dh = Ch | 0;
                Dl = Cl | 0;
                Ch = Bh | 0;
                Cl = Bl | 0;
                Bh = Ah | 0;
                Bl = Al | 0;
                const All = _u64_js_1.default.add3L(T1l, sigma0l, MAJl);
                Ah = _u64_js_1.default.add3H(All, T1h, sigma0h, MAJh);
                Al = All | 0;
            }
            // Add the compressed chunk to the current hash value
            ({ h: Ah, l: Al } = _u64_js_1.default.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
            ({ h: Bh, l: Bl } = _u64_js_1.default.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
            ({ h: Ch, l: Cl } = _u64_js_1.default.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
            ({ h: Dh, l: Dl } = _u64_js_1.default.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
            ({ h: Eh, l: El } = _u64_js_1.default.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
            ({ h: Fh, l: Fl } = _u64_js_1.default.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
            ({ h: Gh, l: Gl } = _u64_js_1.default.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
            ({ h: Hh, l: Hl } = _u64_js_1.default.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
            this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
        }
        roundClean() {
            SHA512_W_H$1.fill(0);
            SHA512_W_L$1.fill(0);
        }
        destroy() {
            this.buffer.fill(0);
            this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
    };
    sha512$1.SHA512 = SHA512$1;
    let SHA512_224$1 = class SHA512_224 extends SHA512$1 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x8c3d37c8 | 0;
            this.Al = 0x19544da2 | 0;
            this.Bh = 0x73e19966 | 0;
            this.Bl = 0x89dcd4d6 | 0;
            this.Ch = 0x1dfab7ae | 0;
            this.Cl = 0x32ff9c82 | 0;
            this.Dh = 0x679dd514 | 0;
            this.Dl = 0x582f9fcf | 0;
            this.Eh = 0x0f6d2b69 | 0;
            this.El = 0x7bd44da8 | 0;
            this.Fh = 0x77e36f73 | 0;
            this.Fl = 0x04c48942 | 0;
            this.Gh = 0x3f9d85a8 | 0;
            this.Gl = 0x6a1d36c8 | 0;
            this.Hh = 0x1112e6ad | 0;
            this.Hl = 0x91d692a1 | 0;
            this.outputLen = 28;
        }
    };
    let SHA512_256$1 = class SHA512_256 extends SHA512$1 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x22312194 | 0;
            this.Al = 0xfc2bf72c | 0;
            this.Bh = 0x9f555fa3 | 0;
            this.Bl = 0xc84c64c2 | 0;
            this.Ch = 0x2393b86b | 0;
            this.Cl = 0x6f53b151 | 0;
            this.Dh = 0x96387719 | 0;
            this.Dl = 0x5940eabd | 0;
            this.Eh = 0x96283ee2 | 0;
            this.El = 0xa88effe3 | 0;
            this.Fh = 0xbe5e1e25 | 0;
            this.Fl = 0x53863992 | 0;
            this.Gh = 0x2b0199fc | 0;
            this.Gl = 0x2c85b8aa | 0;
            this.Hh = 0x0eb72ddc | 0;
            this.Hl = 0x81c52ca2 | 0;
            this.outputLen = 32;
        }
    };
    let SHA384$1 = class SHA384 extends SHA512$1 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0xcbbb9d5d | 0;
            this.Al = 0xc1059ed8 | 0;
            this.Bh = 0x629a292a | 0;
            this.Bl = 0x367cd507 | 0;
            this.Ch = 0x9159015a | 0;
            this.Cl = 0x3070dd17 | 0;
            this.Dh = 0x152fecd8 | 0;
            this.Dl = 0xf70e5939 | 0;
            this.Eh = 0x67332667 | 0;
            this.El = 0xffc00b31 | 0;
            this.Fh = 0x8eb44a87 | 0;
            this.Fl = 0x68581511 | 0;
            this.Gh = 0xdb0c2e0d | 0;
            this.Gl = 0x64f98fa7 | 0;
            this.Hh = 0x47b5481d | 0;
            this.Hl = 0xbefa4fa4 | 0;
            this.outputLen = 48;
        }
    };
    sha512$1.sha512 = (0, utils_js_1.wrapConstructor)(() => new SHA512$1());
    sha512$1.sha512_224 = (0, utils_js_1.wrapConstructor)(() => new SHA512_224$1());
    sha512$1.sha512_256 = (0, utils_js_1.wrapConstructor)(() => new SHA512_256$1());
    sha512$1.sha384 = (0, utils_js_1.wrapConstructor)(() => new SHA384$1());

    var lib = {};

    (function (exports) {
    	/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
    	Object.defineProperty(exports, "__esModule", { value: true });
    	exports.bytes = exports.stringToBytes = exports.str = exports.bytesToString = exports.hex = exports.utf8 = exports.bech32m = exports.bech32 = exports.base58check = exports.base58xmr = exports.base58xrp = exports.base58flickr = exports.base58 = exports.base64url = exports.base64 = exports.base32crockford = exports.base32hex = exports.base32 = exports.base16 = exports.utils = exports.assertNumber = void 0;
    	function assertNumber(n) {
    	    if (!Number.isSafeInteger(n))
    	        throw new Error(`Wrong integer: ${n}`);
    	}
    	exports.assertNumber = assertNumber;
    	function chain(...args) {
    	    const wrap = (a, b) => (c) => a(b(c));
    	    const encode = Array.from(args)
    	        .reverse()
    	        .reduce((acc, i) => (acc ? wrap(acc, i.encode) : i.encode), undefined);
    	    const decode = args.reduce((acc, i) => (acc ? wrap(acc, i.decode) : i.decode), undefined);
    	    return { encode, decode };
    	}
    	function alphabet(alphabet) {
    	    return {
    	        encode: (digits) => {
    	            if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
    	                throw new Error('alphabet.encode input should be an array of numbers');
    	            return digits.map((i) => {
    	                assertNumber(i);
    	                if (i < 0 || i >= alphabet.length)
    	                    throw new Error(`Digit index outside alphabet: ${i} (alphabet: ${alphabet.length})`);
    	                return alphabet[i];
    	            });
    	        },
    	        decode: (input) => {
    	            if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
    	                throw new Error('alphabet.decode input should be array of strings');
    	            return input.map((letter) => {
    	                if (typeof letter !== 'string')
    	                    throw new Error(`alphabet.decode: not string element=${letter}`);
    	                const index = alphabet.indexOf(letter);
    	                if (index === -1)
    	                    throw new Error(`Unknown letter: "${letter}". Allowed: ${alphabet}`);
    	                return index;
    	            });
    	        },
    	    };
    	}
    	function join(separator = '') {
    	    if (typeof separator !== 'string')
    	        throw new Error('join separator should be string');
    	    return {
    	        encode: (from) => {
    	            if (!Array.isArray(from) || (from.length && typeof from[0] !== 'string'))
    	                throw new Error('join.encode input should be array of strings');
    	            for (let i of from)
    	                if (typeof i !== 'string')
    	                    throw new Error(`join.encode: non-string input=${i}`);
    	            return from.join(separator);
    	        },
    	        decode: (to) => {
    	            if (typeof to !== 'string')
    	                throw new Error('join.decode input should be string');
    	            return to.split(separator);
    	        },
    	    };
    	}
    	function padding(bits, chr = '=') {
    	    assertNumber(bits);
    	    if (typeof chr !== 'string')
    	        throw new Error('padding chr should be string');
    	    return {
    	        encode(data) {
    	            if (!Array.isArray(data) || (data.length && typeof data[0] !== 'string'))
    	                throw new Error('padding.encode input should be array of strings');
    	            for (let i of data)
    	                if (typeof i !== 'string')
    	                    throw new Error(`padding.encode: non-string input=${i}`);
    	            while ((data.length * bits) % 8)
    	                data.push(chr);
    	            return data;
    	        },
    	        decode(input) {
    	            if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
    	                throw new Error('padding.encode input should be array of strings');
    	            for (let i of input)
    	                if (typeof i !== 'string')
    	                    throw new Error(`padding.decode: non-string input=${i}`);
    	            let end = input.length;
    	            if ((end * bits) % 8)
    	                throw new Error('Invalid padding: string should have whole number of bytes');
    	            for (; end > 0 && input[end - 1] === chr; end--) {
    	                if (!(((end - 1) * bits) % 8))
    	                    throw new Error('Invalid padding: string has too much padding');
    	            }
    	            return input.slice(0, end);
    	        },
    	    };
    	}
    	function normalize(fn) {
    	    if (typeof fn !== 'function')
    	        throw new Error('normalize fn should be function');
    	    return { encode: (from) => from, decode: (to) => fn(to) };
    	}
    	function convertRadix(data, from, to) {
    	    if (from < 2)
    	        throw new Error(`convertRadix: wrong from=${from}, base cannot be less than 2`);
    	    if (to < 2)
    	        throw new Error(`convertRadix: wrong to=${to}, base cannot be less than 2`);
    	    if (!Array.isArray(data))
    	        throw new Error('convertRadix: data should be array');
    	    if (!data.length)
    	        return [];
    	    let pos = 0;
    	    const res = [];
    	    const digits = Array.from(data);
    	    digits.forEach((d) => {
    	        assertNumber(d);
    	        if (d < 0 || d >= from)
    	            throw new Error(`Wrong integer: ${d}`);
    	    });
    	    while (true) {
    	        let carry = 0;
    	        let done = true;
    	        for (let i = pos; i < digits.length; i++) {
    	            const digit = digits[i];
    	            const digitBase = from * carry + digit;
    	            if (!Number.isSafeInteger(digitBase) ||
    	                (from * carry) / from !== carry ||
    	                digitBase - digit !== from * carry) {
    	                throw new Error('convertRadix: carry overflow');
    	            }
    	            carry = digitBase % to;
    	            digits[i] = Math.floor(digitBase / to);
    	            if (!Number.isSafeInteger(digits[i]) || digits[i] * to + carry !== digitBase)
    	                throw new Error('convertRadix: carry overflow');
    	            if (!done)
    	                continue;
    	            else if (!digits[i])
    	                pos = i;
    	            else
    	                done = false;
    	        }
    	        res.push(carry);
    	        if (done)
    	            break;
    	    }
    	    for (let i = 0; i < data.length - 1 && data[i] === 0; i++)
    	        res.push(0);
    	    return res.reverse();
    	}
    	const gcd = (a, b) => (!b ? a : gcd(b, a % b));
    	const radix2carry = (from, to) => from + (to - gcd(from, to));
    	function convertRadix2(data, from, to, padding) {
    	    if (!Array.isArray(data))
    	        throw new Error('convertRadix2: data should be array');
    	    if (from <= 0 || from > 32)
    	        throw new Error(`convertRadix2: wrong from=${from}`);
    	    if (to <= 0 || to > 32)
    	        throw new Error(`convertRadix2: wrong to=${to}`);
    	    if (radix2carry(from, to) > 32) {
    	        throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`);
    	    }
    	    let carry = 0;
    	    let pos = 0;
    	    const mask = 2 ** to - 1;
    	    const res = [];
    	    for (const n of data) {
    	        assertNumber(n);
    	        if (n >= 2 ** from)
    	            throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    	        carry = (carry << from) | n;
    	        if (pos + from > 32)
    	            throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    	        pos += from;
    	        for (; pos >= to; pos -= to)
    	            res.push(((carry >> (pos - to)) & mask) >>> 0);
    	        carry &= 2 ** pos - 1;
    	    }
    	    carry = (carry << (to - pos)) & mask;
    	    if (!padding && pos >= from)
    	        throw new Error('Excess padding');
    	    if (!padding && carry)
    	        throw new Error(`Non-zero padding: ${carry}`);
    	    if (padding && pos > 0)
    	        res.push(carry >>> 0);
    	    return res;
    	}
    	function radix(num) {
    	    assertNumber(num);
    	    return {
    	        encode: (bytes) => {
    	            if (!(bytes instanceof Uint8Array))
    	                throw new Error('radix.encode input should be Uint8Array');
    	            return convertRadix(Array.from(bytes), 2 ** 8, num);
    	        },
    	        decode: (digits) => {
    	            if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
    	                throw new Error('radix.decode input should be array of strings');
    	            return Uint8Array.from(convertRadix(digits, num, 2 ** 8));
    	        },
    	    };
    	}
    	function radix2(bits, revPadding = false) {
    	    assertNumber(bits);
    	    if (bits <= 0 || bits > 32)
    	        throw new Error('radix2: bits should be in (0..32]');
    	    if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
    	        throw new Error('radix2: carry overflow');
    	    return {
    	        encode: (bytes) => {
    	            if (!(bytes instanceof Uint8Array))
    	                throw new Error('radix2.encode input should be Uint8Array');
    	            return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    	        },
    	        decode: (digits) => {
    	            if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
    	                throw new Error('radix2.decode input should be array of strings');
    	            return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    	        },
    	    };
    	}
    	function unsafeWrapper(fn) {
    	    if (typeof fn !== 'function')
    	        throw new Error('unsafeWrapper fn should be function');
    	    return function (...args) {
    	        try {
    	            return fn.apply(null, args);
    	        }
    	        catch (e) { }
    	    };
    	}
    	function checksum(len, fn) {
    	    assertNumber(len);
    	    if (typeof fn !== 'function')
    	        throw new Error('checksum fn should be function');
    	    return {
    	        encode(data) {
    	            if (!(data instanceof Uint8Array))
    	                throw new Error('checksum.encode: input should be Uint8Array');
    	            const checksum = fn(data).slice(0, len);
    	            const res = new Uint8Array(data.length + len);
    	            res.set(data);
    	            res.set(checksum, data.length);
    	            return res;
    	        },
    	        decode(data) {
    	            if (!(data instanceof Uint8Array))
    	                throw new Error('checksum.decode: input should be Uint8Array');
    	            const payload = data.slice(0, -len);
    	            const newChecksum = fn(payload).slice(0, len);
    	            const oldChecksum = data.slice(-len);
    	            for (let i = 0; i < len; i++)
    	                if (newChecksum[i] !== oldChecksum[i])
    	                    throw new Error('Invalid checksum');
    	            return payload;
    	        },
    	    };
    	}
    	exports.utils = { alphabet, chain, checksum, radix, radix2, join, padding };
    	exports.base16 = chain(radix2(4), alphabet('0123456789ABCDEF'), join(''));
    	exports.base32 = chain(radix2(5), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), padding(5), join(''));
    	exports.base32hex = chain(radix2(5), alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUV'), padding(5), join(''));
    	exports.base32crockford = chain(radix2(5), alphabet('0123456789ABCDEFGHJKMNPQRSTVWXYZ'), join(''), normalize((s) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')));
    	exports.base64 = chain(radix2(6), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'), padding(6), join(''));
    	exports.base64url = chain(radix2(6), alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), padding(6), join(''));
    	const genBase58 = (abc) => chain(radix(58), alphabet(abc), join(''));
    	exports.base58 = genBase58('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    	exports.base58flickr = genBase58('123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ');
    	exports.base58xrp = genBase58('rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz');
    	const XMR_BLOCK_LEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    	exports.base58xmr = {
    	    encode(data) {
    	        let res = '';
    	        for (let i = 0; i < data.length; i += 8) {
    	            const block = data.subarray(i, i + 8);
    	            res += exports.base58.encode(block).padStart(XMR_BLOCK_LEN[block.length], '1');
    	        }
    	        return res;
    	    },
    	    decode(str) {
    	        let res = [];
    	        for (let i = 0; i < str.length; i += 11) {
    	            const slice = str.slice(i, i + 11);
    	            const blockLen = XMR_BLOCK_LEN.indexOf(slice.length);
    	            const block = exports.base58.decode(slice);
    	            for (let j = 0; j < block.length - blockLen; j++) {
    	                if (block[j] !== 0)
    	                    throw new Error('base58xmr: wrong padding');
    	            }
    	            res = res.concat(Array.from(block.slice(block.length - blockLen)));
    	        }
    	        return Uint8Array.from(res);
    	    },
    	};
    	const base58check = (sha256) => chain(checksum(4, (data) => sha256(sha256(data))), exports.base58);
    	exports.base58check = base58check;
    	const BECH_ALPHABET = chain(alphabet('qpzry9x8gf2tvdw0s3jn54khce6mua7l'), join(''));
    	const POLYMOD_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    	function bech32Polymod(pre) {
    	    const b = pre >> 25;
    	    let chk = (pre & 0x1ffffff) << 5;
    	    for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
    	        if (((b >> i) & 1) === 1)
    	            chk ^= POLYMOD_GENERATORS[i];
    	    }
    	    return chk;
    	}
    	function bechChecksum(prefix, words, encodingConst = 1) {
    	    const len = prefix.length;
    	    let chk = 1;
    	    for (let i = 0; i < len; i++) {
    	        const c = prefix.charCodeAt(i);
    	        if (c < 33 || c > 126)
    	            throw new Error(`Invalid prefix (${prefix})`);
    	        chk = bech32Polymod(chk) ^ (c >> 5);
    	    }
    	    chk = bech32Polymod(chk);
    	    for (let i = 0; i < len; i++)
    	        chk = bech32Polymod(chk) ^ (prefix.charCodeAt(i) & 0x1f);
    	    for (let v of words)
    	        chk = bech32Polymod(chk) ^ v;
    	    for (let i = 0; i < 6; i++)
    	        chk = bech32Polymod(chk);
    	    chk ^= encodingConst;
    	    return BECH_ALPHABET.encode(convertRadix2([chk % 2 ** 30], 30, 5, false));
    	}
    	function genBech32(encoding) {
    	    const ENCODING_CONST = encoding === 'bech32' ? 1 : 0x2bc830a3;
    	    const _words = radix2(5);
    	    const fromWords = _words.decode;
    	    const toWords = _words.encode;
    	    const fromWordsUnsafe = unsafeWrapper(fromWords);
    	    function encode(prefix, words, limit = 90) {
    	        if (typeof prefix !== 'string')
    	            throw new Error(`bech32.encode prefix should be string, not ${typeof prefix}`);
    	        if (!Array.isArray(words) || (words.length && typeof words[0] !== 'number'))
    	            throw new Error(`bech32.encode words should be array of numbers, not ${typeof words}`);
    	        const actualLength = prefix.length + 7 + words.length;
    	        if (limit !== false && actualLength > limit)
    	            throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    	        prefix = prefix.toLowerCase();
    	        return `${prefix}1${BECH_ALPHABET.encode(words)}${bechChecksum(prefix, words, ENCODING_CONST)}`;
    	    }
    	    function decode(str, limit = 90) {
    	        if (typeof str !== 'string')
    	            throw new Error(`bech32.decode input should be string, not ${typeof str}`);
    	        if (str.length < 8 || (limit !== false && str.length > limit))
    	            throw new TypeError(`Wrong string length: ${str.length} (${str}). Expected (8..${limit})`);
    	        const lowered = str.toLowerCase();
    	        if (str !== lowered && str !== str.toUpperCase())
    	            throw new Error(`String must be lowercase or uppercase`);
    	        str = lowered;
    	        const sepIndex = str.lastIndexOf('1');
    	        if (sepIndex === 0 || sepIndex === -1)
    	            throw new Error(`Letter "1" must be present between prefix and data only`);
    	        const prefix = str.slice(0, sepIndex);
    	        const _words = str.slice(sepIndex + 1);
    	        if (_words.length < 6)
    	            throw new Error('Data must be at least 6 characters long');
    	        const words = BECH_ALPHABET.decode(_words).slice(0, -6);
    	        const sum = bechChecksum(prefix, words, ENCODING_CONST);
    	        if (!_words.endsWith(sum))
    	            throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    	        return { prefix, words };
    	    }
    	    const decodeUnsafe = unsafeWrapper(decode);
    	    function decodeToBytes(str) {
    	        const { prefix, words } = decode(str, false);
    	        return { prefix, words, bytes: fromWords(words) };
    	    }
    	    return { encode, decode, decodeToBytes, decodeUnsafe, fromWords, fromWordsUnsafe, toWords };
    	}
    	exports.bech32 = genBech32('bech32');
    	exports.bech32m = genBech32('bech32m');
    	exports.utf8 = {
    	    encode: (data) => new TextDecoder().decode(data),
    	    decode: (str) => new TextEncoder().encode(str),
    	};
    	exports.hex = chain(radix2(4), alphabet('0123456789abcdef'), join(''), normalize((s) => {
    	    if (typeof s !== 'string' || s.length % 2)
    	        throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
    	    return s.toLowerCase();
    	}));
    	const CODERS = {
    	    utf8: exports.utf8, hex: exports.hex, base16: exports.base16, base32: exports.base32, base64: exports.base64, base64url: exports.base64url, base58: exports.base58, base58xmr: exports.base58xmr
    	};
    	const coderTypeError = `Invalid encoding type. Available types: ${Object.keys(CODERS).join(', ')}`;
    	const bytesToString = (type, bytes) => {
    	    if (typeof type !== 'string' || !CODERS.hasOwnProperty(type))
    	        throw new TypeError(coderTypeError);
    	    if (!(bytes instanceof Uint8Array))
    	        throw new TypeError('bytesToString() expects Uint8Array');
    	    return CODERS[type].encode(bytes);
    	};
    	exports.bytesToString = bytesToString;
    	exports.str = exports.bytesToString;
    	const stringToBytes = (type, str) => {
    	    if (!CODERS.hasOwnProperty(type))
    	        throw new TypeError(coderTypeError);
    	    if (typeof str !== 'string')
    	        throw new TypeError('stringToBytes() expects string');
    	    return CODERS[type].decode(str);
    	};
    	exports.stringToBytes = stringToBytes;
    	exports.bytes = exports.stringToBytes;
    } (lib));

    Object.defineProperty(bip39, "__esModule", { value: true });
    var mnemonicToSeedSync_1 = bip39.mnemonicToSeedSync = bip39.mnemonicToSeed = validateMnemonic_1 = bip39.validateMnemonic = bip39.entropyToMnemonic = bip39.mnemonicToEntropy = generateMnemonic_1 = bip39.generateMnemonic = void 0;
    /*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
    const _assert_1 = _assert;
    const pbkdf2_1 = pbkdf2$1;
    const sha256_1 = sha256$1;
    const sha512_1 = sha512$1;
    const utils_1 = utils;
    const base_1 = lib;
    // Japanese wordlist
    const isJapanese = (wordlist) => wordlist[0] === '\u3042\u3044\u3053\u304f\u3057\u3093';
    // Normalization replaces equivalent sequences of characters
    // so that any two texts that are equivalent will be reduced
    // to the same sequence of code points, called the normal form of the original text.
    function nfkd(str) {
        if (typeof str !== 'string')
            throw new TypeError(`Invalid mnemonic type: ${typeof str}`);
        return str.normalize('NFKD');
    }
    function normalize(str) {
        const norm = nfkd(str);
        const words = norm.split(' ');
        if (![12, 15, 18, 21, 24].includes(words.length))
            throw new Error('Invalid mnemonic');
        return { nfkd: norm, words };
    }
    function assertEntropy(entropy) {
        _assert_1.default.bytes(entropy, 16, 20, 24, 28, 32);
    }
    /**
     * Generate x random words. Uses Cryptographically-Secure Random Number Generator.
     * @param wordlist imported wordlist for specific language
     * @param strength mnemonic strength 128-256 bits
     * @example
     * generateMnemonic(wordlist, 128)
     * // 'legal winner thank year wave sausage worth useful legal winner thank yellow'
     */
    function generateMnemonic(wordlist, strength = 128) {
        _assert_1.default.number(strength);
        if (strength % 32 !== 0 || strength > 256)
            throw new TypeError('Invalid entropy');
        return entropyToMnemonic((0, utils_1.randomBytes)(strength / 8), wordlist);
    }
    var generateMnemonic_1 = bip39.generateMnemonic = generateMnemonic;
    const calcChecksum = (entropy) => {
        // Checksum is ent.length/4 bits long
        const bitsLeft = 8 - entropy.length / 4;
        // Zero rightmost "bitsLeft" bits in byte
        // For example: bitsLeft=4 val=10111101 -> 10110000
        return new Uint8Array([((0, sha256_1.sha256)(entropy)[0] >> bitsLeft) << bitsLeft]);
    };
    function getCoder(wordlist) {
        if (!Array.isArray(wordlist) || wordlist.length !== 2048 || typeof wordlist[0] !== 'string')
            throw new Error('Worlist: expected array of 2048 strings');
        wordlist.forEach((i) => {
            if (typeof i !== 'string')
                throw new Error(`Wordlist: non-string element: ${i}`);
        });
        return base_1.utils.chain(base_1.utils.checksum(1, calcChecksum), base_1.utils.radix2(11, true), base_1.utils.alphabet(wordlist));
    }
    /**
     * Reversible: Converts mnemonic string to raw entropy in form of byte array.
     * @param mnemonic 12-24 words
     * @param wordlist imported wordlist for specific language
     * @example
     * const mnem = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
     * mnemonicToEntropy(mnem, wordlist)
     * // Produces
     * new Uint8Array([
     *   0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f,
     *   0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f
     * ])
     */
    function mnemonicToEntropy(mnemonic, wordlist) {
        const { words } = normalize(mnemonic);
        const entropy = getCoder(wordlist).decode(words);
        assertEntropy(entropy);
        return entropy;
    }
    bip39.mnemonicToEntropy = mnemonicToEntropy;
    /**
     * Reversible: Converts raw entropy in form of byte array to mnemonic string.
     * @param entropy byte array
     * @param wordlist imported wordlist for specific language
     * @returns 12-24 words
     * @example
     * const ent = new Uint8Array([
     *   0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f,
     *   0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f
     * ]);
     * entropyToMnemonic(ent, wordlist);
     * // 'legal winner thank year wave sausage worth useful legal winner thank yellow'
     */
    function entropyToMnemonic(entropy, wordlist) {
        assertEntropy(entropy);
        const words = getCoder(wordlist).encode(entropy);
        return words.join(isJapanese(wordlist) ? '\u3000' : ' ');
    }
    bip39.entropyToMnemonic = entropyToMnemonic;
    /**
     * Validates mnemonic for being 12-24 words contained in `wordlist`.
     */
    function validateMnemonic(mnemonic, wordlist) {
        try {
            mnemonicToEntropy(mnemonic, wordlist);
        }
        catch (e) {
            return false;
        }
        return true;
    }
    var validateMnemonic_1 = bip39.validateMnemonic = validateMnemonic;
    const salt = (passphrase) => nfkd(`mnemonic${passphrase}`);
    /**
     * Irreversible: Uses KDF to derive 64 bytes of key data from mnemonic + optional password.
     * @param mnemonic 12-24 words
     * @param passphrase string that will additionally protect the key
     * @returns 64 bytes of key data
     * @example
     * const mnem = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
     * await mnemonicToSeed(mnem, 'password');
     * // new Uint8Array([...64 bytes])
     */
    function mnemonicToSeed(mnemonic, passphrase = '') {
        return (0, pbkdf2_1.pbkdf2Async)(sha512_1.sha512, normalize(mnemonic).nfkd, salt(passphrase), { c: 2048, dkLen: 64 });
    }
    bip39.mnemonicToSeed = mnemonicToSeed;
    /**
     * Irreversible: Uses KDF to derive 64 bytes of key data from mnemonic + optional password.
     * @param mnemonic 12-24 words
     * @param passphrase string that will additionally protect the key
     * @returns 64 bytes of key data
     * @example
     * const mnem = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
     * mnemonicToSeedSync(mnem, 'password');
     * // new Uint8Array([...64 bytes])
     */
    function mnemonicToSeedSync(mnemonic, passphrase = '') {
        return (0, pbkdf2_1.pbkdf2)(sha512_1.sha512, normalize(mnemonic).nfkd, salt(passphrase), { c: 2048, dkLen: 64 });
    }
    mnemonicToSeedSync_1 = bip39.mnemonicToSeedSync = mnemonicToSeedSync;

    function number(n) {
        if (!Number.isSafeInteger(n) || n < 0)
            throw new Error(`Wrong positive integer: ${n}`);
    }
    function bool(b) {
        if (typeof b !== 'boolean')
            throw new Error(`Expected boolean, not ${b}`);
    }
    function bytes(b, ...lengths) {
        if (!(b instanceof Uint8Array))
            throw new TypeError('Expected Uint8Array');
        if (lengths.length > 0 && !lengths.includes(b.length))
            throw new TypeError(`Expected Uint8Array of length ${lengths}, not of length=${b.length}`);
    }
    function hash(hash) {
        if (typeof hash !== 'function' || typeof hash.create !== 'function')
            throw new Error('Hash should be wrapped by utils.wrapConstructor');
        number(hash.outputLen);
        number(hash.blockLen);
    }
    function exists(instance, checkFinished = true) {
        if (instance.destroyed)
            throw new Error('Hash instance has been destroyed');
        if (checkFinished && instance.finished)
            throw new Error('Hash#digest() has already been called');
    }
    function output(out, instance) {
        bytes(out);
        const min = instance.outputLen;
        if (out.length < min) {
            throw new Error(`digestInto() expects output buffer of length at least ${min}`);
        }
    }
    const assert = {
        number,
        bool,
        bytes,
        hash,
        exists,
        output,
    };

    /*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
    // Cast array to view
    const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    // The rotate right (circular right shift) operation for uint32
    const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);
    const isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
    // There is almost no big endian hardware, but js typed arrays uses platform specific endianness.
    // So, just to be sure not to corrupt anything.
    if (!isLE)
        throw new Error('Non little-endian hardware is not supported');
    const hexes = Array.from({ length: 256 }, (v, i) => i.toString(16).padStart(2, '0'));
    /**
     * @example bytesToHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
     */
    function bytesToHex(uint8a) {
        // pre-caching improves the speed 6x
        if (!(uint8a instanceof Uint8Array))
            throw new Error('Uint8Array expected');
        let hex = '';
        for (let i = 0; i < uint8a.length; i++) {
            hex += hexes[uint8a[i]];
        }
        return hex;
    }
    /**
     * @example hexToBytes('deadbeef')
     */
    function hexToBytes(hex) {
        if (typeof hex !== 'string') {
            throw new TypeError('hexToBytes: expected string, got ' + typeof hex);
        }
        if (hex.length % 2)
            throw new Error('hexToBytes: received invalid unpadded hex');
        const array = new Uint8Array(hex.length / 2);
        for (let i = 0; i < array.length; i++) {
            const j = i * 2;
            const hexByte = hex.slice(j, j + 2);
            const byte = Number.parseInt(hexByte, 16);
            if (Number.isNaN(byte) || byte < 0)
                throw new Error('Invalid byte sequence');
            array[i] = byte;
        }
        return array;
    }
    function utf8ToBytes(str) {
        if (typeof str !== 'string') {
            throw new TypeError(`utf8ToBytes expected string, got ${typeof str}`);
        }
        return new TextEncoder().encode(str);
    }
    function toBytes(data) {
        if (typeof data === 'string')
            data = utf8ToBytes(data);
        if (!(data instanceof Uint8Array))
            throw new TypeError(`Expected input type is Uint8Array (got ${typeof data})`);
        return data;
    }
    /**
     * Concats Uint8Array-s into one; like `Buffer.concat([buf1, buf2])`
     * @example concatBytes(buf1, buf2)
     */
    function concatBytes(...arrays) {
        if (!arrays.every((a) => a instanceof Uint8Array))
            throw new Error('Uint8Array list expected');
        if (arrays.length === 1)
            return arrays[0];
        const length = arrays.reduce((a, arr) => a + arr.length, 0);
        const result = new Uint8Array(length);
        for (let i = 0, pad = 0; i < arrays.length; i++) {
            const arr = arrays[i];
            result.set(arr, pad);
            pad += arr.length;
        }
        return result;
    }
    // For runtime check if class implements interface
    class Hash {
        // Safe version that clones internal state
        clone() {
            return this._cloneInto();
        }
    }
    function wrapConstructor(hashConstructor) {
        const hashC = (message) => hashConstructor().update(toBytes(message)).digest();
        const tmp = hashConstructor();
        hashC.outputLen = tmp.outputLen;
        hashC.blockLen = tmp.blockLen;
        hashC.create = () => hashConstructor();
        return hashC;
    }

    // HMAC (RFC 2104)
    let HMAC$1 = class HMAC extends Hash {
        constructor(hash, _key) {
            super();
            this.finished = false;
            this.destroyed = false;
            assert.hash(hash);
            const key = toBytes(_key);
            this.iHash = hash.create();
            if (typeof this.iHash.update !== 'function')
                throw new TypeError('Expected instance of class which extends utils.Hash');
            this.blockLen = this.iHash.blockLen;
            this.outputLen = this.iHash.outputLen;
            const blockLen = this.blockLen;
            const pad = new Uint8Array(blockLen);
            // blockLen can be bigger than outputLen
            pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
            for (let i = 0; i < pad.length; i++)
                pad[i] ^= 0x36;
            this.iHash.update(pad);
            // By doing update (processing of first block) of outer hash here we can re-use it between multiple calls via clone
            this.oHash = hash.create();
            // Undo internal XOR && apply outer XOR
            for (let i = 0; i < pad.length; i++)
                pad[i] ^= 0x36 ^ 0x5c;
            this.oHash.update(pad);
            pad.fill(0);
        }
        update(buf) {
            assert.exists(this);
            this.iHash.update(buf);
            return this;
        }
        digestInto(out) {
            assert.exists(this);
            assert.bytes(out, this.outputLen);
            this.finished = true;
            this.iHash.digestInto(out);
            this.oHash.update(out);
            this.oHash.digestInto(out);
            this.destroy();
        }
        digest() {
            const out = new Uint8Array(this.oHash.outputLen);
            this.digestInto(out);
            return out;
        }
        _cloneInto(to) {
            // Create new instance without calling constructor since key already in state and we don't know it.
            to || (to = Object.create(Object.getPrototypeOf(this), {}));
            const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
            to = to;
            to.finished = finished;
            to.destroyed = destroyed;
            to.blockLen = blockLen;
            to.outputLen = outputLen;
            to.oHash = oHash._cloneInto(to.oHash);
            to.iHash = iHash._cloneInto(to.iHash);
            return to;
        }
        destroy() {
            this.destroyed = true;
            this.oHash.destroy();
            this.iHash.destroy();
        }
    };
    /**
     * HMAC: RFC2104 message authentication code.
     * @param hash - function that would be used e.g. sha256
     * @param key - message key
     * @param message - message data
     */
    const hmac$1 = (hash, key, message) => new HMAC$1(hash, key).update(message).digest();
    hmac$1.create = (hash, key) => new HMAC$1(hash, key);

    // Polyfill for Safari 14
    function setBigUint64(view, byteOffset, value, isLE) {
        if (typeof view.setBigUint64 === 'function')
            return view.setBigUint64(byteOffset, value, isLE);
        const _32n = BigInt(32);
        const _u32_max = BigInt(0xffffffff);
        const wh = Number((value >> _32n) & _u32_max);
        const wl = Number(value & _u32_max);
        const h = isLE ? 4 : 0;
        const l = isLE ? 0 : 4;
        view.setUint32(byteOffset + h, wh, isLE);
        view.setUint32(byteOffset + l, wl, isLE);
    }
    // Base SHA2 class (RFC 6234)
    class SHA2 extends Hash {
        constructor(blockLen, outputLen, padOffset, isLE) {
            super();
            this.blockLen = blockLen;
            this.outputLen = outputLen;
            this.padOffset = padOffset;
            this.isLE = isLE;
            this.finished = false;
            this.length = 0;
            this.pos = 0;
            this.destroyed = false;
            this.buffer = new Uint8Array(blockLen);
            this.view = createView(this.buffer);
        }
        update(data) {
            assert.exists(this);
            const { view, buffer, blockLen } = this;
            data = toBytes(data);
            const len = data.length;
            for (let pos = 0; pos < len;) {
                const take = Math.min(blockLen - this.pos, len - pos);
                // Fast path: we have at least one block in input, cast it to view and process
                if (take === blockLen) {
                    const dataView = createView(data);
                    for (; blockLen <= len - pos; pos += blockLen)
                        this.process(dataView, pos);
                    continue;
                }
                buffer.set(data.subarray(pos, pos + take), this.pos);
                this.pos += take;
                pos += take;
                if (this.pos === blockLen) {
                    this.process(view, 0);
                    this.pos = 0;
                }
            }
            this.length += data.length;
            this.roundClean();
            return this;
        }
        digestInto(out) {
            assert.exists(this);
            assert.output(out, this);
            this.finished = true;
            // Padding
            // We can avoid allocation of buffer for padding completely if it
            // was previously not allocated here. But it won't change performance.
            const { buffer, view, blockLen, isLE } = this;
            let { pos } = this;
            // append the bit '1' to the message
            buffer[pos++] = 0b10000000;
            this.buffer.subarray(pos).fill(0);
            // we have less than padOffset left in buffer, so we cannot put length in current block, need process it and pad again
            if (this.padOffset > blockLen - pos) {
                this.process(view, 0);
                pos = 0;
            }
            // Pad until full block byte with zeros
            for (let i = pos; i < blockLen; i++)
                buffer[i] = 0;
            // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
            // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
            // So we just write lowest 64 bits of that value.
            setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
            this.process(view, 0);
            const oview = createView(out);
            const len = this.outputLen;
            // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
            if (len % 4)
                throw new Error('_sha2: outputLen should be aligned to 32bit');
            const outLen = len / 4;
            const state = this.get();
            if (outLen > state.length)
                throw new Error('_sha2: outputLen bigger than state');
            for (let i = 0; i < outLen; i++)
                oview.setUint32(4 * i, state[i], isLE);
        }
        digest() {
            const { buffer, outputLen } = this;
            this.digestInto(buffer);
            const res = buffer.slice(0, outputLen);
            this.destroy();
            return res;
        }
        _cloneInto(to) {
            to || (to = new this.constructor());
            to.set(...this.get());
            const { blockLen, buffer, length, finished, destroyed, pos } = this;
            to.length = length;
            to.pos = pos;
            to.finished = finished;
            to.destroyed = destroyed;
            if (length % blockLen)
                to.buffer.set(buffer);
            return to;
        }
    }

    // https://homes.esat.kuleuven.be/~bosselae/ripemd160.html
    // https://homes.esat.kuleuven.be/~bosselae/ripemd160/pdf/AB-9601/AB-9601.pdf
    const Rho = new Uint8Array([7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8]);
    const Id = Uint8Array.from({ length: 16 }, (_, i) => i);
    const Pi = Id.map((i) => (9 * i + 5) % 16);
    let idxL = [Id];
    let idxR = [Pi];
    for (let i = 0; i < 4; i++)
        for (let j of [idxL, idxR])
            j.push(j[i].map((k) => Rho[k]));
    const shifts = [
        [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
        [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],
        [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],
        [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],
        [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5],
    ].map((i) => new Uint8Array(i));
    const shiftsL = idxL.map((idx, i) => idx.map((j) => shifts[i][j]));
    const shiftsR = idxR.map((idx, i) => idx.map((j) => shifts[i][j]));
    const Kl = new Uint32Array([0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]);
    const Kr = new Uint32Array([0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]);
    // The rotate left (circular left shift) operation for uint32
    const rotl = (word, shift) => (word << shift) | (word >>> (32 - shift));
    // It's called f() in spec.
    function f(group, x, y, z) {
        if (group === 0)
            return x ^ y ^ z;
        else if (group === 1)
            return (x & y) | (~x & z);
        else if (group === 2)
            return (x | ~y) ^ z;
        else if (group === 3)
            return (x & z) | (y & ~z);
        else
            return x ^ (y | ~z);
    }
    // Temporary buffer, not used to store anything between runs
    const BUF = new Uint32Array(16);
    class RIPEMD160 extends SHA2 {
        constructor() {
            super(64, 20, 8, true);
            this.h0 = 0x67452301 | 0;
            this.h1 = 0xefcdab89 | 0;
            this.h2 = 0x98badcfe | 0;
            this.h3 = 0x10325476 | 0;
            this.h4 = 0xc3d2e1f0 | 0;
        }
        get() {
            const { h0, h1, h2, h3, h4 } = this;
            return [h0, h1, h2, h3, h4];
        }
        set(h0, h1, h2, h3, h4) {
            this.h0 = h0 | 0;
            this.h1 = h1 | 0;
            this.h2 = h2 | 0;
            this.h3 = h3 | 0;
            this.h4 = h4 | 0;
        }
        process(view, offset) {
            for (let i = 0; i < 16; i++, offset += 4)
                BUF[i] = view.getUint32(offset, true);
            // prettier-ignore
            let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
            // Instead of iterating 0 to 80, we split it into 5 groups
            // And use the groups in constants, functions, etc. Much simpler
            for (let group = 0; group < 5; group++) {
                const rGroup = 4 - group;
                const hbl = Kl[group], hbr = Kr[group]; // prettier-ignore
                const rl = idxL[group], rr = idxR[group]; // prettier-ignore
                const sl = shiftsL[group], sr = shiftsR[group]; // prettier-ignore
                for (let i = 0; i < 16; i++) {
                    const tl = (rotl(al + f(group, bl, cl, dl) + BUF[rl[i]] + hbl, sl[i]) + el) | 0;
                    al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl; // prettier-ignore
                }
                // 2 loops are 10% faster
                for (let i = 0; i < 16; i++) {
                    const tr = (rotl(ar + f(rGroup, br, cr, dr) + BUF[rr[i]] + hbr, sr[i]) + er) | 0;
                    ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr; // prettier-ignore
                }
            }
            // Add the compressed chunk to the current hash value
            this.set((this.h1 + cl + dr) | 0, (this.h2 + dl + er) | 0, (this.h3 + el + ar) | 0, (this.h4 + al + br) | 0, (this.h0 + bl + cr) | 0);
        }
        roundClean() {
            BUF.fill(0);
        }
        destroy() {
            this.destroyed = true;
            this.buffer.fill(0);
            this.set(0, 0, 0, 0, 0);
        }
    }
    /**
     * RIPEMD-160 - a hash function from 1990s.
     * @param message - msg that would be hashed
     */
    const ripemd160 = wrapConstructor(() => new RIPEMD160());

    // Choice: a ? b : c
    const Chi = (a, b, c) => (a & b) ^ (~a & c);
    // Majority function, true if any two inpust is true
    const Maj = (a, b, c) => (a & b) ^ (a & c) ^ (b & c);
    // Round constants:
    // first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
    // prettier-ignore
    const SHA256_K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    // Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
    // prettier-ignore
    const IV = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    // Temporary buffer, not used to store anything between runs
    // Named this way because it matches specification.
    const SHA256_W = new Uint32Array(64);
    class SHA256 extends SHA2 {
        constructor() {
            super(64, 32, 8, false);
            // We cannot use array here since array allows indexing by variable
            // which means optimizer/compiler cannot use registers.
            this.A = IV[0] | 0;
            this.B = IV[1] | 0;
            this.C = IV[2] | 0;
            this.D = IV[3] | 0;
            this.E = IV[4] | 0;
            this.F = IV[5] | 0;
            this.G = IV[6] | 0;
            this.H = IV[7] | 0;
        }
        get() {
            const { A, B, C, D, E, F, G, H } = this;
            return [A, B, C, D, E, F, G, H];
        }
        // prettier-ignore
        set(A, B, C, D, E, F, G, H) {
            this.A = A | 0;
            this.B = B | 0;
            this.C = C | 0;
            this.D = D | 0;
            this.E = E | 0;
            this.F = F | 0;
            this.G = G | 0;
            this.H = H | 0;
        }
        process(view, offset) {
            // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
            for (let i = 0; i < 16; i++, offset += 4)
                SHA256_W[i] = view.getUint32(offset, false);
            for (let i = 16; i < 64; i++) {
                const W15 = SHA256_W[i - 15];
                const W2 = SHA256_W[i - 2];
                const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ (W15 >>> 3);
                const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ (W2 >>> 10);
                SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
            }
            // Compression function main loop, 64 rounds
            let { A, B, C, D, E, F, G, H } = this;
            for (let i = 0; i < 64; i++) {
                const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
                const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
                const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
                const T2 = (sigma0 + Maj(A, B, C)) | 0;
                H = G;
                G = F;
                F = E;
                E = (D + T1) | 0;
                D = C;
                C = B;
                B = A;
                A = (T1 + T2) | 0;
            }
            // Add the compressed chunk to the current hash value
            A = (A + this.A) | 0;
            B = (B + this.B) | 0;
            C = (C + this.C) | 0;
            D = (D + this.D) | 0;
            E = (E + this.E) | 0;
            F = (F + this.F) | 0;
            G = (G + this.G) | 0;
            H = (H + this.H) | 0;
            this.set(A, B, C, D, E, F, G, H);
        }
        roundClean() {
            SHA256_W.fill(0);
        }
        destroy() {
            this.set(0, 0, 0, 0, 0, 0, 0, 0);
            this.buffer.fill(0);
        }
    }
    // Constants from https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
    class SHA224 extends SHA256 {
        constructor() {
            super();
            this.A = 0xc1059ed8 | 0;
            this.B = 0x367cd507 | 0;
            this.C = 0x3070dd17 | 0;
            this.D = 0xf70e5939 | 0;
            this.E = 0xffc00b31 | 0;
            this.F = 0x68581511 | 0;
            this.G = 0x64f98fa7 | 0;
            this.H = 0xbefa4fa4 | 0;
            this.outputLen = 28;
        }
    }
    /**
     * SHA2-256 hash function
     * @param message - data that would be hashed
     */
    const sha256 = wrapConstructor(() => new SHA256());
    wrapConstructor(() => new SHA224());

    const U32_MASK64 = BigInt(2 ** 32 - 1);
    const _32n = BigInt(32);
    // We are not using BigUint64Array, because they are extremely slow as per 2022
    function fromBig(n, le = false) {
        if (le)
            return { h: Number(n & U32_MASK64), l: Number((n >> _32n) & U32_MASK64) };
        return { h: Number((n >> _32n) & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
    }
    function split(lst, le = false) {
        let Ah = new Uint32Array(lst.length);
        let Al = new Uint32Array(lst.length);
        for (let i = 0; i < lst.length; i++) {
            const { h, l } = fromBig(lst[i], le);
            [Ah[i], Al[i]] = [h, l];
        }
        return [Ah, Al];
    }
    const toBig = (h, l) => (BigInt(h >>> 0) << _32n) | BigInt(l >>> 0);
    // for Shift in [0, 32)
    const shrSH = (h, l, s) => h >>> s;
    const shrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
    // Right rotate for Shift in [1, 32)
    const rotrSH = (h, l, s) => (h >>> s) | (l << (32 - s));
    const rotrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
    // Right rotate for Shift in (32, 64), NOTE: 32 is special case.
    const rotrBH = (h, l, s) => (h << (64 - s)) | (l >>> (s - 32));
    const rotrBL = (h, l, s) => (h >>> (s - 32)) | (l << (64 - s));
    // Right rotate for shift===32 (just swaps l&h)
    const rotr32H = (h, l) => l;
    const rotr32L = (h, l) => h;
    // Left rotate for Shift in [1, 32)
    const rotlSH = (h, l, s) => (h << s) | (l >>> (32 - s));
    const rotlSL = (h, l, s) => (l << s) | (h >>> (32 - s));
    // Left rotate for Shift in (32, 64), NOTE: 32 is special case.
    const rotlBH = (h, l, s) => (l << (s - 32)) | (h >>> (64 - s));
    const rotlBL = (h, l, s) => (h << (s - 32)) | (l >>> (64 - s));
    // JS uses 32-bit signed integers for bitwise operations which means we cannot
    // simple take carry out of low bit sum by shift, we need to use division.
    // Removing "export" has 5% perf penalty -_-
    function add(Ah, Al, Bh, Bl) {
        const l = (Al >>> 0) + (Bl >>> 0);
        return { h: (Ah + Bh + ((l / 2 ** 32) | 0)) | 0, l: l | 0 };
    }
    // Addition with more than 2 elements
    const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    const add3H = (low, Ah, Bh, Ch) => (Ah + Bh + Ch + ((low / 2 ** 32) | 0)) | 0;
    const add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    const add4H = (low, Ah, Bh, Ch, Dh) => (Ah + Bh + Ch + Dh + ((low / 2 ** 32) | 0)) | 0;
    const add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    const add5H = (low, Ah, Bh, Ch, Dh, Eh) => (Ah + Bh + Ch + Dh + Eh + ((low / 2 ** 32) | 0)) | 0;
    // prettier-ignore
    const u64 = {
        fromBig, split, toBig,
        shrSH, shrSL,
        rotrSH, rotrSL, rotrBH, rotrBL,
        rotr32H, rotr32L,
        rotlSH, rotlSL, rotlBH, rotlBL,
        add, add3L, add3H, add4L, add4H, add5H, add5L,
    };

    // Round contants (first 32 bits of the fractional parts of the cube roots of the first 80 primes 2..409):
    // prettier-ignore
    const [SHA512_Kh, SHA512_Kl] = u64.split([
        '0x428a2f98d728ae22', '0x7137449123ef65cd', '0xb5c0fbcfec4d3b2f', '0xe9b5dba58189dbbc',
        '0x3956c25bf348b538', '0x59f111f1b605d019', '0x923f82a4af194f9b', '0xab1c5ed5da6d8118',
        '0xd807aa98a3030242', '0x12835b0145706fbe', '0x243185be4ee4b28c', '0x550c7dc3d5ffb4e2',
        '0x72be5d74f27b896f', '0x80deb1fe3b1696b1', '0x9bdc06a725c71235', '0xc19bf174cf692694',
        '0xe49b69c19ef14ad2', '0xefbe4786384f25e3', '0x0fc19dc68b8cd5b5', '0x240ca1cc77ac9c65',
        '0x2de92c6f592b0275', '0x4a7484aa6ea6e483', '0x5cb0a9dcbd41fbd4', '0x76f988da831153b5',
        '0x983e5152ee66dfab', '0xa831c66d2db43210', '0xb00327c898fb213f', '0xbf597fc7beef0ee4',
        '0xc6e00bf33da88fc2', '0xd5a79147930aa725', '0x06ca6351e003826f', '0x142929670a0e6e70',
        '0x27b70a8546d22ffc', '0x2e1b21385c26c926', '0x4d2c6dfc5ac42aed', '0x53380d139d95b3df',
        '0x650a73548baf63de', '0x766a0abb3c77b2a8', '0x81c2c92e47edaee6', '0x92722c851482353b',
        '0xa2bfe8a14cf10364', '0xa81a664bbc423001', '0xc24b8b70d0f89791', '0xc76c51a30654be30',
        '0xd192e819d6ef5218', '0xd69906245565a910', '0xf40e35855771202a', '0x106aa07032bbd1b8',
        '0x19a4c116b8d2d0c8', '0x1e376c085141ab53', '0x2748774cdf8eeb99', '0x34b0bcb5e19b48a8',
        '0x391c0cb3c5c95a63', '0x4ed8aa4ae3418acb', '0x5b9cca4f7763e373', '0x682e6ff3d6b2b8a3',
        '0x748f82ee5defb2fc', '0x78a5636f43172f60', '0x84c87814a1f0ab72', '0x8cc702081a6439ec',
        '0x90befffa23631e28', '0xa4506cebde82bde9', '0xbef9a3f7b2c67915', '0xc67178f2e372532b',
        '0xca273eceea26619c', '0xd186b8c721c0c207', '0xeada7dd6cde0eb1e', '0xf57d4f7fee6ed178',
        '0x06f067aa72176fba', '0x0a637dc5a2c898a6', '0x113f9804bef90dae', '0x1b710b35131c471b',
        '0x28db77f523047d84', '0x32caab7b40c72493', '0x3c9ebe0a15c9bebc', '0x431d67c49c100d4c',
        '0x4cc5d4becb3e42b6', '0x597f299cfc657e2a', '0x5fcb6fab3ad6faec', '0x6c44198c4a475817'
    ].map(n => BigInt(n)));
    // Temporary buffer, not used to store anything between runs
    const SHA512_W_H = new Uint32Array(80);
    const SHA512_W_L = new Uint32Array(80);
    class SHA512 extends SHA2 {
        constructor() {
            super(128, 64, 16, false);
            // We cannot use array here since array allows indexing by variable which means optimizer/compiler cannot use registers.
            // Also looks cleaner and easier to verify with spec.
            // Initial state (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19):
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x6a09e667 | 0;
            this.Al = 0xf3bcc908 | 0;
            this.Bh = 0xbb67ae85 | 0;
            this.Bl = 0x84caa73b | 0;
            this.Ch = 0x3c6ef372 | 0;
            this.Cl = 0xfe94f82b | 0;
            this.Dh = 0xa54ff53a | 0;
            this.Dl = 0x5f1d36f1 | 0;
            this.Eh = 0x510e527f | 0;
            this.El = 0xade682d1 | 0;
            this.Fh = 0x9b05688c | 0;
            this.Fl = 0x2b3e6c1f | 0;
            this.Gh = 0x1f83d9ab | 0;
            this.Gl = 0xfb41bd6b | 0;
            this.Hh = 0x5be0cd19 | 0;
            this.Hl = 0x137e2179 | 0;
        }
        // prettier-ignore
        get() {
            const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
            return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
        }
        // prettier-ignore
        set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
            this.Ah = Ah | 0;
            this.Al = Al | 0;
            this.Bh = Bh | 0;
            this.Bl = Bl | 0;
            this.Ch = Ch | 0;
            this.Cl = Cl | 0;
            this.Dh = Dh | 0;
            this.Dl = Dl | 0;
            this.Eh = Eh | 0;
            this.El = El | 0;
            this.Fh = Fh | 0;
            this.Fl = Fl | 0;
            this.Gh = Gh | 0;
            this.Gl = Gl | 0;
            this.Hh = Hh | 0;
            this.Hl = Hl | 0;
        }
        process(view, offset) {
            // Extend the first 16 words into the remaining 64 words w[16..79] of the message schedule array
            for (let i = 0; i < 16; i++, offset += 4) {
                SHA512_W_H[i] = view.getUint32(offset);
                SHA512_W_L[i] = view.getUint32((offset += 4));
            }
            for (let i = 16; i < 80; i++) {
                // s0 := (w[i-15] rightrotate 1) xor (w[i-15] rightrotate 8) xor (w[i-15] rightshift 7)
                const W15h = SHA512_W_H[i - 15] | 0;
                const W15l = SHA512_W_L[i - 15] | 0;
                const s0h = u64.rotrSH(W15h, W15l, 1) ^ u64.rotrSH(W15h, W15l, 8) ^ u64.shrSH(W15h, W15l, 7);
                const s0l = u64.rotrSL(W15h, W15l, 1) ^ u64.rotrSL(W15h, W15l, 8) ^ u64.shrSL(W15h, W15l, 7);
                // s1 := (w[i-2] rightrotate 19) xor (w[i-2] rightrotate 61) xor (w[i-2] rightshift 6)
                const W2h = SHA512_W_H[i - 2] | 0;
                const W2l = SHA512_W_L[i - 2] | 0;
                const s1h = u64.rotrSH(W2h, W2l, 19) ^ u64.rotrBH(W2h, W2l, 61) ^ u64.shrSH(W2h, W2l, 6);
                const s1l = u64.rotrSL(W2h, W2l, 19) ^ u64.rotrBL(W2h, W2l, 61) ^ u64.shrSL(W2h, W2l, 6);
                // SHA256_W[i] = s0 + s1 + SHA256_W[i - 7] + SHA256_W[i - 16];
                const SUMl = u64.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
                const SUMh = u64.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
                SHA512_W_H[i] = SUMh | 0;
                SHA512_W_L[i] = SUMl | 0;
            }
            let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
            // Compression function main loop, 80 rounds
            for (let i = 0; i < 80; i++) {
                // S1 := (e rightrotate 14) xor (e rightrotate 18) xor (e rightrotate 41)
                const sigma1h = u64.rotrSH(Eh, El, 14) ^ u64.rotrSH(Eh, El, 18) ^ u64.rotrBH(Eh, El, 41);
                const sigma1l = u64.rotrSL(Eh, El, 14) ^ u64.rotrSL(Eh, El, 18) ^ u64.rotrBL(Eh, El, 41);
                //const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
                const CHIh = (Eh & Fh) ^ (~Eh & Gh);
                const CHIl = (El & Fl) ^ (~El & Gl);
                // T1 = H + sigma1 + Chi(E, F, G) + SHA512_K[i] + SHA512_W[i]
                // prettier-ignore
                const T1ll = u64.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
                const T1h = u64.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
                const T1l = T1ll | 0;
                // S0 := (a rightrotate 28) xor (a rightrotate 34) xor (a rightrotate 39)
                const sigma0h = u64.rotrSH(Ah, Al, 28) ^ u64.rotrBH(Ah, Al, 34) ^ u64.rotrBH(Ah, Al, 39);
                const sigma0l = u64.rotrSL(Ah, Al, 28) ^ u64.rotrBL(Ah, Al, 34) ^ u64.rotrBL(Ah, Al, 39);
                const MAJh = (Ah & Bh) ^ (Ah & Ch) ^ (Bh & Ch);
                const MAJl = (Al & Bl) ^ (Al & Cl) ^ (Bl & Cl);
                Hh = Gh | 0;
                Hl = Gl | 0;
                Gh = Fh | 0;
                Gl = Fl | 0;
                Fh = Eh | 0;
                Fl = El | 0;
                ({ h: Eh, l: El } = u64.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
                Dh = Ch | 0;
                Dl = Cl | 0;
                Ch = Bh | 0;
                Cl = Bl | 0;
                Bh = Ah | 0;
                Bl = Al | 0;
                const All = u64.add3L(T1l, sigma0l, MAJl);
                Ah = u64.add3H(All, T1h, sigma0h, MAJh);
                Al = All | 0;
            }
            // Add the compressed chunk to the current hash value
            ({ h: Ah, l: Al } = u64.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
            ({ h: Bh, l: Bl } = u64.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
            ({ h: Ch, l: Cl } = u64.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
            ({ h: Dh, l: Dl } = u64.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
            ({ h: Eh, l: El } = u64.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
            ({ h: Fh, l: Fl } = u64.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
            ({ h: Gh, l: Gl } = u64.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
            ({ h: Hh, l: Hl } = u64.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
            this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
        }
        roundClean() {
            SHA512_W_H.fill(0);
            SHA512_W_L.fill(0);
        }
        destroy() {
            this.buffer.fill(0);
            this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
    }
    class SHA512_224 extends SHA512 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x8c3d37c8 | 0;
            this.Al = 0x19544da2 | 0;
            this.Bh = 0x73e19966 | 0;
            this.Bl = 0x89dcd4d6 | 0;
            this.Ch = 0x1dfab7ae | 0;
            this.Cl = 0x32ff9c82 | 0;
            this.Dh = 0x679dd514 | 0;
            this.Dl = 0x582f9fcf | 0;
            this.Eh = 0x0f6d2b69 | 0;
            this.El = 0x7bd44da8 | 0;
            this.Fh = 0x77e36f73 | 0;
            this.Fl = 0x04c48942 | 0;
            this.Gh = 0x3f9d85a8 | 0;
            this.Gl = 0x6a1d36c8 | 0;
            this.Hh = 0x1112e6ad | 0;
            this.Hl = 0x91d692a1 | 0;
            this.outputLen = 28;
        }
    }
    class SHA512_256 extends SHA512 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0x22312194 | 0;
            this.Al = 0xfc2bf72c | 0;
            this.Bh = 0x9f555fa3 | 0;
            this.Bl = 0xc84c64c2 | 0;
            this.Ch = 0x2393b86b | 0;
            this.Cl = 0x6f53b151 | 0;
            this.Dh = 0x96387719 | 0;
            this.Dl = 0x5940eabd | 0;
            this.Eh = 0x96283ee2 | 0;
            this.El = 0xa88effe3 | 0;
            this.Fh = 0xbe5e1e25 | 0;
            this.Fl = 0x53863992 | 0;
            this.Gh = 0x2b0199fc | 0;
            this.Gl = 0x2c85b8aa | 0;
            this.Hh = 0x0eb72ddc | 0;
            this.Hl = 0x81c52ca2 | 0;
            this.outputLen = 32;
        }
    }
    class SHA384 extends SHA512 {
        constructor() {
            super();
            // h -- high 32 bits, l -- low 32 bits
            this.Ah = 0xcbbb9d5d | 0;
            this.Al = 0xc1059ed8 | 0;
            this.Bh = 0x629a292a | 0;
            this.Bl = 0x367cd507 | 0;
            this.Ch = 0x9159015a | 0;
            this.Cl = 0x3070dd17 | 0;
            this.Dh = 0x152fecd8 | 0;
            this.Dl = 0xf70e5939 | 0;
            this.Eh = 0x67332667 | 0;
            this.El = 0xffc00b31 | 0;
            this.Fh = 0x8eb44a87 | 0;
            this.Fl = 0x68581511 | 0;
            this.Gh = 0xdb0c2e0d | 0;
            this.Gl = 0x64f98fa7 | 0;
            this.Hh = 0x47b5481d | 0;
            this.Hl = 0xbefa4fa4 | 0;
            this.outputLen = 48;
        }
    }
    const sha512 = wrapConstructor(() => new SHA512());
    wrapConstructor(() => new SHA512_224());
    wrapConstructor(() => new SHA512_256());
    wrapConstructor(() => new SHA384());

    utils$1.hmacSha256Sync = (key, ...msgs) => hmac$1(sha256, key, utils$1.concatBytes(...msgs));
    const base58check = base58check$1(sha256);
    function bytesToNumber(bytes) {
        return BigInt(`0x${bytesToHex(bytes)}`);
    }
    function numberToBytes(num) {
        return hexToBytes(num.toString(16).padStart(64, '0'));
    }
    const MASTER_SECRET = utf8ToBytes('Bitcoin seed');
    const BITCOIN_VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };
    const HARDENED_OFFSET = 0x80000000;
    const hash160 = (data) => ripemd160(sha256(data));
    const fromU32 = (data) => createView(data).getUint32(0, false);
    const toU32 = (n) => {
        if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 32 - 1) {
            throw new Error(`Invalid number=${n}. Should be from 0 to 2 ** 32 - 1`);
        }
        const buf = new Uint8Array(4);
        createView(buf).setUint32(0, n, false);
        return buf;
    };
    class HDKey {
        constructor(opt) {
            this.depth = 0;
            this.index = 0;
            this.chainCode = null;
            this.parentFingerprint = 0;
            if (!opt || typeof opt !== 'object') {
                throw new Error('HDKey.constructor must not be called directly');
            }
            this.versions = opt.versions || BITCOIN_VERSIONS;
            this.depth = opt.depth || 0;
            this.chainCode = opt.chainCode;
            this.index = opt.index || 0;
            this.parentFingerprint = opt.parentFingerprint || 0;
            if (!this.depth) {
                if (this.parentFingerprint || this.index) {
                    throw new Error('HDKey: zero depth with non-zero index/parent fingerprint');
                }
            }
            if (opt.publicKey && opt.privateKey) {
                throw new Error('HDKey: publicKey and privateKey at same time.');
            }
            if (opt.privateKey) {
                if (!utils$1.isValidPrivateKey(opt.privateKey)) {
                    throw new Error('Invalid private key');
                }
                this.privKey =
                    typeof opt.privateKey === 'bigint' ? opt.privateKey : bytesToNumber(opt.privateKey);
                this.privKeyBytes = numberToBytes(this.privKey);
                this.pubKey = getPublicKey$1(opt.privateKey, true);
            }
            else if (opt.publicKey) {
                this.pubKey = Point.fromHex(opt.publicKey).toRawBytes(true);
            }
            else {
                throw new Error('HDKey: no public or private key provided');
            }
            this.pubHash = hash160(this.pubKey);
        }
        get fingerprint() {
            if (!this.pubHash) {
                throw new Error('No publicKey set!');
            }
            return fromU32(this.pubHash);
        }
        get identifier() {
            return this.pubHash;
        }
        get pubKeyHash() {
            return this.pubHash;
        }
        get privateKey() {
            return this.privKeyBytes || null;
        }
        get publicKey() {
            return this.pubKey || null;
        }
        get privateExtendedKey() {
            const priv = this.privateKey;
            if (!priv) {
                throw new Error('No private key');
            }
            return base58check.encode(this.serialize(this.versions.private, concatBytes(new Uint8Array([0]), priv)));
        }
        get publicExtendedKey() {
            if (!this.pubKey) {
                throw new Error('No public key');
            }
            return base58check.encode(this.serialize(this.versions.public, this.pubKey));
        }
        static fromMasterSeed(seed, versions = BITCOIN_VERSIONS) {
            bytes(seed);
            if (8 * seed.length < 128 || 8 * seed.length > 512) {
                throw new Error(`HDKey: wrong seed length=${seed.length}. Should be between 128 and 512 bits; 256 bits is advised)`);
            }
            const I = hmac$1(sha512, MASTER_SECRET, seed);
            return new HDKey({
                versions,
                chainCode: I.slice(32),
                privateKey: I.slice(0, 32),
            });
        }
        static fromExtendedKey(base58key, versions = BITCOIN_VERSIONS) {
            const keyBuffer = base58check.decode(base58key);
            const keyView = createView(keyBuffer);
            const version = keyView.getUint32(0, false);
            const opt = {
                versions,
                depth: keyBuffer[4],
                parentFingerprint: keyView.getUint32(5, false),
                index: keyView.getUint32(9, false),
                chainCode: keyBuffer.slice(13, 45),
            };
            const key = keyBuffer.slice(45);
            const isPriv = key[0] === 0;
            if (version !== versions[isPriv ? 'private' : 'public']) {
                throw new Error('Version mismatch');
            }
            if (isPriv) {
                return new HDKey({ ...opt, privateKey: key.slice(1) });
            }
            else {
                return new HDKey({ ...opt, publicKey: key });
            }
        }
        static fromJSON(json) {
            return HDKey.fromExtendedKey(json.xpriv);
        }
        derive(path) {
            if (!/^[mM]'?/.test(path)) {
                throw new Error('Path must start with "m" or "M"');
            }
            if (/^[mM]'?$/.test(path)) {
                return this;
            }
            const parts = path.replace(/^[mM]'?\//, '').split('/');
            let child = this;
            for (const c of parts) {
                const m = /^(\d+)('?)$/.exec(c);
                if (!m || m.length !== 3) {
                    throw new Error(`Invalid child index: ${c}`);
                }
                let idx = +m[1];
                if (!Number.isSafeInteger(idx) || idx >= HARDENED_OFFSET) {
                    throw new Error('Invalid index');
                }
                if (m[2] === "'") {
                    idx += HARDENED_OFFSET;
                }
                child = child.deriveChild(idx);
            }
            return child;
        }
        deriveChild(index) {
            if (!this.pubKey || !this.chainCode) {
                throw new Error('No publicKey or chainCode set');
            }
            let data = toU32(index);
            if (index >= HARDENED_OFFSET) {
                const priv = this.privateKey;
                if (!priv) {
                    throw new Error('Could not derive hardened child key');
                }
                data = concatBytes(new Uint8Array([0]), priv, data);
            }
            else {
                data = concatBytes(this.pubKey, data);
            }
            const I = hmac$1(sha512, this.chainCode, data);
            const childTweak = bytesToNumber(I.slice(0, 32));
            const chainCode = I.slice(32);
            if (!utils$1.isValidPrivateKey(childTweak)) {
                throw new Error('Tweak bigger than curve order');
            }
            const opt = {
                versions: this.versions,
                chainCode,
                depth: this.depth + 1,
                parentFingerprint: this.fingerprint,
                index,
            };
            try {
                if (this.privateKey) {
                    const added = utils$1.mod(this.privKey + childTweak, CURVE.n);
                    if (!utils$1.isValidPrivateKey(added)) {
                        throw new Error('The tweak was out of range or the resulted private key is invalid');
                    }
                    opt.privateKey = added;
                }
                else {
                    const added = Point.fromHex(this.pubKey).add(Point.fromPrivateKey(childTweak));
                    if (added.equals(Point.ZERO)) {
                        throw new Error('The tweak was equal to negative P, which made the result key invalid');
                    }
                    opt.publicKey = added.toRawBytes(true);
                }
                return new HDKey(opt);
            }
            catch (err) {
                return this.deriveChild(index + 1);
            }
        }
        sign(hash) {
            if (!this.privateKey) {
                throw new Error('No privateKey set!');
            }
            bytes(hash, 32);
            return signSync(hash, this.privKey, {
                canonical: true,
                der: false,
            });
        }
        verify(hash, signature) {
            bytes(hash, 32);
            bytes(signature, 64);
            if (!this.publicKey) {
                throw new Error('No publicKey set!');
            }
            let sig;
            try {
                sig = Signature.fromCompact(signature);
            }
            catch (error) {
                return false;
            }
            return verify(sig, hash, this.publicKey);
        }
        wipePrivateData() {
            this.privKey = undefined;
            if (this.privKeyBytes) {
                this.privKeyBytes.fill(0);
                this.privKeyBytes = undefined;
            }
            return this;
        }
        toJSON() {
            return {
                xpriv: this.privateExtendedKey,
                xpub: this.publicExtendedKey,
            };
        }
        serialize(version, key) {
            if (!this.chainCode) {
                throw new Error('No chainCode set');
            }
            bytes(key, 33);
            return concatBytes(toU32(version), new Uint8Array([this.depth]), toU32(this.parentFingerprint), toU32(this.index), this.chainCode, key);
        }
    }

    // HMAC (RFC 2104)
    class HMAC extends Hash$1 {
        constructor(hash, _key) {
            super();
            this.finished = false;
            this.destroyed = false;
            assertHash(hash);
            const key = toBytes$1(_key);
            this.iHash = hash.create();
            if (!(this.iHash instanceof Hash$1))
                throw new TypeError('Expected instance of class which extends utils.Hash');
            const blockLen = (this.blockLen = this.iHash.blockLen);
            this.outputLen = this.iHash.outputLen;
            const pad = new Uint8Array(blockLen);
            // blockLen can be bigger than outputLen
            pad.set(key.length > this.iHash.blockLen ? hash.create().update(key).digest() : key);
            for (let i = 0; i < pad.length; i++)
                pad[i] ^= 0x36;
            this.iHash.update(pad);
            // By doing update (processing of first block) of outer hash here we can re-use it between multiple calls via clone
            this.oHash = hash.create();
            // Undo internal XOR && apply outer XOR
            for (let i = 0; i < pad.length; i++)
                pad[i] ^= 0x36 ^ 0x5c;
            this.oHash.update(pad);
            pad.fill(0);
        }
        update(buf) {
            if (this.destroyed)
                throw new Error('instance is destroyed');
            this.iHash.update(buf);
            return this;
        }
        digestInto(out) {
            if (this.destroyed)
                throw new Error('instance is destroyed');
            if (!(out instanceof Uint8Array) || out.length !== this.outputLen)
                throw new Error('HMAC: Invalid output buffer');
            if (this.finished)
                throw new Error('digest() was already called');
            this.finished = true;
            this.iHash.digestInto(out);
            this.oHash.update(out);
            this.oHash.digestInto(out);
            this.destroy();
        }
        digest() {
            const out = new Uint8Array(this.oHash.outputLen);
            this.digestInto(out);
            return out;
        }
        _cloneInto(to) {
            // Create new instance without calling constructor since key already in state and we don't know it.
            to || (to = Object.create(Object.getPrototypeOf(this), {}));
            const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
            to = to;
            to.finished = finished;
            to.destroyed = destroyed;
            to.blockLen = blockLen;
            to.outputLen = outputLen;
            to.oHash = oHash._cloneInto(to.oHash);
            to.iHash = iHash._cloneInto(to.iHash);
            return to;
        }
        destroy() {
            this.destroyed = true;
            this.oHash.destroy();
            this.iHash.destroy();
        }
    }
    /**
     * HMAC: RFC2104 message authentication code.
     * @param hash - function that would be used e.g. sha256
     * @param key - message key
     * @param message - message data
     */
    const hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
    hmac.create = (hash, key) => new HMAC(hash, key);

    var __defProp = Object.defineProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    function generatePrivateKey() {
      return utils$1.bytesToHex(utils$1.randomPrivateKey());
    }
    function getPublicKey(privateKey) {
      return utils$1.bytesToHex(schnorr.getPublicKey(privateKey));
    }

    // utils.ts
    var utils_exports = {};
    __export(utils_exports, {
      insertEventIntoAscendingList: () => insertEventIntoAscendingList,
      insertEventIntoDescendingList: () => insertEventIntoDescendingList,
      normalizeURL: () => normalizeURL,
      utf8Decoder: () => utf8Decoder,
      utf8Encoder: () => utf8Encoder
    });
    var utf8Decoder = new TextDecoder("utf-8");
    var utf8Encoder = new TextEncoder();
    function normalizeURL(url) {
      let p = new URL(url);
      p.pathname = p.pathname.replace(/\/+/g, "/");
      if (p.pathname.endsWith("/"))
        p.pathname = p.pathname.slice(0, -1);
      if (p.port === "80" && p.protocol === "ws:" || p.port === "443" && p.protocol === "wss:")
        p.port = "";
      p.searchParams.sort();
      p.hash = "";
      return p.toString();
    }
    function insertEventIntoDescendingList(sortedArray, event) {
      let start = 0;
      let end = sortedArray.length - 1;
      let midPoint;
      let position = start;
      if (end < 0) {
        position = 0;
      } else if (event.created_at < sortedArray[end].created_at) {
        position = end + 1;
      } else if (event.created_at >= sortedArray[start].created_at) {
        position = start;
      } else
        while (true) {
          if (end <= start + 1) {
            position = end;
            break;
          }
          midPoint = Math.floor(start + (end - start) / 2);
          if (sortedArray[midPoint].created_at > event.created_at) {
            start = midPoint;
          } else if (sortedArray[midPoint].created_at < event.created_at) {
            end = midPoint;
          } else {
            position = midPoint;
            break;
          }
        }
      if (sortedArray[position]?.id !== event.id) {
        return [
          ...sortedArray.slice(0, position),
          event,
          ...sortedArray.slice(position)
        ];
      }
      return sortedArray;
    }
    function insertEventIntoAscendingList(sortedArray, event) {
      let start = 0;
      let end = sortedArray.length - 1;
      let midPoint;
      let position = start;
      if (end < 0) {
        position = 0;
      } else if (event.created_at > sortedArray[end].created_at) {
        position = end + 1;
      } else if (event.created_at <= sortedArray[start].created_at) {
        position = start;
      } else
        while (true) {
          if (end <= start + 1) {
            position = end;
            break;
          }
          midPoint = Math.floor(start + (end - start) / 2);
          if (sortedArray[midPoint].created_at < event.created_at) {
            start = midPoint;
          } else if (sortedArray[midPoint].created_at > event.created_at) {
            end = midPoint;
          } else {
            position = midPoint;
            break;
          }
        }
      if (sortedArray[position]?.id !== event.id) {
        return [
          ...sortedArray.slice(0, position),
          event,
          ...sortedArray.slice(position)
        ];
      }
      return sortedArray;
    }
    function serializeEvent(evt) {
      if (!validateEvent(evt))
        throw new Error("can't serialize event with wrong or missing properties");
      return JSON.stringify([
        0,
        evt.pubkey,
        evt.created_at,
        evt.kind,
        evt.tags,
        evt.content
      ]);
    }
    function getEventHash(event) {
      let eventHash = sha256$2(utf8Encoder.encode(serializeEvent(event)));
      return utils$1.bytesToHex(eventHash);
    }
    function validateEvent(event) {
      if (typeof event !== "object")
        return false;
      if (typeof event.kind !== "number")
        return false;
      if (typeof event.content !== "string")
        return false;
      if (typeof event.created_at !== "number")
        return false;
      if (typeof event.pubkey !== "string")
        return false;
      if (!event.pubkey.match(/^[a-f0-9]{64}$/))
        return false;
      if (!Array.isArray(event.tags))
        return false;
      for (let i = 0; i < event.tags.length; i++) {
        let tag = event.tags[i];
        if (!Array.isArray(tag))
          return false;
        for (let j = 0; j < tag.length; j++) {
          if (typeof tag[j] === "object")
            return false;
        }
      }
      return true;
    }
    function verifySignature(event) {
      return schnorr.verifySync(
        event.sig,
        getEventHash(event),
        event.pubkey
      );
    }
    function signEvent(event, key) {
      return utils$1.bytesToHex(
        schnorr.signSync(getEventHash(event), key)
      );
    }

    // filter.ts
    function matchFilter(filter, event) {
      if (filter.ids && filter.ids.indexOf(event.id) === -1)
        return false;
      if (filter.kinds && filter.kinds.indexOf(event.kind) === -1)
        return false;
      if (filter.authors && filter.authors.indexOf(event.pubkey) === -1)
        return false;
      for (let f in filter) {
        if (f[0] === "#") {
          let tagName = f.slice(1);
          let values = filter[`#${tagName}`];
          if (values && !event.tags.find(
            ([t, v]) => t === f.slice(1) && values.indexOf(v) !== -1
          ))
            return false;
        }
      }
      if (filter.since && event.created_at < filter.since)
        return false;
      if (filter.until && event.created_at >= filter.until)
        return false;
      return true;
    }
    function matchFilters(filters, event) {
      for (let i = 0; i < filters.length; i++) {
        if (matchFilter(filters[i], event))
          return true;
      }
      return false;
    }

    // fakejson.ts
    var fakejson_exports = {};
    __export(fakejson_exports, {
      getHex64: () => getHex64,
      getInt: () => getInt,
      getSubscriptionId: () => getSubscriptionId,
      matchEventId: () => matchEventId,
      matchEventKind: () => matchEventKind,
      matchEventPubkey: () => matchEventPubkey
    });
    function getHex64(json, field) {
      let len = field.length + 3;
      let idx = json.indexOf(`"${field}":`) + len;
      let s = json.slice(idx).indexOf(`"`) + idx + 1;
      return json.slice(s, s + 64);
    }
    function getInt(json, field) {
      let len = field.length;
      let idx = json.indexOf(`"${field}":`) + len + 3;
      let sliced = json.slice(idx);
      let end = Math.min(sliced.indexOf(","), sliced.indexOf("}"));
      return parseInt(sliced.slice(0, end), 10);
    }
    function getSubscriptionId(json) {
      let idx = json.slice(0, 22).indexOf(`"EVENT"`);
      if (idx === -1)
        return null;
      let pstart = json.slice(idx + 7 + 1).indexOf(`"`);
      if (pstart === -1)
        return null;
      let start = idx + 7 + 1 + pstart;
      let pend = json.slice(start + 1, 80).indexOf(`"`);
      if (pend === -1)
        return null;
      let end = start + 1 + pend;
      return json.slice(start + 1, end);
    }
    function matchEventId(json, id) {
      return id === getHex64(json, "id");
    }
    function matchEventPubkey(json, pubkey) {
      return pubkey === getHex64(json, "pubkey");
    }
    function matchEventKind(json, kind) {
      return kind === getInt(json, "kind");
    }

    // relay.ts
    function relayInit(url, options = {}) {
      let { listTimeout = 3e3, getTimeout = 3e3 } = options;
      var ws;
      var openSubs = {};
      var listeners = {
        connect: [],
        disconnect: [],
        error: [],
        notice: []
      };
      var subListeners = {};
      var pubListeners = {};
      async function connectRelay() {
        return new Promise((resolve, reject) => {
          ws = new WebSocket(url);
          ws.onopen = () => {
            listeners.connect.forEach((cb) => cb());
            resolve();
          };
          ws.onerror = () => {
            listeners.error.forEach((cb) => cb());
            reject();
          };
          ws.onclose = async () => {
            listeners.disconnect.forEach((cb) => cb());
          };
          let incomingMessageQueue = [];
          let handleNextInterval;
          ws.onmessage = (e) => {
            incomingMessageQueue.push(e.data);
            if (!handleNextInterval) {
              handleNextInterval = setInterval(handleNext, 0);
            }
          };
          function handleNext() {
            if (incomingMessageQueue.length === 0) {
              clearInterval(handleNextInterval);
              handleNextInterval = null;
              return;
            }
            var json = incomingMessageQueue.shift();
            if (!json)
              return;
            let subid = getSubscriptionId(json);
            if (subid) {
              let so = openSubs[subid];
              if (so && so.alreadyHaveEvent && so.alreadyHaveEvent(getHex64(json, "id"), url)) {
                return;
              }
            }
            try {
              let data = JSON.parse(json);
              switch (data[0]) {
                case "EVENT":
                  let id = data[1];
                  let event = data[2];
                  if (validateEvent(event) && openSubs[id] && (openSubs[id].skipVerification || verifySignature(event)) && matchFilters(openSubs[id].filters, event)) {
                    openSubs[id];
                    (subListeners[id]?.event || []).forEach((cb) => cb(event));
                  }
                  return;
                case "EOSE": {
                  let id2 = data[1];
                  if (id2 in subListeners) {
                    subListeners[id2].eose.forEach((cb) => cb());
                    subListeners[id2].eose = [];
                  }
                  return;
                }
                case "OK": {
                  let id2 = data[1];
                  let ok = data[2];
                  let reason = data[3] || "";
                  if (id2 in pubListeners) {
                    if (ok)
                      pubListeners[id2].ok.forEach((cb) => cb());
                    else
                      pubListeners[id2].failed.forEach((cb) => cb(reason));
                    pubListeners[id2].ok = [];
                    pubListeners[id2].failed = [];
                  }
                  return;
                }
                case "NOTICE":
                  let notice = data[1];
                  listeners.notice.forEach((cb) => cb(notice));
                  return;
              }
            } catch (err) {
              return;
            }
          }
        });
      }
      function connected() {
        return ws?.readyState === 1;
      }
      async function connect() {
        if (connected())
          return;
        await connectRelay();
      }
      async function trySend(params) {
        let msg = JSON.stringify(params);
        if (!connected()) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
          if (!connected()) {
            return;
          }
        }
        try {
          ws.send(msg);
        } catch (err) {
          console.log(err);
        }
      }
      const sub = (filters, {
        skipVerification = false,
        alreadyHaveEvent = null,
        id = Math.random().toString().slice(2)
      } = {}) => {
        let subid = id;
        openSubs[subid] = {
          id: subid,
          filters,
          skipVerification,
          alreadyHaveEvent
        };
        trySend(["REQ", subid, ...filters]);
        return {
          sub: (newFilters, newOpts = {}) => sub(newFilters || filters, {
            skipVerification: newOpts.skipVerification || skipVerification,
            alreadyHaveEvent: newOpts.alreadyHaveEvent || alreadyHaveEvent,
            id: subid
          }),
          unsub: () => {
            delete openSubs[subid];
            delete subListeners[subid];
            trySend(["CLOSE", subid]);
          },
          on: (type, cb) => {
            subListeners[subid] = subListeners[subid] || {
              event: [],
              eose: []
            };
            subListeners[subid][type].push(cb);
          },
          off: (type, cb) => {
            let listeners2 = subListeners[subid];
            let idx = listeners2[type].indexOf(cb);
            if (idx >= 0)
              listeners2[type].splice(idx, 1);
          }
        };
      };
      return {
        url,
        sub,
        on: (type, cb) => {
          listeners[type].push(cb);
          if (type === "connect" && ws?.readyState === 1) {
            cb();
          }
        },
        off: (type, cb) => {
          let index = listeners[type].indexOf(cb);
          if (index !== -1)
            listeners[type].splice(index, 1);
        },
        list: (filters, opts) => new Promise((resolve) => {
          let s = sub(filters, opts);
          let events = [];
          let timeout = setTimeout(() => {
            s.unsub();
            resolve(events);
          }, listTimeout);
          s.on("eose", () => {
            s.unsub();
            clearTimeout(timeout);
            resolve(events);
          });
          s.on("event", (event) => {
            events.push(event);
          });
        }),
        get: (filter, opts) => new Promise((resolve) => {
          let s = sub([filter], opts);
          let timeout = setTimeout(() => {
            s.unsub();
            resolve(null);
          }, getTimeout);
          s.on("event", (event) => {
            s.unsub();
            clearTimeout(timeout);
            resolve(event);
          });
        }),
        publish(event) {
          if (!event.id)
            throw new Error(`event ${event} has no id`);
          let id = event.id;
          trySend(["EVENT", event]);
          return {
            on: (type, cb) => {
              pubListeners[id] = pubListeners[id] || {
                ok: [],
                failed: []
              };
              pubListeners[id][type].push(cb);
            },
            off: (type, cb) => {
              let listeners2 = pubListeners[id];
              if (!listeners2)
                return;
              let idx = listeners2[type].indexOf(cb);
              if (idx >= 0)
                listeners2[type].splice(idx, 1);
            }
          };
        },
        connect,
        close() {
          listeners = { connect: [], disconnect: [], error: [], notice: [] };
          subListeners = {};
          pubListeners = {};
          ws?.close();
        },
        get status() {
          return ws?.readyState ?? 3;
        }
      };
    }

    // nip04.ts
    var nip04_exports = {};
    __export(nip04_exports, {
      decrypt: () => decrypt,
      encrypt: () => encrypt
    });
    async function encrypt(privkey, pubkey, text) {
      const key = getSharedSecret(privkey, "02" + pubkey);
      const normalizedKey = getNormalizedX(key);
      let iv = Uint8Array.from(randomBytes(16));
      let plaintext = utf8Encoder.encode(text);
      let cryptoKey = await crypto.subtle.importKey(
        "raw",
        normalizedKey,
        { name: "AES-CBC" },
        false,
        ["encrypt"]
      );
      let ciphertext = await crypto.subtle.encrypt(
        { name: "AES-CBC", iv },
        cryptoKey,
        plaintext
      );
      let ctb64 = base64.encode(new Uint8Array(ciphertext));
      let ivb64 = base64.encode(new Uint8Array(iv.buffer));
      return `${ctb64}?iv=${ivb64}`;
    }
    async function decrypt(privkey, pubkey, data) {
      let [ctb64, ivb64] = data.split("?iv=");
      let key = getSharedSecret(privkey, "02" + pubkey);
      let normalizedKey = getNormalizedX(key);
      let cryptoKey = await crypto.subtle.importKey(
        "raw",
        normalizedKey,
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      let ciphertext = base64.decode(ctb64);
      let iv = base64.decode(ivb64);
      let plaintext = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv },
        cryptoKey,
        ciphertext
      );
      let text = utf8Decoder.decode(plaintext);
      return text;
    }
    function getNormalizedX(key) {
      return key.slice(1, 33);
    }

    // nip05.ts
    var nip05_exports = {};
    __export(nip05_exports, {
      queryProfile: () => queryProfile,
      searchDomain: () => searchDomain,
      useFetchImplementation: () => useFetchImplementation
    });
    var _fetch;
    try {
      _fetch = fetch;
    } catch {
    }
    function useFetchImplementation(fetchImplementation) {
      _fetch = fetchImplementation;
    }
    async function searchDomain(domain, query = "") {
      try {
        let res = await (await _fetch(`https://${domain}/.well-known/nostr.json?name=${query}`)).json();
        return res.names;
      } catch (_) {
        return {};
      }
    }
    async function queryProfile(fullname) {
      let [name, domain] = fullname.split("@");
      if (!domain) {
        domain = name;
        name = "_";
      }
      if (!name.match(/^[A-Za-z0-9-_]+$/))
        return null;
      let res;
      try {
        res = await (await _fetch(`https://${domain}/.well-known/nostr.json?name=${name}`)).json();
      } catch (err) {
        return null;
      }
      if (!res?.names?.[name])
        return null;
      let pubkey = res.names[name];
      let relays = res.relays?.[pubkey] || [];
      return {
        pubkey,
        relays
      };
    }

    // nip06.ts
    var nip06_exports = {};
    __export(nip06_exports, {
      generateSeedWords: () => generateSeedWords,
      privateKeyFromSeedWords: () => privateKeyFromSeedWords,
      validateWords: () => validateWords
    });
    function privateKeyFromSeedWords(mnemonic, passphrase) {
      let root = HDKey.fromMasterSeed(mnemonicToSeedSync_1(mnemonic, passphrase));
      let privateKey = root.derive(`m/44'/1237'/0'/0/0`).privateKey;
      if (!privateKey)
        throw new Error("could not derive private key");
      return utils$1.bytesToHex(privateKey);
    }
    function generateSeedWords() {
      return generateMnemonic_1(wordlist);
    }
    function validateWords(words) {
      return validateMnemonic_1(words, wordlist);
    }

    // nip19.ts
    var nip19_exports = {};
    __export(nip19_exports, {
      decode: () => decode,
      naddrEncode: () => naddrEncode,
      neventEncode: () => neventEncode,
      noteEncode: () => noteEncode,
      nprofileEncode: () => nprofileEncode,
      npubEncode: () => npubEncode,
      nsecEncode: () => nsecEncode
    });
    var Bech32MaxSize = 5e3;
    function decode(nip19) {
      let { prefix, words } = bech32.decode(nip19, Bech32MaxSize);
      let data = new Uint8Array(bech32.fromWords(words));
      switch (prefix) {
        case "nprofile": {
          let tlv = parseTLV(data);
          if (!tlv[0]?.[0])
            throw new Error("missing TLV 0 for nprofile");
          if (tlv[0][0].length !== 32)
            throw new Error("TLV 0 should be 32 bytes");
          return {
            type: "nprofile",
            data: {
              pubkey: utils$1.bytesToHex(tlv[0][0]),
              relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : []
            }
          };
        }
        case "nevent": {
          let tlv = parseTLV(data);
          if (!tlv[0]?.[0])
            throw new Error("missing TLV 0 for nevent");
          if (tlv[0][0].length !== 32)
            throw new Error("TLV 0 should be 32 bytes");
          return {
            type: "nevent",
            data: {
              id: utils$1.bytesToHex(tlv[0][0]),
              relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : []
            }
          };
        }
        case "naddr": {
          let tlv = parseTLV(data);
          if (!tlv[0]?.[0])
            throw new Error("missing TLV 0 for naddr");
          if (!tlv[2]?.[0])
            throw new Error("missing TLV 2 for naddr");
          if (tlv[2][0].length !== 32)
            throw new Error("TLV 2 should be 32 bytes");
          if (!tlv[3]?.[0])
            throw new Error("missing TLV 3 for naddr");
          if (tlv[3][0].length !== 4)
            throw new Error("TLV 3 should be 4 bytes");
          return {
            type: "naddr",
            data: {
              identifier: utf8Decoder.decode(tlv[0][0]),
              pubkey: utils$1.bytesToHex(tlv[2][0]),
              kind: parseInt(utils$1.bytesToHex(tlv[3][0]), 16),
              relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : []
            }
          };
        }
        case "nsec":
        case "npub":
        case "note":
          return { type: prefix, data: utils$1.bytesToHex(data) };
        default:
          throw new Error(`unknown prefix ${prefix}`);
      }
    }
    function parseTLV(data) {
      let result = {};
      let rest = data;
      while (rest.length > 0) {
        let t = rest[0];
        let l = rest[1];
        let v = rest.slice(2, 2 + l);
        rest = rest.slice(2 + l);
        if (v.length < l)
          continue;
        result[t] = result[t] || [];
        result[t].push(v);
      }
      return result;
    }
    function nsecEncode(hex) {
      return encodeBytes("nsec", hex);
    }
    function npubEncode(hex) {
      return encodeBytes("npub", hex);
    }
    function noteEncode(hex) {
      return encodeBytes("note", hex);
    }
    function encodeBytes(prefix, hex) {
      let data = utils$1.hexToBytes(hex);
      let words = bech32.toWords(data);
      return bech32.encode(prefix, words, Bech32MaxSize);
    }
    function nprofileEncode(profile) {
      let data = encodeTLV({
        0: [utils$1.hexToBytes(profile.pubkey)],
        1: (profile.relays || []).map((url) => utf8Encoder.encode(url))
      });
      let words = bech32.toWords(data);
      return bech32.encode("nprofile", words, Bech32MaxSize);
    }
    function neventEncode(event) {
      let data = encodeTLV({
        0: [utils$1.hexToBytes(event.id)],
        1: (event.relays || []).map((url) => utf8Encoder.encode(url))
      });
      let words = bech32.toWords(data);
      return bech32.encode("nevent", words, Bech32MaxSize);
    }
    function naddrEncode(addr) {
      let kind = new ArrayBuffer(4);
      new DataView(kind).setUint32(0, addr.kind, false);
      let data = encodeTLV({
        0: [utf8Encoder.encode(addr.identifier)],
        1: (addr.relays || []).map((url) => utf8Encoder.encode(url)),
        2: [utils$1.hexToBytes(addr.pubkey)],
        3: [new Uint8Array(kind)]
      });
      let words = bech32.toWords(data);
      return bech32.encode("naddr", words, Bech32MaxSize);
    }
    function encodeTLV(tlv) {
      let entries = [];
      Object.entries(tlv).forEach(([t, vs]) => {
        vs.forEach((v) => {
          let entry = new Uint8Array(v.length + 2);
          entry.set([parseInt(t)], 0);
          entry.set([v.length], 1);
          entry.set(v, 2);
          entries.push(entry);
        });
      });
      return utils$1.concatBytes(...entries);
    }

    // nip26.ts
    var nip26_exports = {};
    __export(nip26_exports, {
      createDelegation: () => createDelegation,
      getDelegator: () => getDelegator
    });
    function createDelegation(privateKey, parameters) {
      let conditions = [];
      if ((parameters.kind || -1) >= 0)
        conditions.push(`kind=${parameters.kind}`);
      if (parameters.until)
        conditions.push(`created_at<${parameters.until}`);
      if (parameters.since)
        conditions.push(`created_at>${parameters.since}`);
      let cond = conditions.join("&");
      if (cond === "")
        throw new Error("refusing to create a delegation without any conditions");
      let sighash = sha256$2(
        utf8Encoder.encode(`nostr:delegation:${parameters.pubkey}:${cond}`)
      );
      let sig = utils$1.bytesToHex(
        schnorr.signSync(sighash, privateKey)
      );
      return {
        from: getPublicKey(privateKey),
        to: parameters.pubkey,
        cond,
        sig
      };
    }
    function getDelegator(event) {
      let tag = event.tags.find((tag2) => tag2[0] === "delegation" && tag2.length >= 4);
      if (!tag)
        return null;
      let pubkey = tag[1];
      let cond = tag[2];
      let sig = tag[3];
      let conditions = cond.split("&");
      for (let i = 0; i < conditions.length; i++) {
        let [key, operator, value] = conditions[i].split(/\b/);
        if (key === "kind" && operator === "=" && event.kind === parseInt(value))
          continue;
        else if (key === "created_at" && operator === "<" && event.created_at < parseInt(value))
          continue;
        else if (key === "created_at" && operator === ">" && event.created_at > parseInt(value))
          continue;
        else
          return null;
      }
      let sighash = sha256$2(
        utf8Encoder.encode(`nostr:delegation:${event.pubkey}:${cond}`)
      );
      if (!schnorr.verifySync(sig, sighash, pubkey))
        return null;
      return pubkey;
    }

    // nip57.ts
    var nip57_exports = {};
    __export(nip57_exports, {
      getZapEndpoint: () => getZapEndpoint,
      makeZapReceipt: () => makeZapReceipt,
      makeZapRequest: () => makeZapRequest,
      useFetchImplementation: () => useFetchImplementation2,
      validateZapRequest: () => validateZapRequest
    });
    var _fetch2;
    try {
      _fetch2 = fetch;
    } catch {
    }
    function useFetchImplementation2(fetchImplementation) {
      _fetch2 = fetchImplementation;
    }
    async function getZapEndpoint(metadata) {
      try {
        let lnurl = "";
        let { lud06, lud16 } = JSON.parse(metadata.content);
        if (lud06) {
          let { words } = bech32.decode(lud06, 1e3);
          let data = bech32.fromWords(words);
          lnurl = utf8Decoder.decode(data);
        } else if (lud16) {
          let [name, domain] = lud16.split("@");
          lnurl = `https://${domain}/.well-known/lnurlp/${name}`;
        } else {
          return null;
        }
        let res = await _fetch2(lnurl);
        let body = await res.json();
        if (body.allowsNostr && body.nostrPubkey) {
          return body.callback;
        }
      } catch (err) {
      }
      return null;
    }
    function makeZapRequest({
      profile,
      event,
      amount,
      relays,
      comment = ""
    }) {
      if (!amount)
        throw new Error("amount not given");
      if (!profile)
        throw new Error("profile not given");
      let zr = {
        kind: 9734,
        created_at: Math.round(Date.now() / 1e3),
        content: comment,
        tags: [
          ["p", profile],
          ["amount", amount.toString()],
          ["relays", ...relays]
        ]
      };
      if (event) {
        zr.tags.push(["e", event]);
      }
      return zr;
    }
    function validateZapRequest(zapRequestString) {
      let zapRequest;
      try {
        zapRequest = JSON.parse(zapRequestString);
      } catch (err) {
        return "Invalid zap request JSON.";
      }
      if (!validateEvent(zapRequest))
        return "Zap request is not a valid Nostr event.";
      if (!verifySignature(zapRequest))
        return "Invalid signature on zap request.";
      let p = zapRequest.tags.find(([t, v]) => t === "p" && v);
      if (!p)
        return "Zap request doesn't have a 'p' tag.";
      if (!p[1].match(/^[a-f0-9]{64}$/))
        return "Zap request 'p' tag is not valid hex.";
      let e = zapRequest.tags.find(([t, v]) => t === "e" && v);
      if (e && !e[1].match(/^[a-f0-9]{64}$/))
        return "Zap request 'e' tag is not valid hex.";
      let relays = zapRequest.tags.find(([t, v]) => t === "relays" && v);
      if (!relays)
        return "Zap request doesn't have a 'relays' tag.";
      return null;
    }
    function makeZapReceipt({
      zapRequest,
      preimage,
      bolt11,
      paidAt
    }) {
      let zr = JSON.parse(zapRequest);
      let tagsFromZapRequest = zr.tags.filter(
        ([t]) => t === "e" || t === "p" || t === "a"
      );
      let zap = {
        kind: 9735,
        created_at: Math.round(paidAt.getTime() / 1e3),
        content: "",
        tags: [
          ...tagsFromZapRequest,
          ["bolt11", bolt11],
          ["description", zapRequest]
        ]
      };
      if (preimage) {
        zap.tags.push(["preimage", preimage]);
      }
      return zap;
    }
    utils$1.hmacSha256Sync = (key, ...msgs) => hmac(sha256$2, key, utils$1.concatBytes(...msgs));
    utils$1.sha256Sync = (...msgs) => sha256$2(utils$1.concatBytes(...msgs));

    const WS = WebSocket;// typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

    Relay$1.prototype.wait_connected = async function relay_wait_connected(data) {
    	let retry = 1000;
    	while (true) {
    		if (this.ws.readyState !== 1) {
    			await sleep(retry);
    			retry *= 1.5;
    		}
    		else {
    			return
    		}
    	}
    };


    function Relay$1(relay, opts={})
    {
    	if (!(this instanceof Relay$1))
    		return new Relay$1(relay, opts)

    	this.url = relay;
    	this.opts = opts;

    	if (opts.reconnect == null)
    		opts.reconnect = true;

    	const me = this;
    	me.onfn = {};

    	init_websocket(me)
    		.catch(e => {
    			if (me.onfn.error)
    				me.onfn.error(e);
    		});

    	return this
    }

    function init_websocket(me) {
    	return new Promise((resolve, reject) => {
    		const ws = me.ws = new WS(me.url);

    		let resolved = false;
    		ws.onmessage = (m) => {
    			handle_nostr_message(me, m);
    			if (me.onfn.message)
    				me.onfn.message(m);
    		};
    		ws.onclose = (e) => {
    			if (me.onfn.close)
    				me.onfn.close(e);
    			if (me.reconnecting)
    				return reject(new Error("close during reconnect"))
    			if (!me.manualClose && me.opts.reconnect)
    				reconnect(me);
    		};
    		ws.onerror = (e) => {
    			if (me.onfn.error)
    				me.onfn.error(e);
    			if (me.reconnecting)
    				return reject(new Error("error during reconnect"))
    			if (me.opts.reconnect)
    				reconnect(me);
    		};
    		ws.onopen = (e) => {
    			if (me.onfn.open)
    				me.onfn.open(e);

    			if (resolved) return

    			resolved = true;
    			resolve(me);
    		};
    	});
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function reconnect(me)
    {
    	let n = 100;
    	try {
    		me.reconnecting = true;
    		await init_websocket(me);
    		me.reconnecting = false;
    	} catch {
    		//console.error(`error thrown during reconnect... trying again in ${n} ms`)
    		await sleep(n);
    		n *= 1.5;
    	}
    }

    Relay$1.prototype.on = function relayOn(method, fn) {
    	this.onfn[method] = fn;
    	return this
    };

    Relay$1.prototype.close = function relayClose() {
    	if (this.ws) {
    		this.manualClose = true;
    		this.ws.close();
    	}
    };

    Relay$1.prototype.subscribe = function relay_subscribe(sub_id, filters) {
    	if (Array.isArray(filters))
    		this.send(["REQ", sub_id, ...filters]);
    	else
    		this.send(["REQ", sub_id, filters]);
    };

    Relay$1.prototype.unsubscribe = function relay_unsubscribe(sub_id) {
    	this.send(["CLOSE", sub_id]);
    };

    Relay$1.prototype.send = async function relay_send(data) {
    	await this.wait_connected();
    	this.ws.send(JSON.stringify(data));
    };

    function handle_nostr_message(relay, msg)
    {
    	let data;
    	try {
    		data = JSON.parse(msg.data);
    	} catch (e) {
    		console.error("handle_nostr_message", e);
    		return
    	}
    	if (data.length >= 2) {
    		switch (data[0]) {
    		case "EVENT":
    			if (data.length < 3)
    				return
    			return relay.onfn.event && relay.onfn.event(data[1], data[2])
    		case "EOSE":
    			return relay.onfn.eose && relay.onfn.eose(data[1])
    		case "NOTICE":
    			return relay.onfn.notice && relay.onfn.notice(...data.slice(1))
    		case "OK":
    			return relay.onfn.ok && relay.onfn.ok(...data.slice(1))
    		}
    	}
    }

    var relay = Relay$1;

    const Relay = relay;

    function RelayPool(relays, opts)
    {
    	if (!(this instanceof RelayPool))
    		return new RelayPool(relays, opts)

    	this.onfn = {};
    	this.relays = [];
    	this.opts = opts;

    	for (const relay of relays) {
    		this.add(relay);
    	}

    	return this
    }

    RelayPool.prototype.close = function relayPoolClose() {
    	for (const relay of this.relays) {
    		relay.close();
    	}
    };

    RelayPool.prototype.on = function relayPoolOn(method, fn) {
    	for (const relay of this.relays) {
    		this.onfn[method] = fn;
    		relay.onfn[method] = fn.bind(null, relay);
    	}
    	return this
    };

    RelayPool.prototype.has = function relayPoolHas(relayUrl) {
    	for (const relay of this.relays) {
    		if (relay.url === relayUrl)
    			return true
    	}

    	return false
    };

    RelayPool.prototype.send = function relayPoolSend(payload, relay_ids) {
    	const relays = relay_ids ? this.find_relays(relay_ids) : this.relays;
    	for (const relay of relays) {
    		relay.send(payload);
    	}
    };

    RelayPool.prototype.setupHandlers = function relayPoolSetupHandlers()
    {
    	// setup its message handlers with the ones we have already
    	const keys = Object.keys(this.onfn);
    	for (const handler of keys) {
    		for (const relay of this.relays) {
    			relay.onfn[handler] = this.onfn[handler].bind(null, relay);
    		}
    	}
    };

    RelayPool.prototype.remove = function relayPoolRemove(url) {
    	let i = 0;

    	for (const relay of this.relays) {
    		if (relay.url === url) {
    			relay.ws && relay.ws.close();
    			this.relays = this.replays.splice(i, 1);
    			return true
    		}

    		i += 1;
    	}

    	return false
    };

    RelayPool.prototype.subscribe = function relayPoolSubscribe(sub_id, filters, relay_ids) {
    	const relays = relay_ids ? this.find_relays(relay_ids) : this.relays;
    	for (const relay of relays) {
    		relay.subscribe(sub_id, filters);
    	}
    };

    RelayPool.prototype.unsubscribe = function relayPoolUnsubscibe(sub_id, relay_ids) {
    	const relays = relay_ids ? this.find_relays(relay_ids) : this.relays;
    	for (const relay of relays) {
    		relay.unsubscribe(sub_id);
    	}
    };


    RelayPool.prototype.add = function relayPoolAdd(relay) {
    	if (relay instanceof Relay) {
    		if (this.has(relay.url))
    			return false

    		this.relays.push(relay);
    		this.setupHandlers();
    		return true
    	}

    	if (this.has(relay))
    		return false

    	const r = Relay(relay, this.opts);
    	this.relays.push(r);
    	this.setupHandlers();
    	return true
    };

    RelayPool.prototype.find_relays = function relayPoolFindRelays(relay_ids) {
    	if (relay_ids instanceof Relay)
    		return [relay_ids]

    	if (relay_ids.length === 0)
    		return []

    	if (!relay_ids[0])
    		throw new Error("what!?")

    	if (relay_ids[0] instanceof Relay)
    		return relay_ids

    	return this.relays.reduce((acc, relay) => {
    		if (relay_ids.some((rid) => relay.url === rid))
    			acc.push(relay);
    		return acc
    	}, [])
    };

    var relayPool = RelayPool;

    var eventsExports = {};
    var events = {
      get exports(){ return eventsExports; },
      set exports(v){ eventsExports = v; },
    };

    var R = typeof Reflect === 'object' ? Reflect : null;
    var ReflectApply = R && typeof R.apply === 'function'
      ? R.apply
      : function ReflectApply(target, receiver, args) {
        return Function.prototype.apply.call(target, receiver, args);
      };

    var ReflectOwnKeys;
    if (R && typeof R.ownKeys === 'function') {
      ReflectOwnKeys = R.ownKeys;
    } else if (Object.getOwnPropertySymbols) {
      ReflectOwnKeys = function ReflectOwnKeys(target) {
        return Object.getOwnPropertyNames(target)
          .concat(Object.getOwnPropertySymbols(target));
      };
    } else {
      ReflectOwnKeys = function ReflectOwnKeys(target) {
        return Object.getOwnPropertyNames(target);
      };
    }

    function ProcessEmitWarning(warning) {
      if (console && console.warn) console.warn(warning);
    }

    var NumberIsNaN = Number.isNaN || function NumberIsNaN(value) {
      return value !== value;
    };

    function EventEmitter() {
      EventEmitter.init.call(this);
    }
    events.exports = EventEmitter;
    eventsExports.once = once;

    // Backwards-compat with node 0.10.x
    EventEmitter.EventEmitter = EventEmitter;

    EventEmitter.prototype._events = undefined;
    EventEmitter.prototype._eventsCount = 0;
    EventEmitter.prototype._maxListeners = undefined;

    // By default EventEmitters will print a warning if more than 10 listeners are
    // added to it. This is a useful default which helps finding memory leaks.
    var defaultMaxListeners = 10;

    function checkListener(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
      }
    }

    Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
      enumerable: true,
      get: function() {
        return defaultMaxListeners;
      },
      set: function(arg) {
        if (typeof arg !== 'number' || arg < 0 || NumberIsNaN(arg)) {
          throw new RangeError('The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ' + arg + '.');
        }
        defaultMaxListeners = arg;
      }
    });

    EventEmitter.init = function() {

      if (this._events === undefined ||
          this._events === Object.getPrototypeOf(this)._events) {
        this._events = Object.create(null);
        this._eventsCount = 0;
      }

      this._maxListeners = this._maxListeners || undefined;
    };

    // Obviously not all Emitters should be limited to 10. This function allows
    // that to be increased. Set to zero for unlimited.
    EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
      if (typeof n !== 'number' || n < 0 || NumberIsNaN(n)) {
        throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + n + '.');
      }
      this._maxListeners = n;
      return this;
    };

    function _getMaxListeners(that) {
      if (that._maxListeners === undefined)
        return EventEmitter.defaultMaxListeners;
      return that._maxListeners;
    }

    EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
      return _getMaxListeners(this);
    };

    EventEmitter.prototype.emit = function emit(type) {
      var args = [];
      for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
      var doError = (type === 'error');

      var events = this._events;
      if (events !== undefined)
        doError = (doError && events.error === undefined);
      else if (!doError)
        return false;

      // If there is no 'error' event listener then throw.
      if (doError) {
        var er;
        if (args.length > 0)
          er = args[0];
        if (er instanceof Error) {
          // Note: The comments on the `throw` lines are intentional, they show
          // up in Node's output if this results in an unhandled exception.
          throw er; // Unhandled 'error' event
        }
        // At least give some kind of context to the user
        var err = new Error('Unhandled error.' + (er ? ' (' + er.message + ')' : ''));
        err.context = er;
        throw err; // Unhandled 'error' event
      }

      var handler = events[type];

      if (handler === undefined)
        return false;

      if (typeof handler === 'function') {
        ReflectApply(handler, this, args);
      } else {
        var len = handler.length;
        var listeners = arrayClone(handler, len);
        for (var i = 0; i < len; ++i)
          ReflectApply(listeners[i], this, args);
      }

      return true;
    };

    function _addListener(target, type, listener, prepend) {
      var m;
      var events;
      var existing;

      checkListener(listener);

      events = target._events;
      if (events === undefined) {
        events = target._events = Object.create(null);
        target._eventsCount = 0;
      } else {
        // To avoid recursion in the case that type === "newListener"! Before
        // adding it to the listeners, first emit "newListener".
        if (events.newListener !== undefined) {
          target.emit('newListener', type,
                      listener.listener ? listener.listener : listener);

          // Re-assign `events` because a newListener handler could have caused the
          // this._events to be assigned to a new object
          events = target._events;
        }
        existing = events[type];
      }

      if (existing === undefined) {
        // Optimize the case of one listener. Don't need the extra array object.
        existing = events[type] = listener;
        ++target._eventsCount;
      } else {
        if (typeof existing === 'function') {
          // Adding the second element, need to change to array.
          existing = events[type] =
            prepend ? [listener, existing] : [existing, listener];
          // If we've already got an array, just append.
        } else if (prepend) {
          existing.unshift(listener);
        } else {
          existing.push(listener);
        }

        // Check for listener leak
        m = _getMaxListeners(target);
        if (m > 0 && existing.length > m && !existing.warned) {
          existing.warned = true;
          // No error code for this since it is a Warning
          // eslint-disable-next-line no-restricted-syntax
          var w = new Error('Possible EventEmitter memory leak detected. ' +
                              existing.length + ' ' + String(type) + ' listeners ' +
                              'added. Use emitter.setMaxListeners() to ' +
                              'increase limit');
          w.name = 'MaxListenersExceededWarning';
          w.emitter = target;
          w.type = type;
          w.count = existing.length;
          ProcessEmitWarning(w);
        }
      }

      return target;
    }

    EventEmitter.prototype.addListener = function addListener(type, listener) {
      return _addListener(this, type, listener, false);
    };

    EventEmitter.prototype.on = EventEmitter.prototype.addListener;

    EventEmitter.prototype.prependListener =
        function prependListener(type, listener) {
          return _addListener(this, type, listener, true);
        };

    function onceWrapper() {
      if (!this.fired) {
        this.target.removeListener(this.type, this.wrapFn);
        this.fired = true;
        if (arguments.length === 0)
          return this.listener.call(this.target);
        return this.listener.apply(this.target, arguments);
      }
    }

    function _onceWrap(target, type, listener) {
      var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
      var wrapped = onceWrapper.bind(state);
      wrapped.listener = listener;
      state.wrapFn = wrapped;
      return wrapped;
    }

    EventEmitter.prototype.once = function once(type, listener) {
      checkListener(listener);
      this.on(type, _onceWrap(this, type, listener));
      return this;
    };

    EventEmitter.prototype.prependOnceListener =
        function prependOnceListener(type, listener) {
          checkListener(listener);
          this.prependListener(type, _onceWrap(this, type, listener));
          return this;
        };

    // Emits a 'removeListener' event if and only if the listener was removed.
    EventEmitter.prototype.removeListener =
        function removeListener(type, listener) {
          var list, events, position, i, originalListener;

          checkListener(listener);

          events = this._events;
          if (events === undefined)
            return this;

          list = events[type];
          if (list === undefined)
            return this;

          if (list === listener || list.listener === listener) {
            if (--this._eventsCount === 0)
              this._events = Object.create(null);
            else {
              delete events[type];
              if (events.removeListener)
                this.emit('removeListener', type, list.listener || listener);
            }
          } else if (typeof list !== 'function') {
            position = -1;

            for (i = list.length - 1; i >= 0; i--) {
              if (list[i] === listener || list[i].listener === listener) {
                originalListener = list[i].listener;
                position = i;
                break;
              }
            }

            if (position < 0)
              return this;

            if (position === 0)
              list.shift();
            else {
              spliceOne(list, position);
            }

            if (list.length === 1)
              events[type] = list[0];

            if (events.removeListener !== undefined)
              this.emit('removeListener', type, originalListener || listener);
          }

          return this;
        };

    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

    EventEmitter.prototype.removeAllListeners =
        function removeAllListeners(type) {
          var listeners, events, i;

          events = this._events;
          if (events === undefined)
            return this;

          // not listening for removeListener, no need to emit
          if (events.removeListener === undefined) {
            if (arguments.length === 0) {
              this._events = Object.create(null);
              this._eventsCount = 0;
            } else if (events[type] !== undefined) {
              if (--this._eventsCount === 0)
                this._events = Object.create(null);
              else
                delete events[type];
            }
            return this;
          }

          // emit removeListener for all listeners on all events
          if (arguments.length === 0) {
            var keys = Object.keys(events);
            var key;
            for (i = 0; i < keys.length; ++i) {
              key = keys[i];
              if (key === 'removeListener') continue;
              this.removeAllListeners(key);
            }
            this.removeAllListeners('removeListener');
            this._events = Object.create(null);
            this._eventsCount = 0;
            return this;
          }

          listeners = events[type];

          if (typeof listeners === 'function') {
            this.removeListener(type, listeners);
          } else if (listeners !== undefined) {
            // LIFO order
            for (i = listeners.length - 1; i >= 0; i--) {
              this.removeListener(type, listeners[i]);
            }
          }

          return this;
        };

    function _listeners(target, type, unwrap) {
      var events = target._events;

      if (events === undefined)
        return [];

      var evlistener = events[type];
      if (evlistener === undefined)
        return [];

      if (typeof evlistener === 'function')
        return unwrap ? [evlistener.listener || evlistener] : [evlistener];

      return unwrap ?
        unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
    }

    EventEmitter.prototype.listeners = function listeners(type) {
      return _listeners(this, type, true);
    };

    EventEmitter.prototype.rawListeners = function rawListeners(type) {
      return _listeners(this, type, false);
    };

    EventEmitter.listenerCount = function(emitter, type) {
      if (typeof emitter.listenerCount === 'function') {
        return emitter.listenerCount(type);
      } else {
        return listenerCount.call(emitter, type);
      }
    };

    EventEmitter.prototype.listenerCount = listenerCount;
    function listenerCount(type) {
      var events = this._events;

      if (events !== undefined) {
        var evlistener = events[type];

        if (typeof evlistener === 'function') {
          return 1;
        } else if (evlistener !== undefined) {
          return evlistener.length;
        }
      }

      return 0;
    }

    EventEmitter.prototype.eventNames = function eventNames() {
      return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
    };

    function arrayClone(arr, n) {
      var copy = new Array(n);
      for (var i = 0; i < n; ++i)
        copy[i] = arr[i];
      return copy;
    }

    function spliceOne(list, index) {
      for (; index + 1 < list.length; index++)
        list[index] = list[index + 1];
      list.pop();
    }

    function unwrapListeners(arr) {
      var ret = new Array(arr.length);
      for (var i = 0; i < ret.length; ++i) {
        ret[i] = arr[i].listener || arr[i];
      }
      return ret;
    }

    function once(emitter, name) {
      return new Promise(function (resolve, reject) {
        function errorListener(err) {
          emitter.removeListener(name, resolver);
          reject(err);
        }

        function resolver() {
          if (typeof emitter.removeListener === 'function') {
            emitter.removeListener('error', errorListener);
          }
          resolve([].slice.call(arguments));
        }
        eventTargetAgnosticAddListener(emitter, name, resolver, { once: true });
        if (name !== 'error') {
          addErrorHandlerIfEventEmitter(emitter, errorListener, { once: true });
        }
      });
    }

    function addErrorHandlerIfEventEmitter(emitter, handler, flags) {
      if (typeof emitter.on === 'function') {
        eventTargetAgnosticAddListener(emitter, 'error', handler, flags);
      }
    }

    function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
      if (typeof emitter.on === 'function') {
        if (flags.once) {
          emitter.once(name, listener);
        } else {
          emitter.on(name, listener);
        }
      } else if (typeof emitter.addEventListener === 'function') {
        // EventTarget does not have `error` event semantics like Node
        // EventEmitters, we do not listen for `error` events here.
        emitter.addEventListener(name, function wrapListener(arg) {
          // IE does not have builtin `{ once: true }` support so we
          // have to do it manually.
          if (flags.once) {
            emitter.removeEventListener(name, wrapListener);
          }
          listener(arg);
        });
      } else {
        throw new TypeError('The "emitter" argument must be of type EventEmitter. Received type ' + typeof emitter);
      }
    }

    // Unique ID creation requires a high quality random # generator. In the browser we therefore
    // require the crypto API and do not support built-in fallback to lower quality random number
    // generators (like Math.random()).
    let getRandomValues;
    const rnds8 = new Uint8Array(16);
    function rng() {
      // lazy load so that environments that need to polyfill have a chance to do so
      if (!getRandomValues) {
        // getRandomValues needs to be invoked in a context where "this" is a Crypto implementation.
        getRandomValues = typeof crypto !== 'undefined' && crypto.getRandomValues && crypto.getRandomValues.bind(crypto);

        if (!getRandomValues) {
          throw new Error('crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported');
        }
      }

      return getRandomValues(rnds8);
    }

    /**
     * Convert array of 16 byte values to UUID string format of the form:
     * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
     */

    const byteToHex = [];

    for (let i = 0; i < 256; ++i) {
      byteToHex.push((i + 0x100).toString(16).slice(1));
    }

    function unsafeStringify(arr, offset = 0) {
      // Note: Be careful editing this code!  It's been tuned for performance
      // and works in ways you may not expect. See https://github.com/uuidjs/uuid/pull/434
      return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
    }

    const randomUUID = typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID.bind(crypto);
    var native = {
      randomUUID
    };

    function v4(options, buf, offset) {
      if (native.randomUUID && !buf && !options) {
        return native.randomUUID();
      }

      options = options || {};
      const rnds = options.random || (options.rng || rng)(); // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`

      rnds[6] = rnds[6] & 0x0f | 0x40;
      rnds[8] = rnds[8] & 0x3f | 0x80; // Copy bytes to buffer, if provided

      if (buf) {
        offset = offset || 0;

        for (let i = 0; i < 16; ++i) {
          buf[offset + i] = rnds[i];
        }

        return buf;
      }

      return unsafeStringify(rnds);
    }

    var browserExports = {};
    var browser = {
      get exports(){ return browserExports; },
      set exports(v){ browserExports = v; },
    };

    /**
     * Helpers.
     */

    var ms;
    var hasRequiredMs;

    function requireMs () {
    	if (hasRequiredMs) return ms;
    	hasRequiredMs = 1;
    	var s = 1000;
    	var m = s * 60;
    	var h = m * 60;
    	var d = h * 24;
    	var w = d * 7;
    	var y = d * 365.25;

    	/**
    	 * Parse or format the given `val`.
    	 *
    	 * Options:
    	 *
    	 *  - `long` verbose formatting [false]
    	 *
    	 * @param {String|Number} val
    	 * @param {Object} [options]
    	 * @throws {Error} throw an error if val is not a non-empty string or a number
    	 * @return {String|Number}
    	 * @api public
    	 */

    	ms = function(val, options) {
    	  options = options || {};
    	  var type = typeof val;
    	  if (type === 'string' && val.length > 0) {
    	    return parse(val);
    	  } else if (type === 'number' && isFinite(val)) {
    	    return options.long ? fmtLong(val) : fmtShort(val);
    	  }
    	  throw new Error(
    	    'val is not a non-empty string or a valid number. val=' +
    	      JSON.stringify(val)
    	  );
    	};

    	/**
    	 * Parse the given `str` and return milliseconds.
    	 *
    	 * @param {String} str
    	 * @return {Number}
    	 * @api private
    	 */

    	function parse(str) {
    	  str = String(str);
    	  if (str.length > 100) {
    	    return;
    	  }
    	  var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
    	    str
    	  );
    	  if (!match) {
    	    return;
    	  }
    	  var n = parseFloat(match[1]);
    	  var type = (match[2] || 'ms').toLowerCase();
    	  switch (type) {
    	    case 'years':
    	    case 'year':
    	    case 'yrs':
    	    case 'yr':
    	    case 'y':
    	      return n * y;
    	    case 'weeks':
    	    case 'week':
    	    case 'w':
    	      return n * w;
    	    case 'days':
    	    case 'day':
    	    case 'd':
    	      return n * d;
    	    case 'hours':
    	    case 'hour':
    	    case 'hrs':
    	    case 'hr':
    	    case 'h':
    	      return n * h;
    	    case 'minutes':
    	    case 'minute':
    	    case 'mins':
    	    case 'min':
    	    case 'm':
    	      return n * m;
    	    case 'seconds':
    	    case 'second':
    	    case 'secs':
    	    case 'sec':
    	    case 's':
    	      return n * s;
    	    case 'milliseconds':
    	    case 'millisecond':
    	    case 'msecs':
    	    case 'msec':
    	    case 'ms':
    	      return n;
    	    default:
    	      return undefined;
    	  }
    	}

    	/**
    	 * Short format for `ms`.
    	 *
    	 * @param {Number} ms
    	 * @return {String}
    	 * @api private
    	 */

    	function fmtShort(ms) {
    	  var msAbs = Math.abs(ms);
    	  if (msAbs >= d) {
    	    return Math.round(ms / d) + 'd';
    	  }
    	  if (msAbs >= h) {
    	    return Math.round(ms / h) + 'h';
    	  }
    	  if (msAbs >= m) {
    	    return Math.round(ms / m) + 'm';
    	  }
    	  if (msAbs >= s) {
    	    return Math.round(ms / s) + 's';
    	  }
    	  return ms + 'ms';
    	}

    	/**
    	 * Long format for `ms`.
    	 *
    	 * @param {Number} ms
    	 * @return {String}
    	 * @api private
    	 */

    	function fmtLong(ms) {
    	  var msAbs = Math.abs(ms);
    	  if (msAbs >= d) {
    	    return plural(ms, msAbs, d, 'day');
    	  }
    	  if (msAbs >= h) {
    	    return plural(ms, msAbs, h, 'hour');
    	  }
    	  if (msAbs >= m) {
    	    return plural(ms, msAbs, m, 'minute');
    	  }
    	  if (msAbs >= s) {
    	    return plural(ms, msAbs, s, 'second');
    	  }
    	  return ms + ' ms';
    	}

    	/**
    	 * Pluralization helper.
    	 */

    	function plural(ms, msAbs, n, name) {
    	  var isPlural = msAbs >= n * 1.5;
    	  return Math.round(ms / n) + ' ' + name + (isPlural ? 's' : '');
    	}
    	return ms;
    }

    /**
     * This is the common logic for both the Node.js and web browser
     * implementations of `debug()`.
     */

    function setup(env) {
    	createDebug.debug = createDebug;
    	createDebug.default = createDebug;
    	createDebug.coerce = coerce;
    	createDebug.disable = disable;
    	createDebug.enable = enable;
    	createDebug.enabled = enabled;
    	createDebug.humanize = requireMs();
    	createDebug.destroy = destroy;

    	Object.keys(env).forEach(key => {
    		createDebug[key] = env[key];
    	});

    	/**
    	* The currently active debug mode names, and names to skip.
    	*/

    	createDebug.names = [];
    	createDebug.skips = [];

    	/**
    	* Map of special "%n" handling functions, for the debug "format" argument.
    	*
    	* Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
    	*/
    	createDebug.formatters = {};

    	/**
    	* Selects a color for a debug namespace
    	* @param {String} namespace The namespace string for the debug instance to be colored
    	* @return {Number|String} An ANSI color code for the given namespace
    	* @api private
    	*/
    	function selectColor(namespace) {
    		let hash = 0;

    		for (let i = 0; i < namespace.length; i++) {
    			hash = ((hash << 5) - hash) + namespace.charCodeAt(i);
    			hash |= 0; // Convert to 32bit integer
    		}

    		return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
    	}
    	createDebug.selectColor = selectColor;

    	/**
    	* Create a debugger with the given `namespace`.
    	*
    	* @param {String} namespace
    	* @return {Function}
    	* @api public
    	*/
    	function createDebug(namespace) {
    		let prevTime;
    		let enableOverride = null;
    		let namespacesCache;
    		let enabledCache;

    		function debug(...args) {
    			// Disabled?
    			if (!debug.enabled) {
    				return;
    			}

    			const self = debug;

    			// Set `diff` timestamp
    			const curr = Number(new Date());
    			const ms = curr - (prevTime || curr);
    			self.diff = ms;
    			self.prev = prevTime;
    			self.curr = curr;
    			prevTime = curr;

    			args[0] = createDebug.coerce(args[0]);

    			if (typeof args[0] !== 'string') {
    				// Anything else let's inspect with %O
    				args.unshift('%O');
    			}

    			// Apply any `formatters` transformations
    			let index = 0;
    			args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
    				// If we encounter an escaped % then don't increase the array index
    				if (match === '%%') {
    					return '%';
    				}
    				index++;
    				const formatter = createDebug.formatters[format];
    				if (typeof formatter === 'function') {
    					const val = args[index];
    					match = formatter.call(self, val);

    					// Now we need to remove `args[index]` since it's inlined in the `format`
    					args.splice(index, 1);
    					index--;
    				}
    				return match;
    			});

    			// Apply env-specific formatting (colors, etc.)
    			createDebug.formatArgs.call(self, args);

    			const logFn = self.log || createDebug.log;
    			logFn.apply(self, args);
    		}

    		debug.namespace = namespace;
    		debug.useColors = createDebug.useColors();
    		debug.color = createDebug.selectColor(namespace);
    		debug.extend = extend;
    		debug.destroy = createDebug.destroy; // XXX Temporary. Will be removed in the next major release.

    		Object.defineProperty(debug, 'enabled', {
    			enumerable: true,
    			configurable: false,
    			get: () => {
    				if (enableOverride !== null) {
    					return enableOverride;
    				}
    				if (namespacesCache !== createDebug.namespaces) {
    					namespacesCache = createDebug.namespaces;
    					enabledCache = createDebug.enabled(namespace);
    				}

    				return enabledCache;
    			},
    			set: v => {
    				enableOverride = v;
    			}
    		});

    		// Env-specific initialization logic for debug instances
    		if (typeof createDebug.init === 'function') {
    			createDebug.init(debug);
    		}

    		return debug;
    	}

    	function extend(namespace, delimiter) {
    		const newDebug = createDebug(this.namespace + (typeof delimiter === 'undefined' ? ':' : delimiter) + namespace);
    		newDebug.log = this.log;
    		return newDebug;
    	}

    	/**
    	* Enables a debug mode by namespaces. This can include modes
    	* separated by a colon and wildcards.
    	*
    	* @param {String} namespaces
    	* @api public
    	*/
    	function enable(namespaces) {
    		createDebug.save(namespaces);
    		createDebug.namespaces = namespaces;

    		createDebug.names = [];
    		createDebug.skips = [];

    		let i;
    		const split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
    		const len = split.length;

    		for (i = 0; i < len; i++) {
    			if (!split[i]) {
    				// ignore empty strings
    				continue;
    			}

    			namespaces = split[i].replace(/\*/g, '.*?');

    			if (namespaces[0] === '-') {
    				createDebug.skips.push(new RegExp('^' + namespaces.slice(1) + '$'));
    			} else {
    				createDebug.names.push(new RegExp('^' + namespaces + '$'));
    			}
    		}
    	}

    	/**
    	* Disable debug output.
    	*
    	* @return {String} namespaces
    	* @api public
    	*/
    	function disable() {
    		const namespaces = [
    			...createDebug.names.map(toNamespace),
    			...createDebug.skips.map(toNamespace).map(namespace => '-' + namespace)
    		].join(',');
    		createDebug.enable('');
    		return namespaces;
    	}

    	/**
    	* Returns true if the given mode name is enabled, false otherwise.
    	*
    	* @param {String} name
    	* @return {Boolean}
    	* @api public
    	*/
    	function enabled(name) {
    		if (name[name.length - 1] === '*') {
    			return true;
    		}

    		let i;
    		let len;

    		for (i = 0, len = createDebug.skips.length; i < len; i++) {
    			if (createDebug.skips[i].test(name)) {
    				return false;
    			}
    		}

    		for (i = 0, len = createDebug.names.length; i < len; i++) {
    			if (createDebug.names[i].test(name)) {
    				return true;
    			}
    		}

    		return false;
    	}

    	/**
    	* Convert regexp to namespace
    	*
    	* @param {RegExp} regxep
    	* @return {String} namespace
    	* @api private
    	*/
    	function toNamespace(regexp) {
    		return regexp.toString()
    			.substring(2, regexp.toString().length - 2)
    			.replace(/\.\*\?$/, '*');
    	}

    	/**
    	* Coerce `val`.
    	*
    	* @param {Mixed} val
    	* @return {Mixed}
    	* @api private
    	*/
    	function coerce(val) {
    		if (val instanceof Error) {
    			return val.stack || val.message;
    		}
    		return val;
    	}

    	/**
    	* XXX DO NOT USE. This is a temporary stub function.
    	* XXX It WILL be removed in the next major release.
    	*/
    	function destroy() {
    		console.warn('Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.');
    	}

    	createDebug.enable(createDebug.load());

    	return createDebug;
    }

    var common = setup;

    /* eslint-env browser */

    (function (module, exports) {
    	/**
    	 * This is the web browser implementation of `debug()`.
    	 */

    	exports.formatArgs = formatArgs;
    	exports.save = save;
    	exports.load = load;
    	exports.useColors = useColors;
    	exports.storage = localstorage();
    	exports.destroy = (() => {
    		let warned = false;

    		return () => {
    			if (!warned) {
    				warned = true;
    				console.warn('Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.');
    			}
    		};
    	})();

    	/**
    	 * Colors.
    	 */

    	exports.colors = [
    		'#0000CC',
    		'#0000FF',
    		'#0033CC',
    		'#0033FF',
    		'#0066CC',
    		'#0066FF',
    		'#0099CC',
    		'#0099FF',
    		'#00CC00',
    		'#00CC33',
    		'#00CC66',
    		'#00CC99',
    		'#00CCCC',
    		'#00CCFF',
    		'#3300CC',
    		'#3300FF',
    		'#3333CC',
    		'#3333FF',
    		'#3366CC',
    		'#3366FF',
    		'#3399CC',
    		'#3399FF',
    		'#33CC00',
    		'#33CC33',
    		'#33CC66',
    		'#33CC99',
    		'#33CCCC',
    		'#33CCFF',
    		'#6600CC',
    		'#6600FF',
    		'#6633CC',
    		'#6633FF',
    		'#66CC00',
    		'#66CC33',
    		'#9900CC',
    		'#9900FF',
    		'#9933CC',
    		'#9933FF',
    		'#99CC00',
    		'#99CC33',
    		'#CC0000',
    		'#CC0033',
    		'#CC0066',
    		'#CC0099',
    		'#CC00CC',
    		'#CC00FF',
    		'#CC3300',
    		'#CC3333',
    		'#CC3366',
    		'#CC3399',
    		'#CC33CC',
    		'#CC33FF',
    		'#CC6600',
    		'#CC6633',
    		'#CC9900',
    		'#CC9933',
    		'#CCCC00',
    		'#CCCC33',
    		'#FF0000',
    		'#FF0033',
    		'#FF0066',
    		'#FF0099',
    		'#FF00CC',
    		'#FF00FF',
    		'#FF3300',
    		'#FF3333',
    		'#FF3366',
    		'#FF3399',
    		'#FF33CC',
    		'#FF33FF',
    		'#FF6600',
    		'#FF6633',
    		'#FF9900',
    		'#FF9933',
    		'#FFCC00',
    		'#FFCC33'
    	];

    	/**
    	 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
    	 * and the Firebug extension (any Firefox version) are known
    	 * to support "%c" CSS customizations.
    	 *
    	 * TODO: add a `localStorage` variable to explicitly enable/disable colors
    	 */

    	// eslint-disable-next-line complexity
    	function useColors() {
    		// NB: In an Electron preload script, document will be defined but not fully
    		// initialized. Since we know we're in Chrome, we'll just detect this case
    		// explicitly
    		if (typeof window !== 'undefined' && window.process && (window.process.type === 'renderer' || window.process.__nwjs)) {
    			return true;
    		}

    		// Internet Explorer and Edge do not support colors.
    		if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
    			return false;
    		}

    		// Is webkit? http://stackoverflow.com/a/16459606/376773
    		// document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
    		return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    			// Is firebug? http://stackoverflow.com/a/398120/376773
    			(typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    			// Is firefox >= v31?
    			// https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    			(typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    			// Double check webkit in userAgent just in case we are in a worker
    			(typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
    	}

    	/**
    	 * Colorize log arguments if enabled.
    	 *
    	 * @api public
    	 */

    	function formatArgs(args) {
    		args[0] = (this.useColors ? '%c' : '') +
    			this.namespace +
    			(this.useColors ? ' %c' : ' ') +
    			args[0] +
    			(this.useColors ? '%c ' : ' ') +
    			'+' + module.exports.humanize(this.diff);

    		if (!this.useColors) {
    			return;
    		}

    		const c = 'color: ' + this.color;
    		args.splice(1, 0, c, 'color: inherit');

    		// The final "%c" is somewhat tricky, because there could be other
    		// arguments passed either before or after the %c, so we need to
    		// figure out the correct index to insert the CSS into
    		let index = 0;
    		let lastC = 0;
    		args[0].replace(/%[a-zA-Z%]/g, match => {
    			if (match === '%%') {
    				return;
    			}
    			index++;
    			if (match === '%c') {
    				// We only are interested in the *last* %c
    				// (the user may have provided their own)
    				lastC = index;
    			}
    		});

    		args.splice(lastC, 0, c);
    	}

    	/**
    	 * Invokes `console.debug()` when available.
    	 * No-op when `console.debug` is not a "function".
    	 * If `console.debug` is not available, falls back
    	 * to `console.log`.
    	 *
    	 * @api public
    	 */
    	exports.log = console.debug || console.log || (() => {});

    	/**
    	 * Save `namespaces`.
    	 *
    	 * @param {String} namespaces
    	 * @api private
    	 */
    	function save(namespaces) {
    		try {
    			if (namespaces) {
    				exports.storage.setItem('debug', namespaces);
    			} else {
    				exports.storage.removeItem('debug');
    			}
    		} catch (error) {
    			// Swallow
    			// XXX (@Qix-) should we be logging these?
    		}
    	}

    	/**
    	 * Load `namespaces`.
    	 *
    	 * @return {String} returns the previously persisted debug modes
    	 * @api private
    	 */
    	function load() {
    		let r;
    		try {
    			r = exports.storage.getItem('debug');
    		} catch (error) {
    			// Swallow
    			// XXX (@Qix-) should we be logging these?
    		}

    		// If debug isn't set in LS, and we're in Electron, try to load $DEBUG
    		if (!r && typeof process !== 'undefined' && 'env' in process) {
    			r = process.env.DEBUG;
    		}

    		return r;
    	}

    	/**
    	 * Localstorage attempts to return the localstorage.
    	 *
    	 * This is necessary because safari throws
    	 * when a user disables cookies/localstorage
    	 * and you attempt to access it.
    	 *
    	 * @return {LocalStorage}
    	 * @api private
    	 */

    	function localstorage() {
    		try {
    			// TVMLKit (Apple TV JS Runtime) does not have a window object, just localStorage in the global context
    			// The Browser also has localStorage in the global context.
    			return localStorage;
    		} catch (error) {
    			// Swallow
    			// XXX (@Qix-) should we be logging these?
    		}
    	}

    	module.exports = common(exports);

    	const {formatters} = module.exports;

    	/**
    	 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
    	 */

    	formatters.j = function (v) {
    		try {
    			return JSON.stringify(v);
    		} catch (error) {
    			return '[UnexpectedJSONParseError]: ' + error.message;
    		}
    	};
    } (browser, browserExports));

    var debug = browserExports;

    const log = new debug('nostr:adapter');
    const profilesLog = new debug('nostr:adapter:profiles');
    const writeLog = new debug('nostr:adapter:write');

    class NstrAdapter {
        relayStatus = {};
        #pool = null;
        #messages = {};
        #eventEmitter = new eventsExports();
        #handlers = {}
        tags;
        referenceTags;
        type;
        #websiteOwnerPubkey;
        relayUrls = [];

        #profileRequestQueue = [];
        #requestedProfiles = [];
        #profileRequestTimer;
        #delayedSubscriptions = {};
        #delayedSubscriptionTimeouts = {};

        constructor(clientPubkey, {tags, referenceTags, type='DM', websiteOwnerPubkey, relays} = {}) {
            this.pubkey = clientPubkey;
            this.#websiteOwnerPubkey = websiteOwnerPubkey;
            this.relayUrls = relays;

            if (type) {
                this.setChatConfiguration(type, tags, referenceTags);
            }
        }

        setChatConfiguration(type, tags, referenceTags) {
            log('chatConfiguration', {type, tags, referenceTags});
            this.type = type;
            this.tags = tags;
            this.referenceTags = referenceTags;

            // handle connection
            if (this.#pool) { this.#disconnect(); }
            this.#connect();

            let filters = [];

            // handle subscriptions
            // if this is DM type then subscribe to chats with this website owner
            switch (this.type) {
                case 'DM':
                    filters.push({
                        kinds: [4],
                        '#p': [this.pubkey, this.#websiteOwnerPubkey],
                        'authors': [this.pubkey, this.#websiteOwnerPubkey]
                    });
                    break;
                case 'GLOBAL':
                    if (this.tags && this.tags.length > 0) {
                        filters.push({kinds: [1], '#t': this.tags, limit: 20});
                    }
                    if (this.referenceTags && this.referenceTags.length > 0) {
                        filters.push({kinds: [1], '#r': this.referenceTags, limit: 20});
                    }

                    break;
            }

            if (filters && filters.length > 0) {
                this.subscribe(filters, (e) => { this.#emitMessage(e); });
            }
        }

        async getPubKey() {
            return this.pubkey;
        }

        on(event, callback) {
            this.#eventEmitter.on(event, callback);
        }

        /**
         * Send a message to the relay
         * @param {String} message - The message to send
         */
        async send(message, {tagPubKeys, tags} = {}) {
            let event;

            if (!tags) { tags = [];}

            if (this.type === 'DM') {
                event = await this.sendKind4(message, {tagPubKeys, tags});
            } else {
                event = await this.sendKind1(message, {tagPubKeys, tags});
            }

            event.id = getEventHash(event);
            const signedEvent = await this.signEvent(event);

            this.#_publish(signedEvent);

            return event.id;
        }

        async sendKind4(message, {tagPubKeys, tags} = {}) {
            let ciphertext = await this.encrypt(this.#websiteOwnerPubkey, message);
            let event = {
                kind: 4,
                pubkey: this.pubkey,
                created_at: Math.floor(Date.now() / 1000),
                content: ciphertext,
                tags: [
                    ['p', this.#websiteOwnerPubkey],
                    ...tags
                ],
            };

            return event;
        }

        async sendKind1(message, {tagPubKeys, tags} = {}) {
            if (!tags) { tags = []; }

            if (this.tags) {
                this.tags.forEach((t) => tags.push(['t', t]));
            }

            if (this.referenceTags) {
                this.referenceTags.forEach((t) => tags.push(['r', t]));
            }

            let event = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags,
                content: message,
                pubkey: this.pubkey,
            };

            if (tagPubKeys) {
                for (let pubkey of tagPubKeys) {
                    if (pubkey) {
                        event.tags.push(['p', pubkey]);
                    }
                }
            }

            event.id = getEventHash(event);
            this.subscribeToEventAndResponses(event.id);

            return event;
        }

        async #_publish(event) {
            writeLog('publish', event);
            this.#pool.send([ 'EVENT', event ]);
        }

        async onEvent(event, messageCallback) {
            this.#addProfileRequest(event.pubkey);

            messageCallback(event);
        }

        async delayedSubscribe(filters, family, timeout) {
            this.#delayedSubscriptions[family] = this.#delayedSubscriptions[family] || [];
            this.#delayedSubscriptions[family].push(filters);

            if (!this.#delayedSubscriptionTimeouts[family]) {
                this.#delayedSubscriptionTimeouts[family] = setTimeout(() => {
                    delete this.#delayedSubscriptionTimeouts[family];
                    filters = this.#delayedSubscriptions[family];
                    delete this.#delayedSubscriptions[family];

                    this.subscribe(filters, (e) => { this.#emitMessage(e);});
                }, timeout);
            }
        }

        async subscribe(filters, messageCallback=null) {
            if (!messageCallback) { messageCallback = (e) => { this.#emitMessage(e); }; }
            return this.#_subscribe(filters, messageCallback)
        }

        async #_subscribe(filters, messageCallback) {
            const subId = v4();
            this.#handlers[subId] = messageCallback;
            if (!Array.isArray(filters)) { filters = [filters]; }
            this.#pool.subscribe(subId, filters);
            this.#pool.on('event', (relay, recSubId, e) => {
                this.onEvent(e, this.#handlers[recSubId]);
            });

            return subId;
        }

        async #emitMessage(event) {
            // has already been emitted
            if (this.#messages[event.id]) {
                return;
            }

            this.#messages[event.id] = true;

            // decrypt
            if (event.kind === 4) {
                event.content = await this.decrypt(this.#websiteOwnerPubkey, event.content);
            }

            if (event.kind === 1) {
                if (!event.tags.find(t => t[0] === 'e')) {
                    // a top level message that we should subscribe to since responses won't tag the url
                    this.subscribe({ kinds: [1], '#e': [event.id] });
                }
            }

            let deletedEvents = [];
            if (event.kind === 5) {
                deletedEvents = event.tags.filter(tag => tag[0] === 'e').map(tag => tag[1]);
            }

            switch (event.kind) {
                case 1: this.#eventEmitter.emit('message', event); break;
                case 4: this.#eventEmitter.emit('message', event); break;
                case 5: this.#eventEmitter.emit('deleted', deletedEvents); break;
                case 7: this.#eventEmitter.emit('reaction', event); break;
                default:
                    // alert('unknown event kind ' + event.kind)
                    console.log('unknown event kind', event.kind, event);
            }

        }

        subscribeToEventAndResponses(eventId) {
            this.subscribe([
                {ids: [eventId]},
                {'#e': [eventId]},
            ], (e) => {
                this.#emitMessage(e);
                // this.subscribeToResponses(e)
            });
        }

        subscribeToResponses(event) {
            this.subscribe([
                {'#e': [event.id]},
            ], (e) => {
                this.#emitMessage(e);
                this.subscribeToResponses(e);
            });
        }

        /**
         * Connect to the relay
         */
        #connect() {
            this.relayUrls.forEach((url) => {
                this.relayStatus[url] = 'disconnected';
            });
            this.#eventEmitter.emit('connectivity', this.relayStatus);

            // console.log('connecting to relay', this.relayUrls);
            this.#pool = new relayPool(this.relayUrls);
            this.#pool.on('open', (relay) => {
                // console.log(`connected to ${relay.url}`, new Date())
                this.relayStatus[relay.url] = 'connected';
                this.#eventEmitter.emit('connectivity', this.relayStatus);
            });

            this.#pool.on('error', (relay, r, e) => {
                this.relayStatus[relay.url] = 'error';
                this.#eventEmitter.emit('connectivity', this.relayStatus);
                console.log('error from relay', relay.url, r, e);
            });

            this.#pool.on('close', (relay, r) => {
                this.relayStatus[relay.url] = 'closed';
                this.#eventEmitter.emit('connectivity', this.relayStatus);
                console.log('error from relay', relay.url, r);
            });

            this.#pool.on('notice', (relay, r) => {
                console.log('notice', relay.url, r);
            });
        }

        #disconnect() {
            this.relayUrls.forEach((url) => {
                this.relayStatus[url] = 'disconnected';
            });
            this.#eventEmitter.emit('connectivity', this.relayStatus);
            this.#pool.close();
            this.#pool = null;
        }

        //
        //
        // Profiles
        //
        //
        reqProfile(pubkey) {
            this.#addProfileRequest(pubkey);
        }

        #addProfileRequest(pubkey, event=null) {
            if (this.#profileRequestQueue.includes(pubkey)) { return; }
            if (this.#requestedProfiles.includes(pubkey)) { return; }
            this.#profileRequestQueue.push(pubkey);
            this.#requestedProfiles.push(pubkey);

            if (!this.#profileRequestTimer) {
                this.#profileRequestTimer = setTimeout(() => {
                    this.#profileRequestTimer = null;
                    this.#requestProfiles();
                }, 500);
            }
        }

        /**
         * Send request for all queued profiles
         */
        async #requestProfiles() {
            if (this.#profileRequestQueue.length > 0) {
                profilesLog('requesting profiles', this.#profileRequestQueue);

                // send request
                const subId = await this.subscribe({ kinds: [0], authors: this.#profileRequestQueue }, (e) => {
                    this.#processReceivedProfile(e);
                });
                profilesLog('subscribed to request', {subId});
                this.#profileRequestQueue = [];

                setTimeout(() => {
                    profilesLog('unsubscribing from request', {subId});
                    this.#pool.unsubscribe(subId);
                }, 5000);
            }
        }

        #processReceivedProfile(event) {
            profilesLog('received profile', event);
            let profile;
            try {
                profile = JSON.parse(event.content);
            } catch (e) {
                profilesLog('failed to parse profile', event);
                return;
            }
            this.#eventEmitter.emit('profile', {pubkey: event.pubkey, profile});
        }
    }

    class NstrAdapterNip07 extends NstrAdapter {
        constructor(pubkey, adapterConfig={}) {
            super(pubkey, adapterConfig);
        }

        async signEvent(event) {
            return await window.nostr.signEvent(event);
        }

        async encrypt(destPubkey, message) {
            return await window.nostr.nip04.encrypt(destPubkey, message);
        }

        async decrypt(destPubkey, message) {
            return await window.nostr.nip04.decrypt(destPubkey, message);
        }
    }

    function _regeneratorRuntime() {
      _regeneratorRuntime = function () {
        return exports;
      };
      var exports = {},
        Op = Object.prototype,
        hasOwn = Op.hasOwnProperty,
        defineProperty = Object.defineProperty || function (obj, key, desc) {
          obj[key] = desc.value;
        },
        $Symbol = "function" == typeof Symbol ? Symbol : {},
        iteratorSymbol = $Symbol.iterator || "@@iterator",
        asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator",
        toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";
      function define(obj, key, value) {
        return Object.defineProperty(obj, key, {
          value: value,
          enumerable: !0,
          configurable: !0,
          writable: !0
        }), obj[key];
      }
      try {
        define({}, "");
      } catch (err) {
        define = function (obj, key, value) {
          return obj[key] = value;
        };
      }
      function wrap(innerFn, outerFn, self, tryLocsList) {
        var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator,
          generator = Object.create(protoGenerator.prototype),
          context = new Context(tryLocsList || []);
        return defineProperty(generator, "_invoke", {
          value: makeInvokeMethod(innerFn, self, context)
        }), generator;
      }
      function tryCatch(fn, obj, arg) {
        try {
          return {
            type: "normal",
            arg: fn.call(obj, arg)
          };
        } catch (err) {
          return {
            type: "throw",
            arg: err
          };
        }
      }
      exports.wrap = wrap;
      var ContinueSentinel = {};
      function Generator() {}
      function GeneratorFunction() {}
      function GeneratorFunctionPrototype() {}
      var IteratorPrototype = {};
      define(IteratorPrototype, iteratorSymbol, function () {
        return this;
      });
      var getProto = Object.getPrototypeOf,
        NativeIteratorPrototype = getProto && getProto(getProto(values([])));
      NativeIteratorPrototype && NativeIteratorPrototype !== Op && hasOwn.call(NativeIteratorPrototype, iteratorSymbol) && (IteratorPrototype = NativeIteratorPrototype);
      var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(IteratorPrototype);
      function defineIteratorMethods(prototype) {
        ["next", "throw", "return"].forEach(function (method) {
          define(prototype, method, function (arg) {
            return this._invoke(method, arg);
          });
        });
      }
      function AsyncIterator(generator, PromiseImpl) {
        function invoke(method, arg, resolve, reject) {
          var record = tryCatch(generator[method], generator, arg);
          if ("throw" !== record.type) {
            var result = record.arg,
              value = result.value;
            return value && "object" == typeof value && hasOwn.call(value, "__await") ? PromiseImpl.resolve(value.__await).then(function (value) {
              invoke("next", value, resolve, reject);
            }, function (err) {
              invoke("throw", err, resolve, reject);
            }) : PromiseImpl.resolve(value).then(function (unwrapped) {
              result.value = unwrapped, resolve(result);
            }, function (error) {
              return invoke("throw", error, resolve, reject);
            });
          }
          reject(record.arg);
        }
        var previousPromise;
        defineProperty(this, "_invoke", {
          value: function (method, arg) {
            function callInvokeWithMethodAndArg() {
              return new PromiseImpl(function (resolve, reject) {
                invoke(method, arg, resolve, reject);
              });
            }
            return previousPromise = previousPromise ? previousPromise.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg();
          }
        });
      }
      function makeInvokeMethod(innerFn, self, context) {
        var state = "suspendedStart";
        return function (method, arg) {
          if ("executing" === state) throw new Error("Generator is already running");
          if ("completed" === state) {
            if ("throw" === method) throw arg;
            return doneResult();
          }
          for (context.method = method, context.arg = arg;;) {
            var delegate = context.delegate;
            if (delegate) {
              var delegateResult = maybeInvokeDelegate(delegate, context);
              if (delegateResult) {
                if (delegateResult === ContinueSentinel) continue;
                return delegateResult;
              }
            }
            if ("next" === context.method) context.sent = context._sent = context.arg;else if ("throw" === context.method) {
              if ("suspendedStart" === state) throw state = "completed", context.arg;
              context.dispatchException(context.arg);
            } else "return" === context.method && context.abrupt("return", context.arg);
            state = "executing";
            var record = tryCatch(innerFn, self, context);
            if ("normal" === record.type) {
              if (state = context.done ? "completed" : "suspendedYield", record.arg === ContinueSentinel) continue;
              return {
                value: record.arg,
                done: context.done
              };
            }
            "throw" === record.type && (state = "completed", context.method = "throw", context.arg = record.arg);
          }
        };
      }
      function maybeInvokeDelegate(delegate, context) {
        var methodName = context.method,
          method = delegate.iterator[methodName];
        if (undefined === method) return context.delegate = null, "throw" === methodName && delegate.iterator.return && (context.method = "return", context.arg = undefined, maybeInvokeDelegate(delegate, context), "throw" === context.method) || "return" !== methodName && (context.method = "throw", context.arg = new TypeError("The iterator does not provide a '" + methodName + "' method")), ContinueSentinel;
        var record = tryCatch(method, delegate.iterator, context.arg);
        if ("throw" === record.type) return context.method = "throw", context.arg = record.arg, context.delegate = null, ContinueSentinel;
        var info = record.arg;
        return info ? info.done ? (context[delegate.resultName] = info.value, context.next = delegate.nextLoc, "return" !== context.method && (context.method = "next", context.arg = undefined), context.delegate = null, ContinueSentinel) : info : (context.method = "throw", context.arg = new TypeError("iterator result is not an object"), context.delegate = null, ContinueSentinel);
      }
      function pushTryEntry(locs) {
        var entry = {
          tryLoc: locs[0]
        };
        1 in locs && (entry.catchLoc = locs[1]), 2 in locs && (entry.finallyLoc = locs[2], entry.afterLoc = locs[3]), this.tryEntries.push(entry);
      }
      function resetTryEntry(entry) {
        var record = entry.completion || {};
        record.type = "normal", delete record.arg, entry.completion = record;
      }
      function Context(tryLocsList) {
        this.tryEntries = [{
          tryLoc: "root"
        }], tryLocsList.forEach(pushTryEntry, this), this.reset(!0);
      }
      function values(iterable) {
        if (iterable) {
          var iteratorMethod = iterable[iteratorSymbol];
          if (iteratorMethod) return iteratorMethod.call(iterable);
          if ("function" == typeof iterable.next) return iterable;
          if (!isNaN(iterable.length)) {
            var i = -1,
              next = function next() {
                for (; ++i < iterable.length;) if (hasOwn.call(iterable, i)) return next.value = iterable[i], next.done = !1, next;
                return next.value = undefined, next.done = !0, next;
              };
            return next.next = next;
          }
        }
        return {
          next: doneResult
        };
      }
      function doneResult() {
        return {
          value: undefined,
          done: !0
        };
      }
      return GeneratorFunction.prototype = GeneratorFunctionPrototype, defineProperty(Gp, "constructor", {
        value: GeneratorFunctionPrototype,
        configurable: !0
      }), defineProperty(GeneratorFunctionPrototype, "constructor", {
        value: GeneratorFunction,
        configurable: !0
      }), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, toStringTagSymbol, "GeneratorFunction"), exports.isGeneratorFunction = function (genFun) {
        var ctor = "function" == typeof genFun && genFun.constructor;
        return !!ctor && (ctor === GeneratorFunction || "GeneratorFunction" === (ctor.displayName || ctor.name));
      }, exports.mark = function (genFun) {
        return Object.setPrototypeOf ? Object.setPrototypeOf(genFun, GeneratorFunctionPrototype) : (genFun.__proto__ = GeneratorFunctionPrototype, define(genFun, toStringTagSymbol, "GeneratorFunction")), genFun.prototype = Object.create(Gp), genFun;
      }, exports.awrap = function (arg) {
        return {
          __await: arg
        };
      }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, asyncIteratorSymbol, function () {
        return this;
      }), exports.AsyncIterator = AsyncIterator, exports.async = function (innerFn, outerFn, self, tryLocsList, PromiseImpl) {
        void 0 === PromiseImpl && (PromiseImpl = Promise);
        var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList), PromiseImpl);
        return exports.isGeneratorFunction(outerFn) ? iter : iter.next().then(function (result) {
          return result.done ? result.value : iter.next();
        });
      }, defineIteratorMethods(Gp), define(Gp, toStringTagSymbol, "Generator"), define(Gp, iteratorSymbol, function () {
        return this;
      }), define(Gp, "toString", function () {
        return "[object Generator]";
      }), exports.keys = function (val) {
        var object = Object(val),
          keys = [];
        for (var key in object) keys.push(key);
        return keys.reverse(), function next() {
          for (; keys.length;) {
            var key = keys.pop();
            if (key in object) return next.value = key, next.done = !1, next;
          }
          return next.done = !0, next;
        };
      }, exports.values = values, Context.prototype = {
        constructor: Context,
        reset: function (skipTempReset) {
          if (this.prev = 0, this.next = 0, this.sent = this._sent = undefined, this.done = !1, this.delegate = null, this.method = "next", this.arg = undefined, this.tryEntries.forEach(resetTryEntry), !skipTempReset) for (var name in this) "t" === name.charAt(0) && hasOwn.call(this, name) && !isNaN(+name.slice(1)) && (this[name] = undefined);
        },
        stop: function () {
          this.done = !0;
          var rootRecord = this.tryEntries[0].completion;
          if ("throw" === rootRecord.type) throw rootRecord.arg;
          return this.rval;
        },
        dispatchException: function (exception) {
          if (this.done) throw exception;
          var context = this;
          function handle(loc, caught) {
            return record.type = "throw", record.arg = exception, context.next = loc, caught && (context.method = "next", context.arg = undefined), !!caught;
          }
          for (var i = this.tryEntries.length - 1; i >= 0; --i) {
            var entry = this.tryEntries[i],
              record = entry.completion;
            if ("root" === entry.tryLoc) return handle("end");
            if (entry.tryLoc <= this.prev) {
              var hasCatch = hasOwn.call(entry, "catchLoc"),
                hasFinally = hasOwn.call(entry, "finallyLoc");
              if (hasCatch && hasFinally) {
                if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0);
                if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc);
              } else if (hasCatch) {
                if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0);
              } else {
                if (!hasFinally) throw new Error("try statement without catch or finally");
                if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc);
              }
            }
          }
        },
        abrupt: function (type, arg) {
          for (var i = this.tryEntries.length - 1; i >= 0; --i) {
            var entry = this.tryEntries[i];
            if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
              var finallyEntry = entry;
              break;
            }
          }
          finallyEntry && ("break" === type || "continue" === type) && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc && (finallyEntry = null);
          var record = finallyEntry ? finallyEntry.completion : {};
          return record.type = type, record.arg = arg, finallyEntry ? (this.method = "next", this.next = finallyEntry.finallyLoc, ContinueSentinel) : this.complete(record);
        },
        complete: function (record, afterLoc) {
          if ("throw" === record.type) throw record.arg;
          return "break" === record.type || "continue" === record.type ? this.next = record.arg : "return" === record.type ? (this.rval = this.arg = record.arg, this.method = "return", this.next = "end") : "normal" === record.type && afterLoc && (this.next = afterLoc), ContinueSentinel;
        },
        finish: function (finallyLoc) {
          for (var i = this.tryEntries.length - 1; i >= 0; --i) {
            var entry = this.tryEntries[i];
            if (entry.finallyLoc === finallyLoc) return this.complete(entry.completion, entry.afterLoc), resetTryEntry(entry), ContinueSentinel;
          }
        },
        catch: function (tryLoc) {
          for (var i = this.tryEntries.length - 1; i >= 0; --i) {
            var entry = this.tryEntries[i];
            if (entry.tryLoc === tryLoc) {
              var record = entry.completion;
              if ("throw" === record.type) {
                var thrown = record.arg;
                resetTryEntry(entry);
              }
              return thrown;
            }
          }
          throw new Error("illegal catch attempt");
        },
        delegateYield: function (iterable, resultName, nextLoc) {
          return this.delegate = {
            iterator: values(iterable),
            resultName: resultName,
            nextLoc: nextLoc
          }, "next" === this.method && (this.arg = undefined), ContinueSentinel;
        }
      }, exports;
    }
    function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
      try {
        var info = gen[key](arg);
        var value = info.value;
      } catch (error) {
        reject(error);
        return;
      }
      if (info.done) {
        resolve(value);
      } else {
        Promise.resolve(value).then(_next, _throw);
      }
    }
    function _asyncToGenerator(fn) {
      return function () {
        var self = this,
          args = arguments;
        return new Promise(function (resolve, reject) {
          var gen = fn.apply(self, args);
          function _next(value) {
            asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
          }
          function _throw(err) {
            asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
          }
          _next(undefined);
        });
      };
    }
    function _extends() {
      _extends = Object.assign ? Object.assign.bind() : function (target) {
        for (var i = 1; i < arguments.length; i++) {
          var source = arguments[i];
          for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
              target[key] = source[key];
            }
          }
        }
        return target;
      };
      return _extends.apply(this, arguments);
    }

    var NostrRPC = /*#__PURE__*/function () {
      function NostrRPC(opts) {
        // events
        this.events = new eventsExports();
        this.relay = opts.relay || 'wss://nostr.vulpem.com';
        this.self = {
          pubkey: getPublicKey(opts.secretKey),
          secret: opts.secretKey
        };
      }
      var _proto = NostrRPC.prototype;
      _proto.call = /*#__PURE__*/function () {
        var _call = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee3(_ref, opts) {
          var _this = this;
          var target, _ref$request, _ref$request$id, id, method, _ref$request$params, params, relay, request, event;
          return _regeneratorRuntime().wrap(function _callee3$(_context3) {
            while (1) switch (_context3.prev = _context3.next) {
              case 0:
                target = _ref.target, _ref$request = _ref.request, _ref$request$id = _ref$request.id, id = _ref$request$id === void 0 ? /*#__PURE__*/randomID() : _ref$request$id, method = _ref$request.method, _ref$request$params = _ref$request.params, params = _ref$request$params === void 0 ? [] : _ref$request$params;
                _context3.next = 3;
                return connectToRelay(this.relay);
              case 3:
                relay = _context3.sent;
                // prepare request to be sent
                request = prepareRequest(id, method, params);
                _context3.next = 7;
                return prepareEvent(this.self.secret, target, request);
              case 7:
                event = _context3.sent;
                return _context3.abrupt("return", new Promise( /*#__PURE__*/function () {
                  var _ref2 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2(resolve, reject) {
                    var sub;
                    return _regeneratorRuntime().wrap(function _callee2$(_context2) {
                      while (1) switch (_context2.prev = _context2.next) {
                        case 0:
                          sub = relay.sub([{
                            kinds: [24133],
                            authors: [target],
                            '#p': [_this.self.pubkey],
                            limit: 1
                          }]);
                          _context2.next = 3;
                          return broadcastToRelay(relay, event, true);
                        case 3:
                          // skip waiting for response from remote
                          if (opts && opts.skipResponse === true) resolve();
                          sub.on('event', /*#__PURE__*/function () {
                            var _ref3 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(event) {
                              var payload, plaintext;
                              return _regeneratorRuntime().wrap(function _callee$(_context) {
                                while (1) switch (_context.prev = _context.next) {
                                  case 0:
                                    _context.prev = 0;
                                    _context.next = 3;
                                    return nip04_exports.decrypt(_this.self.secret, event.pubkey, event.content);
                                  case 3:
                                    plaintext = _context.sent;
                                    if (plaintext) {
                                      _context.next = 6;
                                      break;
                                    }
                                    throw new Error('failed to decrypt event');
                                  case 6:
                                    payload = JSON.parse(plaintext);
                                    _context.next = 12;
                                    break;
                                  case 9:
                                    _context.prev = 9;
                                    _context.t0 = _context["catch"](0);
                                    return _context.abrupt("return");
                                  case 12:
                                    if (isValidResponse(payload)) {
                                      _context.next = 14;
                                      break;
                                    }
                                    return _context.abrupt("return");
                                  case 14:
                                    if (!(payload.id !== id)) {
                                      _context.next = 16;
                                      break;
                                    }
                                    return _context.abrupt("return");
                                  case 16:
                                    // if the response is an error, reject the promise
                                    if (payload.error) {
                                      reject(payload.error);
                                    }
                                    // if the response is a result, resolve the promise
                                    if (payload.result) {
                                      resolve(payload.result);
                                    }
                                  case 18:
                                  case "end":
                                    return _context.stop();
                                }
                              }, _callee, null, [[0, 9]]);
                            }));
                            return function (_x5) {
                              return _ref3.apply(this, arguments);
                            };
                          }());
                        case 5:
                        case "end":
                          return _context2.stop();
                      }
                    }, _callee2);
                  }));
                  return function (_x3, _x4) {
                    return _ref2.apply(this, arguments);
                  };
                }()));
              case 9:
              case "end":
                return _context3.stop();
            }
          }, _callee3, this);
        }));
        function call(_x, _x2) {
          return _call.apply(this, arguments);
        }
        return call;
      }();
      _proto.listen = /*#__PURE__*/function () {
        var _listen = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee5() {
          var _this2 = this;
          var relay, sub;
          return _regeneratorRuntime().wrap(function _callee5$(_context5) {
            while (1) switch (_context5.prev = _context5.next) {
              case 0:
                _context5.next = 2;
                return connectToRelay(this.relay);
              case 2:
                relay = _context5.sent;
                sub = relay.sub([{
                  kinds: [24133],
                  '#p': [this.self.pubkey],
                  since: now()
                }]);
                sub.on('event', /*#__PURE__*/function () {
                  var _ref4 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee4(event) {
                    var payload, plaintext, response, body, responseEvent;
                    return _regeneratorRuntime().wrap(function _callee4$(_context4) {
                      while (1) switch (_context4.prev = _context4.next) {
                        case 0:
                          _context4.prev = 0;
                          _context4.next = 3;
                          return nip04_exports.decrypt(_this2.self.secret, event.pubkey, event.content);
                        case 3:
                          plaintext = _context4.sent;
                          if (plaintext) {
                            _context4.next = 6;
                            break;
                          }
                          throw new Error('failed to decrypt event');
                        case 6:
                          payload = JSON.parse(plaintext);
                          _context4.next = 12;
                          break;
                        case 9:
                          _context4.prev = 9;
                          _context4.t0 = _context4["catch"](0);
                          return _context4.abrupt("return");
                        case 12:
                          if (isValidRequest(payload)) {
                            _context4.next = 14;
                            break;
                          }
                          return _context4.abrupt("return");
                        case 14:
                          _context4.next = 17;
                          return _this2.handleRequest(payload, event);
                        case 17:
                          response = _context4.sent;
                          body = prepareResponse(response.id, response.result, response.error);
                          _context4.next = 21;
                          return prepareEvent(_this2.self.secret, event.pubkey, body);
                        case 21:
                          responseEvent = _context4.sent;
                          // send response via relay
                          relay.publish(responseEvent);
                        case 23:
                        case "end":
                          return _context4.stop();
                      }
                    }, _callee4, null, [[0, 9]]);
                  }));
                  return function (_x6) {
                    return _ref4.apply(this, arguments);
                  };
                }());
                return _context5.abrupt("return", sub);
              case 6:
              case "end":
                return _context5.stop();
            }
          }, _callee5, this);
        }));
        function listen() {
          return _listen.apply(this, arguments);
        }
        return listen;
      }();
      _proto.handleRequest = /*#__PURE__*/function () {
        var _handleRequest = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee6(request, event) {
          var id, method, params, result, error;
          return _regeneratorRuntime().wrap(function _callee6$(_context6) {
            while (1) switch (_context6.prev = _context6.next) {
              case 0:
                id = request.id, method = request.method, params = request.params;
                result = null;
                error = null;
                _context6.prev = 3;
                this.event = event;
                _context6.next = 7;
                return this[method].apply(this, params);
              case 7:
                result = _context6.sent;
                this.event = undefined;
                _context6.next = 14;
                break;
              case 11:
                _context6.prev = 11;
                _context6.t0 = _context6["catch"](3);
                if (_context6.t0 instanceof Error) {
                  error = _context6.t0.message;
                } else {
                  error = 'unknown error';
                }
              case 14:
                return _context6.abrupt("return", {
                  id: id,
                  result: result,
                  error: error
                });
              case 15:
              case "end":
                return _context6.stop();
            }
          }, _callee6, this, [[3, 11]]);
        }));
        function handleRequest(_x7, _x8) {
          return _handleRequest.apply(this, arguments);
        }
        return handleRequest;
      }();
      return NostrRPC;
    }();
    function now() {
      return Math.floor(Date.now() / 1000);
    }
    function randomID() {
      return Math.random().toString().slice(2);
    }
    function prepareRequest(id, method, params) {
      return JSON.stringify({
        id: id,
        method: method,
        params: params
      });
    }
    function prepareResponse(id, result, error) {
      return JSON.stringify({
        id: id,
        result: result,
        error: error
      });
    }
    function prepareEvent(_x9, _x10, _x11) {
      return _prepareEvent.apply(this, arguments);
    }
    function _prepareEvent() {
      _prepareEvent = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee7(secretKey, pubkey, content) {
        var cipherText, event, id, sig, signedEvent, ok, veryOk;
        return _regeneratorRuntime().wrap(function _callee7$(_context7) {
          while (1) switch (_context7.prev = _context7.next) {
            case 0:
              _context7.next = 2;
              return nip04_exports.encrypt(secretKey, pubkey, content);
            case 2:
              cipherText = _context7.sent;
              event = {
                kind: 24133,
                created_at: now(),
                pubkey: getPublicKey(secretKey),
                tags: [['p', pubkey]],
                content: cipherText
              };
              id = getEventHash(event);
              sig = signEvent(event, secretKey);
              signedEvent = _extends({}, event, {
                id: id,
                sig: sig
              });
              ok = validateEvent(signedEvent);
              veryOk = verifySignature(signedEvent);
              if (!(!ok || !veryOk)) {
                _context7.next = 11;
                break;
              }
              throw new Error('Event is not valid');
            case 11:
              return _context7.abrupt("return", signedEvent);
            case 12:
            case "end":
              return _context7.stop();
          }
        }, _callee7);
      }));
      return _prepareEvent.apply(this, arguments);
    }
    function isValidRequest(payload) {
      if (!payload) return false;
      var keys = Object.keys(payload);
      if (!keys.includes('id') || !keys.includes('method') || !keys.includes('params')) return false;
      return true;
    }
    function isValidResponse(payload) {
      if (!payload) return false;
      var keys = Object.keys(payload);
      if (!keys.includes('id') || !keys.includes('result') || !keys.includes('error')) return false;
      return true;
    }
    function connectToRelay(_x12) {
      return _connectToRelay.apply(this, arguments);
    }
    function _connectToRelay() {
      _connectToRelay = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee8(realayURL) {
        var relay;
        return _regeneratorRuntime().wrap(function _callee8$(_context8) {
          while (1) switch (_context8.prev = _context8.next) {
            case 0:
              relay = relayInit(realayURL);
              _context8.next = 3;
              return relay.connect();
            case 3:
              _context8.next = 5;
              return new Promise(function (resolve, reject) {
                relay.on('connect', function () {
                  resolve();
                });
                relay.on('error', function () {
                  reject(new Error("not possible to connect to " + relay.url));
                });
              });
            case 5:
              return _context8.abrupt("return", relay);
            case 6:
            case "end":
              return _context8.stop();
          }
        }, _callee8);
      }));
      return _connectToRelay.apply(this, arguments);
    }
    function broadcastToRelay(_x13, _x14, _x15) {
      return _broadcastToRelay.apply(this, arguments);
    }
    function _broadcastToRelay() {
      _broadcastToRelay = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee9(relay, event, skipSeen) {
        return _regeneratorRuntime().wrap(function _callee9$(_context9) {
          while (1) switch (_context9.prev = _context9.next) {
            case 0:
              if (skipSeen === void 0) {
                skipSeen = false;
              }
              _context9.next = 3;
              return new Promise(function (resolve, reject) {
                relay.on('error', function () {
                  reject(new Error("failed to connect to " + relay.url));
                });
                var pub = relay.publish(event);
                if (skipSeen) resolve();
                pub.on('failed', function (reason) {
                  reject(reason);
                });
                pub.on('seen', function () {
                  resolve();
                });
              });
            case 3:
              return _context9.abrupt("return", _context9.sent);
            case 4:
            case "end":
              return _context9.stop();
          }
        }, _callee9);
      }));
      return _broadcastToRelay.apply(this, arguments);
    }

    var ConnectURI = /*#__PURE__*/function () {
      function ConnectURI(_ref) {
        var target = _ref.target,
          metadata = _ref.metadata,
          relay = _ref.relay;
        this.target = target;
        this.metadata = metadata;
        this.relay = relay;
      }
      ConnectURI.fromURI = function fromURI(uri) {
        var url = new URL(uri);
        var target = url.hostname || url.pathname.substring(2);
        if (!target) throw new Error('Invalid connect URI: missing target');
        var relay = url.searchParams.get('relay');
        if (!relay) {
          throw new Error('Invalid connect URI: missing relay');
        }
        var metadata = url.searchParams.get('metadata');
        if (!metadata) {
          throw new Error('Invalid connect URI: missing metadata');
        }
        /* eslint-disable @typescript-eslint/no-unused-vars */
        try {
          var md = JSON.parse(metadata);
          return new ConnectURI({
            target: target,
            metadata: md,
            relay: relay
          });
        } catch (ignore) {
          throw new Error('Invalid connect URI: metadata is not valid JSON');
        }
      };
      var _proto = ConnectURI.prototype;
      _proto.toString = function toString() {
        return "nostrconnect://" + this.target + "?metadata=" + encodeURIComponent(JSON.stringify(this.metadata)) + "&relay=" + encodeURIComponent(this.relay);
      };
      _proto.approve = /*#__PURE__*/function () {
        var _approve = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(secretKey) {
          var rpc;
          return _regeneratorRuntime().wrap(function _callee$(_context) {
            while (1) switch (_context.prev = _context.next) {
              case 0:
                rpc = new NostrRPC({
                  relay: this.relay,
                  secretKey: secretKey
                });
                _context.next = 3;
                return rpc.call({
                  target: this.target,
                  request: {
                    method: 'connect',
                    params: [getPublicKey(secretKey)]
                  }
                }, {
                  skipResponse: true
                });
              case 3:
              case "end":
                return _context.stop();
            }
          }, _callee, this);
        }));
        function approve(_x) {
          return _approve.apply(this, arguments);
        }
        return approve;
      }();
      _proto.reject = /*#__PURE__*/function () {
        var _reject = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2(secretKey) {
          var rpc;
          return _regeneratorRuntime().wrap(function _callee2$(_context2) {
            while (1) switch (_context2.prev = _context2.next) {
              case 0:
                rpc = new NostrRPC({
                  relay: this.relay,
                  secretKey: secretKey
                });
                _context2.next = 3;
                return rpc.call({
                  target: this.target,
                  request: {
                    method: 'disconnect',
                    params: []
                  }
                }, {
                  skipResponse: true
                });
              case 3:
              case "end":
                return _context2.stop();
            }
          }, _callee2, this);
        }));
        function reject(_x2) {
          return _reject.apply(this, arguments);
        }
        return reject;
      }();
      return ConnectURI;
    }();
    var Connect = /*#__PURE__*/function () {
      function Connect(_ref2) {
        var target = _ref2.target,
          relay = _ref2.relay,
          secretKey = _ref2.secretKey;
        this.events = new eventsExports();
        this.nip04 = {
          encrypt: function () {
            var _encrypt = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee3(_pubkey, _plaintext) {
              return _regeneratorRuntime().wrap(function _callee3$(_context3) {
                while (1) switch (_context3.prev = _context3.next) {
                  case 0:
                    throw new Error('Not implemented');
                  case 1:
                  case "end":
                    return _context3.stop();
                }
              }, _callee3);
            }));
            function encrypt(_x3, _x4) {
              return _encrypt.apply(this, arguments);
            }
            return encrypt;
          }(),
          decrypt: function () {
            var _decrypt = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee4(_pubkey, _ciphertext) {
              return _regeneratorRuntime().wrap(function _callee4$(_context4) {
                while (1) switch (_context4.prev = _context4.next) {
                  case 0:
                    throw new Error('Not implemented');
                  case 1:
                  case "end":
                    return _context4.stop();
                }
              }, _callee4);
            }));
            function decrypt(_x5, _x6) {
              return _decrypt.apply(this, arguments);
            }
            return decrypt;
          }()
        };
        this.rpc = new NostrRPC({
          relay: relay,
          secretKey: secretKey
        });
        if (target) {
          this.target = target;
        }
      }
      var _proto2 = Connect.prototype;
      _proto2.init = /*#__PURE__*/function () {
        var _init = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee6() {
          var _this = this;
          var sub;
          return _regeneratorRuntime().wrap(function _callee6$(_context6) {
            while (1) switch (_context6.prev = _context6.next) {
              case 0:
                _context6.next = 2;
                return this.rpc.listen();
              case 2:
                sub = _context6.sent;
                sub.on('event', /*#__PURE__*/function () {
                  var _ref3 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee5(event) {
                    var payload, plaintext, _payload$params, pubkey;
                    return _regeneratorRuntime().wrap(function _callee5$(_context5) {
                      while (1) switch (_context5.prev = _context5.next) {
                        case 0:
                          _context5.prev = 0;
                          _context5.next = 3;
                          return nip04_exports.decrypt(_this.rpc.self.secret, event.pubkey, event.content);
                        case 3:
                          plaintext = _context5.sent;
                          if (plaintext) {
                            _context5.next = 6;
                            break;
                          }
                          throw new Error('failed to decrypt event');
                        case 6:
                          payload = JSON.parse(plaintext);
                          _context5.next = 12;
                          break;
                        case 9:
                          _context5.prev = 9;
                          _context5.t0 = _context5["catch"](0);
                          return _context5.abrupt("return");
                        case 12:
                          if (isValidRequest(payload)) {
                            _context5.next = 14;
                            break;
                          }
                          return _context5.abrupt("return");
                        case 14:
                          _context5.t1 = payload.method;
                          _context5.next = _context5.t1 === 'connect' ? 17 : _context5.t1 === 'disconnect' ? 23 : 26;
                          break;
                        case 17:
                          if (!(!payload.params || payload.params.length !== 1)) {
                            _context5.next = 19;
                            break;
                          }
                          throw new Error('connect: missing pubkey');
                        case 19:
                          _payload$params = payload.params, pubkey = _payload$params[0];
                          _this.target = pubkey;
                          _this.events.emit('connect', pubkey);
                          return _context5.abrupt("break", 26);
                        case 23:
                          _this.target = undefined;
                          _this.events.emit('disconnect');
                          return _context5.abrupt("break", 26);
                        case 26:
                        case "end":
                          return _context5.stop();
                      }
                    }, _callee5, null, [[0, 9]]);
                  }));
                  return function (_x7) {
                    return _ref3.apply(this, arguments);
                  };
                }());
              case 4:
              case "end":
                return _context6.stop();
            }
          }, _callee6, this);
        }));
        function init() {
          return _init.apply(this, arguments);
        }
        return init;
      }();
      _proto2.on = function on(evt, cb) {
        this.events.on(evt, cb);
      };
      _proto2.off = function off(evt, cb) {
        this.events.off(evt, cb);
      };
      _proto2.disconnect = /*#__PURE__*/function () {
        var _disconnect = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee7() {
          return _regeneratorRuntime().wrap(function _callee7$(_context7) {
            while (1) switch (_context7.prev = _context7.next) {
              case 0:
                if (this.target) {
                  _context7.next = 2;
                  break;
                }
                throw new Error('Not connected');
              case 2:
                // notify the UI that we are disconnecting
                this.events.emit('disconnect');
                _context7.prev = 3;
                _context7.next = 6;
                return this.rpc.call({
                  target: this.target,
                  request: {
                    method: 'disconnect',
                    params: []
                  }
                }, {
                  skipResponse: true
                });
              case 6:
                _context7.next = 11;
                break;
              case 8:
                _context7.prev = 8;
                _context7.t0 = _context7["catch"](3);
                throw new Error('Failed to disconnect');
              case 11:
                this.target = undefined;
              case 12:
              case "end":
                return _context7.stop();
            }
          }, _callee7, this, [[3, 8]]);
        }));
        function disconnect() {
          return _disconnect.apply(this, arguments);
        }
        return disconnect;
      }();
      _proto2.getPublicKey = /*#__PURE__*/function () {
        var _getPublicKey = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee8() {
          var response;
          return _regeneratorRuntime().wrap(function _callee8$(_context8) {
            while (1) switch (_context8.prev = _context8.next) {
              case 0:
                if (this.target) {
                  _context8.next = 2;
                  break;
                }
                throw new Error('Not connected');
              case 2:
                _context8.next = 4;
                return this.rpc.call({
                  target: this.target,
                  request: {
                    method: 'get_public_key',
                    params: []
                  }
                });
              case 4:
                response = _context8.sent;
                return _context8.abrupt("return", response);
              case 6:
              case "end":
                return _context8.stop();
            }
          }, _callee8, this);
        }));
        function getPublicKey() {
          return _getPublicKey.apply(this, arguments);
        }
        return getPublicKey;
      }();
      _proto2.signEvent = /*#__PURE__*/function () {
        var _signEvent = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee9(event) {
          var signature;
          return _regeneratorRuntime().wrap(function _callee9$(_context9) {
            while (1) switch (_context9.prev = _context9.next) {
              case 0:
                if (this.target) {
                  _context9.next = 2;
                  break;
                }
                throw new Error('Not connected');
              case 2:
                _context9.next = 4;
                return this.rpc.call({
                  target: this.target,
                  request: {
                    method: 'sign_event',
                    params: [event]
                  }
                });
              case 4:
                signature = _context9.sent;
                return _context9.abrupt("return", signature);
              case 6:
              case "end":
                return _context9.stop();
            }
          }, _callee9, this);
        }));
        function signEvent(_x8) {
          return _signEvent.apply(this, arguments);
        }
        return signEvent;
      }();
      _proto2.getRelays = /*#__PURE__*/function () {
        var _getRelays = /*#__PURE__*/_asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee10() {
          return _regeneratorRuntime().wrap(function _callee10$(_context10) {
            while (1) switch (_context10.prev = _context10.next) {
              case 0:
                throw new Error('Not implemented');
              case 1:
              case "end":
                return _context10.stop();
            }
          }, _callee10);
        }));
        function getRelays() {
          return _getRelays.apply(this, arguments);
        }
        return getRelays;
      }();
      return Connect;
    }();

    class NstrAdapterNip46 extends NstrAdapter {
        #secretKey = null;
        
        constructor(pubkey, secretKey, adapterConfig = {}) {
            super(pubkey, adapterConfig);
            this.#secretKey = secretKey;
        }

        async signEvent(event) {
            const connect = new Connect({
                secretKey: this.#secretKey,
                target: this.pubkey,
            });
            await connect.init();
            
            event.sig = await connect.signEvent('12323423434');
            return event;
        }
    }

    class NstrAdapterDiscadableKeys extends NstrAdapter {
        #privateKey;

        constructor(adapterConfig={}) {
            let key = localStorage.getItem('nostrichat-discardable-key');
            let publicKey = localStorage.getItem('nostrichat-discardable-public-key');

            if (!key) {
                key = generatePrivateKey();
                console.log('generated key', key);
                publicKey = getPublicKey(key);
            }

            localStorage.setItem('nostrichat-discardable-key', key);
            localStorage.setItem('nostrichat-discardable-public-key', publicKey);

            super(publicKey, adapterConfig);
            
            this.#privateKey = key;
            console.log(key);
        }

        async signEvent(event) {
            event.sig = await signEvent(event, this.#privateKey);
            return event;
        }

        async encrypt(destPubkey, message) {
            console.log(this.#privateKey);
            return await nip04_exports.encrypt(this.#privateKey, destPubkey, message);
        }

        async decrypt(destPubkey, message) {
            return await nip04_exports.decrypt(this.#privateKey, destPubkey, message);
        }
    }

    /* src/KeyPrompt.svelte generated by Svelte v3.55.1 */

    // (146:21) 
    function create_if_block_1$3(ctx) {
    	let div;
    	let t0;
    	let button0;
    	let t2;
    	let button1;
    	let mounted;
    	let dispose;
    	let if_block = create_if_block_2$1(ctx);

    	return {
    		c() {
    			div = element("div");
    			if (if_block) if_block.c();
    			t0 = space();
    			button0 = element("button");
    			button0.textContent = "Nostr Connect (NIP-46)";
    			t2 = space();
    			button1 = element("button");

    			button1.innerHTML = `Anonymous
            <span class="text-xs text-gray-300 svelte-117e9f7">(Ephemeral Keys)</span>`;

    			attr(button0, "class", "bg-purple-900 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200  svelte-117e9f7");
    			attr(button1, "class", "bg-purple-900 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200  svelte-117e9f7");
    			attr(div, "class", "flex flex-col gap-1 svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			if (if_block) if_block.m(div, null);
    			append(div, t0);
    			append(div, button0);
    			append(div, t2);
    			append(div, button1);

    			if (!mounted) {
    				dispose = [
    					listen(button0, "click", prevent_default(/*useNip46*/ ctx[3])),
    					listen(button1, "click", prevent_default(/*useDiscardableKeys*/ ctx[2]))
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, dirty) {
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    			if (if_block) if_block.d();
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    // (124:0) {#if nip46URI}
    function create_if_block$4(ctx) {
    	let p;
    	let t1;
    	let div;
    	let qr;
    	let t2;
    	let button;
    	let current;
    	let mounted;
    	let dispose;
    	qr = new QR({ props: { text: /*nip46URI*/ ctx[0] } });

    	return {
    		c() {
    			p = element("p");
    			p.textContent = "Scan this with your Nostr Connect (click to copy to clipboard)";
    			t1 = space();
    			div = element("div");
    			create_component(qr.$$.fragment);
    			t2 = space();
    			button = element("button");
    			button.textContent = "Cancel";
    			attr(p, "class", "text-gray-600 mb-3 svelte-117e9f7");
    			attr(div, "class", "bg-white w-full p-3 svelte-117e9f7");
    			attr(button, "class", "bg-purple-900 hover:bg-purple-700 w-full p-2 rounded-xl text-center font-regular text-white  svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, p, anchor);
    			insert(target, t1, anchor);
    			insert(target, div, anchor);
    			mount_component(qr, div, null);
    			insert(target, t2, anchor);
    			insert(target, button, anchor);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					listen(div, "click", prevent_default(/*Nip46Copy*/ ctx[4])),
    					listen(button, "click", prevent_default(/*click_handler*/ ctx[8]))
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, dirty) {
    			const qr_changes = {};
    			if (dirty & /*nip46URI*/ 1) qr_changes.text = /*nip46URI*/ ctx[0];
    			qr.$set(qr_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(qr.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(qr.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(p);
    			if (detaching) detach(t1);
    			if (detaching) detach(div);
    			destroy_component(qr);
    			if (detaching) detach(t2);
    			if (detaching) detach(button);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    // (148:8) {#if hasNostrNip07}
    function create_if_block_2$1(ctx) {
    	let button;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			button = element("button");
    			button.textContent = "Browser Extension (NIP-07)";
    			attr(button, "class", "bg-purple-900 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200  svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, button, anchor);

    			if (!mounted) {
    				dispose = listen(button, "click", prevent_default(/*useNip07*/ ctx[1]));
    				mounted = true;
    			}
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(button);
    			mounted = false;
    			dispose();
    		}
    	};
    }

    function create_fragment$4(ctx) {
    	let h1;
    	let t1;
    	let t2;
    	let current_block_type_index;
    	let if_block1;
    	let if_block1_anchor;
    	let current;
    	const if_block_creators = [create_if_block$4, create_if_block_1$3];
    	const if_blocks = [];

    	function select_block_type(ctx, dirty) {
    		if (/*nip46URI*/ ctx[0]) return 0;
    		return 1;
    	}

    	if (~(current_block_type_index = select_block_type(ctx))) {
    		if_block1 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    	}

    	return {
    		c() {
    			h1 = element("h1");
    			h1.textContent = "How would you like to connect?";
    			t1 = space();
    			t2 = space();
    			if (if_block1) if_block1.c();
    			if_block1_anchor = empty();
    			attr(h1, "class", "font-bold text-xl mb-3 svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, h1, anchor);
    			insert(target, t1, anchor);
    			insert(target, t2, anchor);

    			if (~current_block_type_index) {
    				if_blocks[current_block_type_index].m(target, anchor);
    			}

    			insert(target, if_block1_anchor, anchor);
    			current = true;
    		},
    		p(ctx, [dirty]) {
    			let previous_block_index = current_block_type_index;
    			current_block_type_index = select_block_type(ctx);

    			if (current_block_type_index === previous_block_index) {
    				if (~current_block_type_index) {
    					if_blocks[current_block_type_index].p(ctx, dirty);
    				}
    			} else {
    				if (if_block1) {
    					group_outros();

    					transition_out(if_blocks[previous_block_index], 1, 1, () => {
    						if_blocks[previous_block_index] = null;
    					});

    					check_outros();
    				}

    				if (~current_block_type_index) {
    					if_block1 = if_blocks[current_block_type_index];

    					if (!if_block1) {
    						if_block1 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    						if_block1.c();
    					} else {
    						if_block1.p(ctx, dirty);
    					}

    					transition_in(if_block1, 1);
    					if_block1.m(if_block1_anchor.parentNode, if_block1_anchor);
    				} else {
    					if_block1 = null;
    				}
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block1);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block1);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(h1);
    			if (detaching) detach(t1);
    			if (detaching) detach(t2);

    			if (~current_block_type_index) {
    				if_blocks[current_block_type_index].d(detaching);
    			}

    			if (detaching) detach(if_block1_anchor);
    		}
    	};
    }

    function instance$4($$self, $$props, $$invalidate) {
    	let { websiteOwnerPubkey } = $$props;
    	let { chatConfiguration } = $$props;
    	let { relays } = $$props;
    	let nip46URI;
    	let adapterConfig;

    	onMount(() => {
    		// hasNostrNip07 = !!window.nostr;
    		const type = localStorage.getItem('nostrichat-type');

    		if (type === 'nip07') {
    			useNip07();
    		} else if (type === 'nip-46') {
    			useNip46();
    		}

    		adapterConfig = {
    			type: chatConfiguration.chatType,
    			tags: chatConfiguration.chatTags,
    			referenceTags: chatConfiguration.chatReferenceTags,
    			websiteOwnerPubkey,
    			relays
    		};
    	});

    	function useNip07() {
    		window.nostr.getPublicKey().then(pubkey => {
    			localStorage.setItem('nostrichat-type', 'nip07');
    			chatAdapter.set(new NstrAdapterNip07(pubkey, adapterConfig));
    		});
    	}

    	async function useDiscardableKeys() {
    		chatAdapter.set(new NstrAdapterDiscadableKeys(adapterConfig));
    	}

    	async function useNip46() {
    		let key = localStorage.getItem('nostrichat-nostr-connect-key');
    		let publicKey = localStorage.getItem('nostrichat-nostr-connect-public-key');

    		if (key) {
    			chatAdapter.set(new NstrAdapterNip46(publicKey, key, adapterConfig));
    			return;
    		}

    		key = generatePrivateKey();

    		const connect = new Connect({
    				secretKey: key,
    				relay: 'wss://nostr.vulpem.com'
    			});

    		connect.events.on('connect', connectedPubKey => {
    			localStorage.setItem('nostrichat-nostr-connect-key', key);
    			localStorage.setItem('nostrichat-nostr-connect-public-key', connectedPubKey);
    			localStorage.setItem('nostrichat-type', 'nip-46');
    			console.log('connected to nostr connect relay');
    			publicKey = connectedPubKey;
    			chatAdapter.set(new NstrAdapterNip46(publicKey, key));
    			$$invalidate(0, nip46URI = null);
    		});

    		connect.events.on('disconnect', () => {
    			console.log('disconnected from nostr connect relay');
    		});

    		await connect.init();
    		let windowTitle, currentUrl, currentDomain;

    		try {
    			windowTitle = window.document.title || 'Nostrichat';
    			currentUrl = new URL(window.location.href);
    			currentDomain = currentUrl.hostname;
    		} catch(e) {
    			currentUrl = window.location.href;
    			currentDomain = currentUrl;
    		}

    		const connectURI = new ConnectURI({
    				target: getPublicKey(key),
    				relay: 'wss://nostr.vulpem.com',
    				metadata: {
    					name: windowTitle,
    					description: '🔉🔉🔉',
    					url: currentUrl
    				}
    			});

    		$$invalidate(0, nip46URI = connectURI.toString());
    	}

    	function Nip46Copy() {
    		navigator.clipboard.writeText(nip46URI);
    	}

    	const click_handler = () => {
    		$$invalidate(0, nip46URI = null);
    	};

    	$$self.$$set = $$props => {
    		if ('websiteOwnerPubkey' in $$props) $$invalidate(5, websiteOwnerPubkey = $$props.websiteOwnerPubkey);
    		if ('chatConfiguration' in $$props) $$invalidate(6, chatConfiguration = $$props.chatConfiguration);
    		if ('relays' in $$props) $$invalidate(7, relays = $$props.relays);
    	};

    	return [
    		nip46URI,
    		useNip07,
    		useDiscardableKeys,
    		useNip46,
    		Nip46Copy,
    		websiteOwnerPubkey,
    		chatConfiguration,
    		relays,
    		click_handler
    	];
    }

    class KeyPrompt extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance$4, create_fragment$4, safe_not_equal, {
    			websiteOwnerPubkey: 5,
    			chatConfiguration: 6,
    			relays: 7
    		});
    	}
    }

    /* src/NostrNote.svelte generated by Svelte v3.55.1 */

    function get_each_context$1(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[15] = list[i];
    	return child_ctx;
    }

    // (84:16) {:else}
    function create_else_block$3(ctx) {
    	let div;
    	let t;

    	return {
    		c() {
    			div = element("div");
    			t = text(/*displayName*/ ctx[4]);
    			attr(div, "class", "text-xs text-gray-400 svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, t);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*displayName*/ 16) set_data(t, /*displayName*/ ctx[4]);
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    // (80:16) {#if byWebsiteOwner}
    function create_if_block_1$2(ctx) {
    	let div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "Website owner";
    			attr(div, "class", "text-purple-500 text-xs svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    		},
    		p: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    // (94:0) {#if responses[event.id].length > 0}
    function create_if_block$3(ctx) {
    	let div;
    	let current;
    	let each_value = /*responses*/ ctx[1][/*event*/ ctx[0].id];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$1(get_each_context$1(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			div = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			attr(div, "class", "pl-5 border-l border-l-gray-400 mb-10 svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div, null);
    			}

    			current = true;
    		},
    		p(ctx, dirty) {
    			if (dirty & /*websiteOwnerPubkey, responses, event*/ 7) {
    				each_value = /*responses*/ ctx[1][/*event*/ ctx[0].id];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$1(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block$1(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(div, null);
    					}
    				}

    				group_outros();

    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}

    				check_outros();
    			}
    		},
    		i(local) {
    			if (current) return;

    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},
    		o(local) {
    			each_blocks = each_blocks.filter(Boolean);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    // (96:8) {#each responses[event.id] as response}
    function create_each_block$1(ctx) {
    	let nostrnote;
    	let current;

    	nostrnote = new NostrNote({
    			props: {
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[2],
    				event: /*response*/ ctx[15],
    				responses: /*responses*/ ctx[1]
    			}
    		});

    	return {
    		c() {
    			create_component(nostrnote.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(nostrnote, target, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const nostrnote_changes = {};
    			if (dirty & /*websiteOwnerPubkey*/ 4) nostrnote_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[2];
    			if (dirty & /*responses, event*/ 3) nostrnote_changes.event = /*response*/ ctx[15];
    			if (dirty & /*responses*/ 2) nostrnote_changes.responses = /*responses*/ ctx[1];
    			nostrnote.$set(nostrnote_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(nostrnote.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(nostrnote.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(nostrnote, detaching);
    		}
    	};
    }

    function create_fragment$3(ctx) {
    	let div7;
    	let div6;
    	let div0;
    	let img;
    	let img_src_value;
    	let t0;
    	let div5;
    	let div1;
    	let t1;
    	let div2;
    	let t2_value = /*event*/ ctx[0].content + "";
    	let t2;
    	let div2_class_value;
    	let t3;
    	let div4;
    	let div3;
    	let span;
    	let t5;
    	let t6;
    	let if_block1_anchor;
    	let current;
    	let mounted;
    	let dispose;

    	function select_block_type(ctx, dirty) {
    		if (/*byWebsiteOwner*/ ctx[7]) return create_if_block_1$2;
    		return create_else_block$3;
    	}

    	let current_block_type = select_block_type(ctx);
    	let if_block0 = current_block_type(ctx);
    	let if_block1 = /*responses*/ ctx[1][/*event*/ ctx[0].id].length > 0 && create_if_block$3(ctx);

    	return {
    		c() {
    			div7 = element("div");
    			div6 = element("div");
    			div0 = element("div");
    			img = element("img");
    			t0 = space();
    			div5 = element("div");
    			div1 = element("div");
    			t1 = space();
    			div2 = element("div");
    			t2 = text(t2_value);
    			t3 = space();
    			div4 = element("div");
    			div3 = element("div");
    			span = element("span");
    			span.textContent = `${/*timestamp*/ ctx[8].toLocaleString()}`;
    			t5 = space();
    			if_block0.c();
    			t6 = space();
    			if (if_block1) if_block1.c();
    			if_block1_anchor = empty();
    			if (!src_url_equal(img.src, img_src_value = /*profilePicture*/ ctx[3])) attr(img, "src", img_src_value);

    			attr(img, "class", "block w-10 h-10 rounded-full " + (/*byWebsiteOwner*/ ctx[7]
    			? 'ring-purple-700 ring-4'
    			: 'ring-gray-300 ring-2') + "" + " svelte-t9ifgy");

    			attr(img, "alt", "");
    			attr(div0, "class", "min-w-fit svelte-t9ifgy");
    			attr(div1, "class", "flex flex-row justify-between text-center overflow-clip text-clip w-full svelte-t9ifgy");

    			attr(div2, "class", div2_class_value = "max-h-64 text-base cursor-pointer border border-slate-200 " + (/*$selectedMessage*/ ctx[5] === /*event*/ ctx[0].id
    			? 'bg-purple-700 text-white'
    			: 'bg-slate-50 text-gray-500 hover:bg-slate-100') + " p-4 py-2 overflow-auto rounded-2xl" + " svelte-t9ifgy");

    			attr(span, "class", "py-2 svelte-t9ifgy");
    			attr(div3, "class", "text-xs text-gray-400 text-ellipsis overflow-clip whitespace-nowrap svelte-t9ifgy");
    			attr(div4, "class", "flex flex-row-reverse justify-between mt-1 overflow-clip items-center svelte-t9ifgy");
    			attr(div5, "class", "w-full overflow-hidden svelte-t9ifgy");
    			attr(div6, "class", "flex flex-row gap-4 svelte-t9ifgy");
    			attr(div7, "class", "block p-2-lg mb-3 text-wrap  svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, div7, anchor);
    			append(div7, div6);
    			append(div6, div0);
    			append(div0, img);
    			append(div6, t0);
    			append(div6, div5);
    			append(div5, div1);
    			append(div5, t1);
    			append(div5, div2);
    			append(div2, t2);
    			append(div5, t3);
    			append(div5, div4);
    			append(div4, div3);
    			append(div3, span);
    			append(div4, t5);
    			if_block0.m(div4, null);
    			insert(target, t6, anchor);
    			if (if_block1) if_block1.m(target, anchor);
    			insert(target, if_block1_anchor, anchor);
    			current = true;

    			if (!mounted) {
    				dispose = listen(div2, "click", prevent_default(/*click_handler*/ ctx[11]));
    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (!current || dirty & /*profilePicture*/ 8 && !src_url_equal(img.src, img_src_value = /*profilePicture*/ ctx[3])) {
    				attr(img, "src", img_src_value);
    			}

    			if ((!current || dirty & /*event*/ 1) && t2_value !== (t2_value = /*event*/ ctx[0].content + "")) set_data(t2, t2_value);

    			if (!current || dirty & /*$selectedMessage, event*/ 33 && div2_class_value !== (div2_class_value = "max-h-64 text-base cursor-pointer border border-slate-200 " + (/*$selectedMessage*/ ctx[5] === /*event*/ ctx[0].id
    			? 'bg-purple-700 text-white'
    			: 'bg-slate-50 text-gray-500 hover:bg-slate-100') + " p-4 py-2 overflow-auto rounded-2xl" + " svelte-t9ifgy")) {
    				attr(div2, "class", div2_class_value);
    			}

    			if_block0.p(ctx, dirty);

    			if (/*responses*/ ctx[1][/*event*/ ctx[0].id].length > 0) {
    				if (if_block1) {
    					if_block1.p(ctx, dirty);

    					if (dirty & /*responses, event*/ 3) {
    						transition_in(if_block1, 1);
    					}
    				} else {
    					if_block1 = create_if_block$3(ctx);
    					if_block1.c();
    					transition_in(if_block1, 1);
    					if_block1.m(if_block1_anchor.parentNode, if_block1_anchor);
    				}
    			} else if (if_block1) {
    				group_outros();

    				transition_out(if_block1, 1, 1, () => {
    					if_block1 = null;
    				});

    				check_outros();
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block1);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block1);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div7);
    			if_block0.d();
    			if (detaching) detach(t6);
    			if (if_block1) if_block1.d(detaching);
    			if (detaching) detach(if_block1_anchor);
    			mounted = false;
    			dispose();
    		}
    	};
    }

    function instance$3($$self, $$props, $$invalidate) {
    	let displayName;
    	let $chatData;
    	let $chatAdapter;
    	let $selectedMessage;
    	component_subscribe($$self, chatData, $$value => $$invalidate(10, $chatData = $$value));
    	component_subscribe($$self, chatAdapter, $$value => $$invalidate(13, $chatAdapter = $$value));
    	component_subscribe($$self, selectedMessage, $$value => $$invalidate(5, $selectedMessage = $$value));
    	let { event } = $$props;
    	let { responses } = $$props;
    	let { websiteOwnerPubkey } = $$props;
    	let profiles = {};
    	let profilePicture;

    	function selectMessage() {
    		if ($selectedMessage === event.id) {
    			set_store_value(selectedMessage, $selectedMessage = null, $selectedMessage);
    		} else {
    			set_store_value(selectedMessage, $selectedMessage = event.id, $selectedMessage);
    		}
    	}

    	// delay-fetch responses
    	onMount(() => {
    		$chatAdapter.delayedSubscribe({ kinds: [1], '#e': [event.id] }, 'responses', 500);
    	});

    	const byWebsiteOwner = !!websiteOwnerPubkey === event.pubkey;
    	event.tags.filter(e => e[0] === 'e').map(e => e[1]);
    	let timestamp = new Date(event.created_at * 1000);

    	const click_handler = () => {
    		selectMessage(event.id);
    	};

    	$$self.$$set = $$props => {
    		if ('event' in $$props) $$invalidate(0, event = $$props.event);
    		if ('responses' in $$props) $$invalidate(1, responses = $$props.responses);
    		if ('websiteOwnerPubkey' in $$props) $$invalidate(2, websiteOwnerPubkey = $$props.websiteOwnerPubkey);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*$chatData*/ 1024) {
    			$$invalidate(9, profiles = $chatData.profiles);
    		}

    		if ($$self.$$.dirty & /*profiles, event*/ 513) {
    			$$invalidate(4, displayName = profiles[event.pubkey] && profiles[event.pubkey].display_name || `[${event.pubkey.slice(0, 6)}]`);
    		}

    		if ($$self.$$.dirty & /*profiles, event*/ 513) {
    			profiles[event.pubkey] && profiles[event.pubkey].nip05;
    		}

    		if ($$self.$$.dirty & /*profiles, event*/ 513) {
    			$$invalidate(3, profilePicture = profiles[event.pubkey] && profiles[event.pubkey].picture || `https://robohash.org/${event.pubkey.slice(0, 2)}.png?set=set1`);
    		}
    	};

    	return [
    		event,
    		responses,
    		websiteOwnerPubkey,
    		profilePicture,
    		displayName,
    		$selectedMessage,
    		selectMessage,
    		byWebsiteOwner,
    		timestamp,
    		profiles,
    		$chatData,
    		click_handler
    	];
    }

    class NostrNote extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance$3, create_fragment$3, safe_not_equal, {
    			event: 0,
    			responses: 1,
    			websiteOwnerPubkey: 2
    		});
    	}
    }

    function cubicInOut(t) {
        return t < 0.5 ? 4.0 * t * t * t : 0.5 * Math.pow(2.0 * t - 2.0, 3.0) + 1.0;
    }

    var _ = {
      $(selector) {
        if (typeof selector === "string") {
          return document.querySelector(selector);
        }
        return selector;
      },
      extend(...args) {
        return Object.assign(...args);
      },
      cumulativeOffset(element) {
        let top = 0;
        let left = 0;

        do {
          top += element.offsetTop || 0;
          left += element.offsetLeft || 0;
          element = element.offsetParent;
        } while (element);

        return {
          top: top,
          left: left
        };
      },
      directScroll(element) {
        return element && element !== document && element !== document.body;
      },
      scrollTop(element, value) {
        let inSetter = value !== undefined;
        if (this.directScroll(element)) {
          return inSetter ? (element.scrollTop = value) : element.scrollTop;
        } else {
          return inSetter
            ? (document.documentElement.scrollTop = document.body.scrollTop = value)
            : window.pageYOffset ||
                document.documentElement.scrollTop ||
                document.body.scrollTop ||
                0;
        }
      },
      scrollLeft(element, value) {
        let inSetter = value !== undefined;
        if (this.directScroll(element)) {
          return inSetter ? (element.scrollLeft = value) : element.scrollLeft;
        } else {
          return inSetter
            ? (document.documentElement.scrollLeft = document.body.scrollLeft = value)
            : window.pageXOffset ||
                document.documentElement.scrollLeft ||
                document.body.scrollLeft ||
                0;
        }
      }
    };

    const defaultOptions = {
      container: "body",
      duration: 500,
      delay: 0,
      offset: 0,
      easing: cubicInOut,
      onStart: noop,
      onDone: noop,
      onAborting: noop,
      scrollX: false,
      scrollY: true
    };

    const _scrollTo = options => {
      let {
        offset,
        duration,
        delay,
        easing,
        x=0,
        y=0,
        scrollX,
        scrollY,
        onStart,
        onDone,
        container,
        onAborting,
        element
      } = options;

      if (typeof offset === "function") {
        offset = offset();
      }

      var cumulativeOffsetContainer = _.cumulativeOffset(container);
      var cumulativeOffsetTarget = element
        ? _.cumulativeOffset(element)
        : { top: y, left: x };

      var initialX = _.scrollLeft(container);
      var initialY = _.scrollTop(container);

      var targetX =
        cumulativeOffsetTarget.left - cumulativeOffsetContainer.left + offset;
      var targetY =
        cumulativeOffsetTarget.top - cumulativeOffsetContainer.top + offset;

      var diffX = targetX - initialX;
    	var diffY = targetY - initialY;

      let scrolling = true;
      let started = false;
      let start_time = now$1() + delay;
      let end_time = start_time + duration;

      function scrollToTopLeft(element, top, left) {
        if (scrollX) _.scrollLeft(element, left);
        if (scrollY) _.scrollTop(element, top);
      }

      function start(delayStart) {
        if (!delayStart) {
          started = true;
          onStart(element, {x, y});
        }
      }

      function tick(progress) {
        scrollToTopLeft(
          container,
          initialY + diffY * progress,
          initialX + diffX * progress
        );
      }

      function stop() {
        scrolling = false;
      }

      loop(now => {
        if (!started && now >= start_time) {
          start(false);
        }

        if (started && now >= end_time) {
          tick(1);
          stop();
          onDone(element, {x, y});
        }

        if (!scrolling) {
          onAborting(element, {x, y});
          return false;
        }
        if (started) {
          const p = now - start_time;
          const t = 0 + 1 * easing(p / duration);
          tick(t);
        }

        return true;
      });

      start(delay);

      tick(0);

      return stop;
    };

    const proceedOptions = options => {
    	let opts = _.extend({}, defaultOptions, options);
      opts.container = _.$(opts.container);
      opts.element = _.$(opts.element);
      return opts;
    };

    const scrollContainerHeight = containerElement => {
      if (
        containerElement &&
        containerElement !== document &&
        containerElement !== document.body
      ) {
        return containerElement.scrollHeight - containerElement.offsetHeight;
      } else {
        let body = document.body;
        let html = document.documentElement;

        return Math.max(
          body.scrollHeight,
          body.offsetHeight,
          html.clientHeight,
          html.scrollHeight,
          html.offsetHeight
        );
      }
    };

    const scrollToBottom = options => {
      options = proceedOptions(options);

      return _scrollTo(
        _.extend(options, {
          element: null,
          y: scrollContainerHeight(options.container)
        })
      );
    };

    /* src/ConnectedWidget.svelte generated by Svelte v3.55.1 */

    function get_each_context(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[23] = list[i];
    	return child_ctx;
    }

    function get_each_context_1(ctx, list, i) {
    	const child_ctx = ctx.slice();
    	child_ctx[26] = list[i];
    	child_ctx[28] = i;
    	return child_ctx;
    }

    // (227:8) {#if $chatAdapter?.pubkey}
    function create_if_block_5(ctx) {
    	let t;

    	return {
    		c() {
    			t = text(/*ownName*/ ctx[7]);
    		},
    		m(target, anchor) {
    			insert(target, t, anchor);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*ownName*/ 128) set_data(t, /*ownName*/ ctx[7]);
    		},
    		d(detaching) {
    			if (detaching) detach(t);
    		}
    	};
    }

    // (234:12) {#each Array(totalRelays) as _, i}
    function create_each_block_1(ctx) {
    	let span;
    	let span_class_value;

    	return {
    		c() {
    			span = element("span");

    			attr(span, "class", span_class_value = "inline-block rounded-full " + (/*connectedRelays*/ ctx[5] > /*i*/ ctx[28]
    			? 'bg-green-500'
    			: 'bg-gray-300') + " w-2 h-2" + " svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, span, anchor);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*connectedRelays*/ 32 && span_class_value !== (span_class_value = "inline-block rounded-full " + (/*connectedRelays*/ ctx[5] > /*i*/ ctx[28]
    			? 'bg-green-500'
    			: 'bg-gray-300') + " w-2 h-2" + " svelte-117e9f7")) {
    				attr(span, "class", span_class_value);
    			}
    		},
    		d(detaching) {
    			if (detaching) detach(span);
    		}
    	};
    }

    // (248:0) {#if $selectedMessage}
    function create_if_block_3(ctx) {
    	let show_if;
    	let if_block_anchor;

    	function select_block_type(ctx, dirty) {
    		if (dirty & /*$selectedMessage*/ 256) show_if = null;
    		if (show_if == null) show_if = !!!/*getEventById*/ ctx[9](/*$selectedMessage*/ ctx[8]);
    		if (show_if) return create_if_block_4;
    		return create_else_block_2;
    	}

    	let current_block_type = select_block_type(ctx, -1);
    	let if_block = current_block_type(ctx);

    	return {
    		c() {
    			if_block.c();
    			if_block_anchor = empty();
    		},
    		m(target, anchor) {
    			if_block.m(target, anchor);
    			insert(target, if_block_anchor, anchor);
    		},
    		p(ctx, dirty) {
    			if (current_block_type === (current_block_type = select_block_type(ctx, dirty)) && if_block) {
    				if_block.p(ctx, dirty);
    			} else {
    				if_block.d(1);
    				if_block = current_block_type(ctx);

    				if (if_block) {
    					if_block.c();
    					if_block.m(if_block_anchor.parentNode, if_block_anchor);
    				}
    			}
    		},
    		d(detaching) {
    			if_block.d(detaching);
    			if (detaching) detach(if_block_anchor);
    		}
    	};
    }

    // (251:4) {:else}
    function create_else_block_2(ctx) {
    	let div1;
    	let a;
    	let t0;
    	let div0;
    	let span;
    	let t1_value = /*getEventById*/ ctx[9](/*$selectedMessage*/ ctx[8]).content + "";
    	let t1;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div1 = element("div");
    			a = element("a");
    			a.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 svelte-117e9f7"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15m0 0l6.75 6.75M4.5 12l6.75-6.75" class="svelte-117e9f7"></path></svg>`;
    			t0 = space();
    			div0 = element("div");
    			span = element("span");
    			t1 = text(t1_value);
    			attr(a, "href", "#");
    			attr(a, "class", "svelte-117e9f7");
    			attr(span, "class", "text-lg text-black overflow-hidden whitespace-nowrap text-ellipsis svelte-117e9f7");
    			attr(div0, "class", "flex flex-col ml-2 svelte-117e9f7");
    			attr(div1, "class", "flex flex-row mb-3 svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, div1, anchor);
    			append(div1, a);
    			append(div1, t0);
    			append(div1, div0);
    			append(div0, span);
    			append(span, t1);

    			if (!mounted) {
    				dispose = listen(a, "click", prevent_default(/*selectParent*/ ctx[12]));
    				mounted = true;
    			}
    		},
    		p(ctx, dirty) {
    			if (dirty & /*$selectedMessage*/ 256 && t1_value !== (t1_value = /*getEventById*/ ctx[9](/*$selectedMessage*/ ctx[8]).content + "")) set_data(t1, t1_value);
    		},
    		d(detaching) {
    			if (detaching) detach(div1);
    			mounted = false;
    			dispose();
    		}
    	};
    }

    // (249:4) {#if !getEventById($selectedMessage)}
    function create_if_block_4(ctx) {
    	let h1;
    	let t0;
    	let t1;

    	return {
    		c() {
    			h1 = element("h1");
    			t0 = text("Couldn't find event with ID ");
    			t1 = text(/*$selectedMessage*/ ctx[8]);
    			attr(h1, "class", "svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, h1, anchor);
    			append(h1, t0);
    			append(h1, t1);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*$selectedMessage*/ 256) set_data(t1, /*$selectedMessage*/ ctx[8]);
    		},
    		d(detaching) {
    			if (detaching) detach(h1);
    		}
    	};
    }

    // (272:8) {:else}
    function create_else_block_1(ctx) {
    	let each_1_anchor;
    	let current;
    	let each_value = /*events*/ ctx[3];
    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			each_1_anchor = empty();
    		},
    		m(target, anchor) {
    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(target, anchor);
    			}

    			insert(target, each_1_anchor, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			if (dirty & /*events, responses, websiteOwnerPubkey*/ 25) {
    				each_value = /*events*/ ctx[3];
    				let i;

    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(each_1_anchor.parentNode, each_1_anchor);
    					}
    				}

    				group_outros();

    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}

    				check_outros();
    			}
    		},
    		i(local) {
    			if (current) return;

    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},
    		o(local) {
    			each_blocks = each_blocks.filter(Boolean);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},
    		d(detaching) {
    			destroy_each(each_blocks, detaching);
    			if (detaching) detach(each_1_anchor);
    		}
    	};
    }

    // (270:8) {#if $selectedMessage}
    function create_if_block_1$1(ctx) {
    	let nostrnote;
    	let current;

    	nostrnote = new NostrNote({
    			props: {
    				event: /*getEventById*/ ctx[9](/*$selectedMessage*/ ctx[8]),
    				responses: /*responses*/ ctx[4],
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[0]
    			}
    		});

    	return {
    		c() {
    			create_component(nostrnote.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(nostrnote, target, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const nostrnote_changes = {};
    			if (dirty & /*$selectedMessage*/ 256) nostrnote_changes.event = /*getEventById*/ ctx[9](/*$selectedMessage*/ ctx[8]);
    			if (dirty & /*responses*/ 16) nostrnote_changes.responses = /*responses*/ ctx[4];
    			if (dirty & /*websiteOwnerPubkey*/ 1) nostrnote_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[0];
    			nostrnote.$set(nostrnote_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(nostrnote.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(nostrnote.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(nostrnote, detaching);
    		}
    	};
    }

    // (275:16) {#if event.deleted}
    function create_if_block_2(ctx) {
    	let t;

    	return {
    		c() {
    			t = text("👆 deleted");
    		},
    		m(target, anchor) {
    			insert(target, t, anchor);
    		},
    		d(detaching) {
    			if (detaching) detach(t);
    		}
    	};
    }

    // (273:12) {#each events as event}
    function create_each_block(ctx) {
    	let nostrnote;
    	let t;
    	let if_block_anchor;
    	let current;

    	nostrnote = new NostrNote({
    			props: {
    				event: /*event*/ ctx[23],
    				responses: /*responses*/ ctx[4],
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[0]
    			}
    		});

    	let if_block = /*event*/ ctx[23].deleted && create_if_block_2();

    	return {
    		c() {
    			create_component(nostrnote.$$.fragment);
    			t = space();
    			if (if_block) if_block.c();
    			if_block_anchor = empty();
    		},
    		m(target, anchor) {
    			mount_component(nostrnote, target, anchor);
    			insert(target, t, anchor);
    			if (if_block) if_block.m(target, anchor);
    			insert(target, if_block_anchor, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const nostrnote_changes = {};
    			if (dirty & /*events*/ 8) nostrnote_changes.event = /*event*/ ctx[23];
    			if (dirty & /*responses*/ 16) nostrnote_changes.responses = /*responses*/ ctx[4];
    			if (dirty & /*websiteOwnerPubkey*/ 1) nostrnote_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[0];
    			nostrnote.$set(nostrnote_changes);

    			if (/*event*/ ctx[23].deleted) {
    				if (if_block) ; else {
    					if_block = create_if_block_2();
    					if_block.c();
    					if_block.m(if_block_anchor.parentNode, if_block_anchor);
    				}
    			} else if (if_block) {
    				if_block.d(1);
    				if_block = null;
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(nostrnote.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(nostrnote.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(nostrnote, detaching);
    			if (detaching) detach(t);
    			if (if_block) if_block.d(detaching);
    			if (detaching) detach(if_block_anchor);
    		}
    	};
    }

    // (293:8) {:else}
    function create_else_block$2(ctx) {
    	let b;
    	let t1;

    	return {
    		c() {
    			b = element("b");
    			b.textContent = "Public chat:";
    			t1 = text("\n            anyone can see these messages.");
    			attr(b, "class", "svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, b, anchor);
    			insert(target, t1, anchor);
    		},
    		d(detaching) {
    			if (detaching) detach(b);
    			if (detaching) detach(t1);
    		}
    	};
    }

    // (290:8) {#if chatConfiguration.chatType === 'DM'}
    function create_if_block$2(ctx) {
    	let b;
    	let t1;

    	return {
    		c() {
    			b = element("b");
    			b.textContent = "Encrypted chat:";
    			t1 = text("\n            only your chat partner can see these messages.");
    			attr(b, "class", "svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, b, anchor);
    			insert(target, t1, anchor);
    		},
    		d(detaching) {
    			if (detaching) detach(b);
    			if (detaching) detach(t1);
    		}
    	};
    }

    function create_fragment$2(ctx) {
    	let div2;
    	let div0;
    	let t0;
    	let span;
    	let div1;
    	let t1;
    	let t2;
    	let t3;
    	let t4;
    	let t5;
    	let t6;
    	let t7;
    	let div4;
    	let div3;
    	let current_block_type_index;
    	let if_block2;
    	let t8;
    	let div7;
    	let div5;
    	let t9;
    	let div6;
    	let textarea;
    	let t10;
    	let button;
    	let current;
    	let mounted;
    	let dispose;
    	let if_block0 = /*$chatAdapter*/ ctx[2]?.pubkey && create_if_block_5(ctx);
    	let each_value_1 = Array(/*totalRelays*/ ctx[6]);
    	let each_blocks = [];

    	for (let i = 0; i < each_value_1.length; i += 1) {
    		each_blocks[i] = create_each_block_1(get_each_context_1(ctx, each_value_1, i));
    	}

    	let if_block1 = /*$selectedMessage*/ ctx[8] && create_if_block_3(ctx);
    	const if_block_creators = [create_if_block_1$1, create_else_block_1];
    	const if_blocks = [];

    	function select_block_type_1(ctx, dirty) {
    		if (/*$selectedMessage*/ ctx[8]) return 0;
    		return 1;
    	}

    	current_block_type_index = select_block_type_1(ctx);
    	if_block2 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

    	function select_block_type_2(ctx, dirty) {
    		if (/*chatConfiguration*/ ctx[1].chatType === 'DM') return create_if_block$2;
    		return create_else_block$2;
    	}

    	let current_block_type = select_block_type_2(ctx);
    	let if_block3 = current_block_type(ctx);

    	return {
    		c() {
    			div2 = element("div");
    			div0 = element("div");
    			if (if_block0) if_block0.c();
    			t0 = space();
    			span = element("span");
    			div1 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t1 = space();
    			t2 = text(/*connectedRelays*/ ctx[5]);
    			t3 = text("/");
    			t4 = text(/*totalRelays*/ ctx[6]);
    			t5 = text(" relays");
    			t6 = space();
    			if (if_block1) if_block1.c();
    			t7 = space();
    			div4 = element("div");
    			div3 = element("div");
    			if_block2.c();
    			t8 = space();
    			div7 = element("div");
    			div5 = element("div");
    			if_block3.c();
    			t9 = space();
    			div6 = element("div");
    			textarea = element("textarea");
    			t10 = space();
    			button = element("button");
    			button.innerHTML = `<svg aria-hidden="true" class="w-6 h-6 rotate-90 svelte-117e9f7" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" class="svelte-117e9f7"></path></svg>`;
    			attr(div0, "class", "text-lg font-semibold svelte-117e9f7");
    			attr(div1, "class", "flex flex-row gap-1 overflow-clip svelte-117e9f7");
    			attr(span, "class", "text-xs flex flex-col items-end mt-2 text-gray-200 gap-1 svelte-117e9f7");
    			attr(div2, "class", "bg-purple-700 text-white -m-5 mb-3 px-5 py-3 overflow-clip flex flex-row justify-between items-center  svelte-117e9f7");
    			attr(div3, "id", "messages-container-inner");
    			attr(div3, "class", "svelte-117e9f7");
    			attr(div4, "id", "messages-container");
    			attr(div4, "class", "overflow-auto -mx-4 px-4 svelte-117e9f7");
    			set_style(div4, "height", "50vh");
    			set_style(div4, "min-height", "300px");
    			attr(div5, "class", "border-y border-y-slate-200 -mx-5 my-2 bg-slate-100 text-black text-sm px-5 py-2  svelte-117e9f7");
    			attr(textarea, "type", "text");
    			attr(textarea, "id", "message-input");
    			attr(textarea, "class", "-mb-2 p-2 w-full resize-none rounded-xl text-gray-600 border  svelte-117e9f7");
    			attr(textarea, "placeholder", "Say hello!");
    			attr(textarea, "rows", "1");
    			attr(button, "type", "button");
    			attr(button, "class", "inline-flex items-center rounded-full border border-transparent bg-purple-700 p-3 text-white shadow-sm hover:bg-purple-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 svelte-117e9f7");
    			attr(div6, "class", "flex flex-row gap-2 -mx-1 svelte-117e9f7");
    			attr(div7, "class", "flex flex-col svelte-117e9f7");
    		},
    		m(target, anchor) {
    			insert(target, div2, anchor);
    			append(div2, div0);
    			if (if_block0) if_block0.m(div0, null);
    			append(div2, t0);
    			append(div2, span);
    			append(span, div1);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div1, null);
    			}

    			append(span, t1);
    			append(span, t2);
    			append(span, t3);
    			append(span, t4);
    			append(span, t5);
    			insert(target, t6, anchor);
    			if (if_block1) if_block1.m(target, anchor);
    			insert(target, t7, anchor);
    			insert(target, div4, anchor);
    			append(div4, div3);
    			if_blocks[current_block_type_index].m(div3, null);
    			insert(target, t8, anchor);
    			insert(target, div7, anchor);
    			append(div7, div5);
    			if_block3.m(div5, null);
    			append(div7, t9);
    			append(div7, div6);
    			append(div6, textarea);
    			append(div6, t10);
    			append(div6, button);
    			current = true;

    			if (!mounted) {
    				dispose = [
    					listen(textarea, "keydown", /*inputKeyDown*/ ctx[11]),
    					listen(button, "click", prevent_default(/*sendMessage*/ ctx[10]))
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (/*$chatAdapter*/ ctx[2]?.pubkey) {
    				if (if_block0) {
    					if_block0.p(ctx, dirty);
    				} else {
    					if_block0 = create_if_block_5(ctx);
    					if_block0.c();
    					if_block0.m(div0, null);
    				}
    			} else if (if_block0) {
    				if_block0.d(1);
    				if_block0 = null;
    			}

    			if (dirty & /*connectedRelays, totalRelays*/ 96) {
    				each_value_1 = Array(/*totalRelays*/ ctx[6]);
    				let i;

    				for (i = 0; i < each_value_1.length; i += 1) {
    					const child_ctx = get_each_context_1(ctx, each_value_1, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(child_ctx, dirty);
    					} else {
    						each_blocks[i] = create_each_block_1(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div1, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}

    				each_blocks.length = each_value_1.length;
    			}

    			if (!current || dirty & /*connectedRelays*/ 32) set_data(t2, /*connectedRelays*/ ctx[5]);
    			if (!current || dirty & /*totalRelays*/ 64) set_data(t4, /*totalRelays*/ ctx[6]);

    			if (/*$selectedMessage*/ ctx[8]) {
    				if (if_block1) {
    					if_block1.p(ctx, dirty);
    				} else {
    					if_block1 = create_if_block_3(ctx);
    					if_block1.c();
    					if_block1.m(t7.parentNode, t7);
    				}
    			} else if (if_block1) {
    				if_block1.d(1);
    				if_block1 = null;
    			}

    			let previous_block_index = current_block_type_index;
    			current_block_type_index = select_block_type_1(ctx);

    			if (current_block_type_index === previous_block_index) {
    				if_blocks[current_block_type_index].p(ctx, dirty);
    			} else {
    				group_outros();

    				transition_out(if_blocks[previous_block_index], 1, 1, () => {
    					if_blocks[previous_block_index] = null;
    				});

    				check_outros();
    				if_block2 = if_blocks[current_block_type_index];

    				if (!if_block2) {
    					if_block2 = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    					if_block2.c();
    				} else {
    					if_block2.p(ctx, dirty);
    				}

    				transition_in(if_block2, 1);
    				if_block2.m(div3, null);
    			}

    			if (current_block_type !== (current_block_type = select_block_type_2(ctx))) {
    				if_block3.d(1);
    				if_block3 = current_block_type(ctx);

    				if (if_block3) {
    					if_block3.c();
    					if_block3.m(div5, null);
    				}
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block2);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block2);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div2);
    			if (if_block0) if_block0.d();
    			destroy_each(each_blocks, detaching);
    			if (detaching) detach(t6);
    			if (if_block1) if_block1.d(detaching);
    			if (detaching) detach(t7);
    			if (detaching) detach(div4);
    			if_blocks[current_block_type_index].d();
    			if (detaching) detach(t8);
    			if (detaching) detach(div7);
    			if_block3.d();
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance$2($$self, $$props, $$invalidate) {
    	let $chatAdapter;
    	let $selectedMessage;
    	let $chatData;
    	component_subscribe($$self, chatAdapter, $$value => $$invalidate(2, $chatAdapter = $$value));
    	component_subscribe($$self, selectedMessage, $$value => $$invalidate(8, $selectedMessage = $$value));
    	component_subscribe($$self, chatData, $$value => $$invalidate(16, $chatData = $$value));
    	let events = [];
    	let responseEvents = [];
    	let responses = {};
    	let profiles = {};
    	let { websiteOwnerPubkey } = $$props;
    	let { chatConfiguration } = $$props;
    	let prevChatConfiguration;

    	function getEventById(eventId) {
    		let event = events.find(e => e.id === eventId);
    		event = event || responseEvents.find(e => e.id === eventId);
    		return event;
    	}

    	async function sendMessage() {
    		const input = document.getElementById('message-input');
    		const message = input.value;
    		input.value = '';
    		let extraParams = { tags: [], tagPubKeys: [] };

    		// if this is the rootLevel we want to tag the owner of the site's pubkey
    		if (!rootNoteId && websiteOwnerPubkey) {
    			extraParams.tagPubKeys = [websiteOwnerPubkey];
    		}

    		// if we are responding to an event, we want to tag the event and the pubkey
    		if ($selectedMessage) {
    			extraParams.tags.push(['e', $selectedMessage]);
    			extraParams.tagPubKeys.push(getEventById($selectedMessage).pubkey);
    		}

    		// if (rootNoteId) {
    		//     // mark it as a response to the most recent event
    		//     const mostRecentEvent = events[events.length - 1];
    		//     // go through all the tags and add them to the new message
    		//     if (mostRecentEvent) {
    		//         mostRecentEvent.tags.forEach(tag => {
    		//             if (tag[0] === 'e') {
    		//                 extraParams.tags.push(tag);
    		//             }
    		//         })
    		//         extraParams.tags.push(['e', mostRecentEvent.id]);
    		//         extraParams.tags.push(['p', mostRecentEvent.pubkey]);
    		//     }
    		// }
    		const noteId = await $chatAdapter.send(message, extraParams);

    		if (!rootNoteId) {
    			rootNoteId = noteId;
    			localStorage.setItem('rootNoteId', rootNoteId);
    		}
    	}

    	async function inputKeyDown(event) {
    		if (event.key === 'Enter') {
    			sendMessage();
    			event.preventDefault();
    		}
    	}

    	function messageReceived(message) {
    		message.tags.filter(tag => tag[0] === 'e').pop();
    		let isThread;

    		if (chatConfiguration.chatType === 'GLOBAL') {
    			isThread = message.tags.filter(tag => tag[0] === 'e').length >= 1;
    		} else {
    			const pubkeysTagged = message.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
    			isThread = new Set(pubkeysTagged).size >= 2;
    		}

    		if (!responses[message.id]) {
    			$$invalidate(4, responses[message.id] = [], responses);
    		}

    		if (isThread) {
    			// get the last "e" tag, which is tagging the immediate parent
    			const lastETag = message.tags.filter(tag => tag[0] === 'e').pop();

    			if (lastETag && lastETag[1]) {
    				// if there is one, add it to the response
    				if (!responses[lastETag[1]]) {
    					$$invalidate(4, responses[lastETag[1]] = [], responses);
    				}

    				responses[lastETag[1]].push(message);
    			}

    			responseEvents.push(message);
    			responseEvents = responseEvents;
    		} else {
    			// insert message so that it's chronologically ordered by created_at
    			let index = 0;

    			while (index < events.length && events[index].created_at < message.created_at) {
    				index++;
    			}

    			events.splice(index, 0, message);
    			((($$invalidate(3, events), $$invalidate(1, chatConfiguration)), $$invalidate(14, prevChatConfiguration)), $$invalidate(2, $chatAdapter));
    		}

    		((($$invalidate(4, responses), $$invalidate(1, chatConfiguration)), $$invalidate(14, prevChatConfiguration)), $$invalidate(2, $chatAdapter));
    		scrollDown();
    	}

    	function scrollDown() {
    		scrollToBottom({
    			container: document.getElementById('messages-container'),
    			offset: 999999, // hack, oh well, browsers suck
    			duration: 50
    		});
    	}

    	function reactionReceived(reaction) {
    		const event = events.find(event => event.id === reaction.id);

    		if (!event) {
    			return;
    		}

    		event.reactions = event.reactions || [];
    		event.reactions.push(reaction);
    		((($$invalidate(3, events), $$invalidate(1, chatConfiguration)), $$invalidate(14, prevChatConfiguration)), $$invalidate(2, $chatAdapter));
    	}

    	let rootNoteId;

    	onMount(() => {
    		$chatAdapter.on('message', messageReceived);

    		$chatAdapter.on('connectivity', e => {
    			$$invalidate(15, connectivityStatus = e);
    		});

    		$chatAdapter.on('reaction', reactionReceived);

    		$chatAdapter.on('deleted', deletedEvents => {
    			deletedEvents.forEach(deletedEventId => {
    				const index = events.findIndex(event => event.id === deletedEventId);

    				if (index !== -1) {
    					$$invalidate(3, events[index].deleted = true, events);
    					((($$invalidate(3, events), $$invalidate(1, chatConfiguration)), $$invalidate(14, prevChatConfiguration)), $$invalidate(2, $chatAdapter));
    				}
    			});
    		});

    		$chatAdapter.on('profile', ({ pubkey, profile }) => {
    			let profiles = $chatData.profiles;
    			profiles[pubkey] = profile;
    			chatData.set({ profiles, ...$chatData });
    		});
    	});

    	let connectivityStatus = {};
    	let connectedRelays = 0;
    	let totalRelays = 0;

    	function selectParent() {
    		// get the last tagged event in the tags array of the current $selectedMessage
    		const lastETag = getEventById($selectedMessage).tags.filter(tag => tag[0] === 'e').pop();

    		const lastETagId = lastETag && lastETag[1];
    		set_store_value(selectedMessage, $selectedMessage = lastETagId, $selectedMessage);
    		scrollDown();
    	}

    	let ownName;

    	function pubkeyName(pubkey) {
    		let name;

    		if (profiles[$chatAdapter.pubkey]) {
    			let self = profiles[$chatAdapter.pubkey];

    			// https://xkcd.com/927/
    			name = self.display_name || self.displayName || self.name || self.nip05;
    		}

    		if (!name) {
    			name = `[${pubkey.slice(0, 6)}]`;
    		}

    		return name;
    	}

    	$$self.$$set = $$props => {
    		if ('websiteOwnerPubkey' in $$props) $$invalidate(0, websiteOwnerPubkey = $$props.websiteOwnerPubkey);
    		if ('chatConfiguration' in $$props) $$invalidate(1, chatConfiguration = $$props.chatConfiguration);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*chatConfiguration, prevChatConfiguration, $chatAdapter*/ 16390) {
    			{
    				if (chatConfiguration !== prevChatConfiguration && prevChatConfiguration && $chatAdapter) {
    					$chatAdapter.setChatConfiguration(chatConfiguration.chatType, chatConfiguration.chatTags, chatConfiguration.chatReferenceTags);
    					$$invalidate(3, events = []);
    					$$invalidate(4, responses = {});
    					rootNoteId = null;
    					localStorage.removeItem('rootNoteId');
    				} // rootNoteId = localStorage.getItem('rootNoteId');
    				// if (rootNoteId) {

    				//     $chatAdapter.subscribeToEventAndResponses(rootNoteId);
    				// }
    				$$invalidate(14, prevChatConfiguration = chatConfiguration);
    			}
    		}

    		if ($$self.$$.dirty & /*$chatData*/ 65536) {
    			$$invalidate(13, profiles = $chatData.profiles);
    		}

    		if ($$self.$$.dirty & /*connectivityStatus, $chatAdapter, profiles*/ 40964) {
    			{
    				$$invalidate(5, connectedRelays = Object.values(connectivityStatus).filter(status => status === 'connected').length);
    				$$invalidate(6, totalRelays = Object.values(connectivityStatus).length);

    				if ($chatAdapter?.pubkey && !profiles[$chatAdapter.pubkey]) {
    					$chatAdapter.reqProfile($chatAdapter.pubkey);
    				}
    			}
    		}

    		if ($$self.$$.dirty & /*$chatAdapter*/ 4) {
    			$$invalidate(7, ownName = ($chatAdapter?.pubkey)
    			? pubkeyName($chatAdapter.pubkey)
    			: "");
    		}
    	};

    	return [
    		websiteOwnerPubkey,
    		chatConfiguration,
    		$chatAdapter,
    		events,
    		responses,
    		connectedRelays,
    		totalRelays,
    		ownName,
    		$selectedMessage,
    		getEventById,
    		sendMessage,
    		inputKeyDown,
    		selectParent,
    		profiles,
    		prevChatConfiguration,
    		connectivityStatus,
    		$chatData
    	];
    }

    class ConnectedWidget extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance$2, create_fragment$2, safe_not_equal, {
    			websiteOwnerPubkey: 0,
    			chatConfiguration: 1
    		});
    	}
    }

    /* src/Container.svelte generated by Svelte v3.55.1 */

    function create_else_block$1(ctx) {
    	let connectedwidget;
    	let current;

    	connectedwidget = new ConnectedWidget({
    			props: {
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[1],
    				chatConfiguration: /*chatConfiguration*/ ctx[2],
    				relays: /*relays*/ ctx[3]
    			}
    		});

    	return {
    		c() {
    			create_component(connectedwidget.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(connectedwidget, target, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const connectedwidget_changes = {};
    			if (dirty & /*websiteOwnerPubkey*/ 2) connectedwidget_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[1];
    			if (dirty & /*chatConfiguration*/ 4) connectedwidget_changes.chatConfiguration = /*chatConfiguration*/ ctx[2];
    			if (dirty & /*relays*/ 8) connectedwidget_changes.relays = /*relays*/ ctx[3];
    			connectedwidget.$set(connectedwidget_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(connectedwidget.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(connectedwidget.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(connectedwidget, detaching);
    		}
    	};
    }

    // (14:0) {#if !chatStarted}
    function create_if_block$1(ctx) {
    	let keyprompt;
    	let current;

    	keyprompt = new KeyPrompt({
    			props: {
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[1],
    				chatConfiguration: /*chatConfiguration*/ ctx[2],
    				relays: /*relays*/ ctx[3]
    			}
    		});

    	return {
    		c() {
    			create_component(keyprompt.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(keyprompt, target, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const keyprompt_changes = {};
    			if (dirty & /*websiteOwnerPubkey*/ 2) keyprompt_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[1];
    			if (dirty & /*chatConfiguration*/ 4) keyprompt_changes.chatConfiguration = /*chatConfiguration*/ ctx[2];
    			if (dirty & /*relays*/ 8) keyprompt_changes.relays = /*relays*/ ctx[3];
    			keyprompt.$set(keyprompt_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(keyprompt.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(keyprompt.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(keyprompt, detaching);
    		}
    	};
    }

    function create_fragment$1(ctx) {
    	let current_block_type_index;
    	let if_block;
    	let if_block_anchor;
    	let current;
    	const if_block_creators = [create_if_block$1, create_else_block$1];
    	const if_blocks = [];

    	function select_block_type(ctx, dirty) {
    		if (!/*chatStarted*/ ctx[0]) return 0;
    		return 1;
    	}

    	current_block_type_index = select_block_type(ctx);
    	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

    	return {
    		c() {
    			if_block.c();
    			if_block_anchor = empty();
    		},
    		m(target, anchor) {
    			if_blocks[current_block_type_index].m(target, anchor);
    			insert(target, if_block_anchor, anchor);
    			current = true;
    		},
    		p(ctx, [dirty]) {
    			let previous_block_index = current_block_type_index;
    			current_block_type_index = select_block_type(ctx);

    			if (current_block_type_index === previous_block_index) {
    				if_blocks[current_block_type_index].p(ctx, dirty);
    			} else {
    				group_outros();

    				transition_out(if_blocks[previous_block_index], 1, 1, () => {
    					if_blocks[previous_block_index] = null;
    				});

    				check_outros();
    				if_block = if_blocks[current_block_type_index];

    				if (!if_block) {
    					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    					if_block.c();
    				} else {
    					if_block.p(ctx, dirty);
    				}

    				transition_in(if_block, 1);
    				if_block.m(if_block_anchor.parentNode, if_block_anchor);
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block);
    			current = false;
    		},
    		d(detaching) {
    			if_blocks[current_block_type_index].d(detaching);
    			if (detaching) detach(if_block_anchor);
    		}
    	};
    }

    function instance$1($$self, $$props, $$invalidate) {
    	let $chatAdapter;
    	component_subscribe($$self, chatAdapter, $$value => $$invalidate(4, $chatAdapter = $$value));
    	let { websiteOwnerPubkey } = $$props;
    	let { chatStarted } = $$props;
    	let { chatConfiguration } = $$props;
    	let { relays } = $$props;

    	$$self.$$set = $$props => {
    		if ('websiteOwnerPubkey' in $$props) $$invalidate(1, websiteOwnerPubkey = $$props.websiteOwnerPubkey);
    		if ('chatStarted' in $$props) $$invalidate(0, chatStarted = $$props.chatStarted);
    		if ('chatConfiguration' in $$props) $$invalidate(2, chatConfiguration = $$props.chatConfiguration);
    		if ('relays' in $$props) $$invalidate(3, relays = $$props.relays);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*$chatAdapter*/ 16) {
    			$$invalidate(0, chatStarted = !!$chatAdapter);
    		}
    	};

    	return [chatStarted, websiteOwnerPubkey, chatConfiguration, relays, $chatAdapter];
    }

    class Container extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance$1, create_fragment$1, safe_not_equal, {
    			websiteOwnerPubkey: 1,
    			chatStarted: 0,
    			chatConfiguration: 2,
    			relays: 3
    		});
    	}
    }

    /* src/Widget.svelte generated by Svelte v3.55.1 */

    function create_if_block(ctx) {
    	let div;
    	let current_block_type_index;
    	let if_block;
    	let div_class_value;
    	let current;
    	const if_block_creators = [create_if_block_1, create_else_block];
    	const if_blocks = [];

    	function select_block_type(ctx, dirty) {
    		if (!/*dismissedIntro*/ ctx[6]) return 0;
    		return 1;
    	}

    	current_block_type_index = select_block_type(ctx);
    	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

    	return {
    		c() {
    			div = element("div");
    			if_block.c();
    			attr(div, "class", div_class_value = "shadow-2xl bg-white mb-5 w-96 max-w-screen-sm text-black rounded-xl p-5 " + (/*minimizeChat*/ ctx[7] ? 'hidden' : '') + "" + " svelte-t9ifgy");
    			set_style(div, "max-height", "80vh");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			if_blocks[current_block_type_index].m(div, null);
    			current = true;
    		},
    		p(ctx, dirty) {
    			let previous_block_index = current_block_type_index;
    			current_block_type_index = select_block_type(ctx);

    			if (current_block_type_index === previous_block_index) {
    				if_blocks[current_block_type_index].p(ctx, dirty);
    			} else {
    				group_outros();

    				transition_out(if_blocks[previous_block_index], 1, 1, () => {
    					if_blocks[previous_block_index] = null;
    				});

    				check_outros();
    				if_block = if_blocks[current_block_type_index];

    				if (!if_block) {
    					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    					if_block.c();
    				} else {
    					if_block.p(ctx, dirty);
    				}

    				transition_in(if_block, 1);
    				if_block.m(div, null);
    			}

    			if (!current || dirty & /*minimizeChat*/ 128 && div_class_value !== (div_class_value = "shadow-2xl bg-white mb-5 w-96 max-w-screen-sm text-black rounded-xl p-5 " + (/*minimizeChat*/ ctx[7] ? 'hidden' : '') + "" + " svelte-t9ifgy")) {
    				attr(div, "class", div_class_value);
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			if_blocks[current_block_type_index].d();
    		}
    	};
    }

    // (80:12) {:else}
    function create_else_block(ctx) {
    	let container;
    	let current;

    	container = new Container({
    			props: {
    				websiteOwnerPubkey: /*websiteOwnerPubkey*/ ctx[0],
    				chatConfiguration: {
    					chatType: /*chatType*/ ctx[1],
    					chatTags: /*chatTags*/ ctx[2],
    					chatReferenceTags: /*chatReferenceTags*/ ctx[3]
    				},
    				relays: /*relays*/ ctx[4]
    			}
    		});

    	return {
    		c() {
    			create_component(container.$$.fragment);
    		},
    		m(target, anchor) {
    			mount_component(container, target, anchor);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const container_changes = {};
    			if (dirty & /*websiteOwnerPubkey*/ 1) container_changes.websiteOwnerPubkey = /*websiteOwnerPubkey*/ ctx[0];

    			if (dirty & /*chatType, chatTags, chatReferenceTags*/ 14) container_changes.chatConfiguration = {
    				chatType: /*chatType*/ ctx[1],
    				chatTags: /*chatTags*/ ctx[2],
    				chatReferenceTags: /*chatReferenceTags*/ ctx[3]
    			};

    			if (dirty & /*relays*/ 16) container_changes.relays = /*relays*/ ctx[4];
    			container.$set(container_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(container.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(container.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			destroy_component(container, detaching);
    		}
    	};
    }

    // (34:12) {#if !dismissedIntro}
    function create_if_block_1(ctx) {
    	let h1;
    	let t1;
    	let p0;
    	let t3;
    	let p1;
    	let t5;
    	let p2;
    	let t9;
    	let p3;
    	let t11;
    	let button;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			h1 = element("h1");
    			h1.textContent = "NostriChat";
    			t1 = space();
    			p0 = element("p");
    			p0.textContent = "This is a FOSS chat app built on top of the Nostr protocol.";
    			t3 = space();
    			p1 = element("p");
    			p1.textContent = "Choose how you would like to chat:";
    			t5 = space();
    			p2 = element("p");

    			p2.innerHTML = `You can use it to ask for help
                    <span class="font-bold svelte-t9ifgy">PSBT.io</span>
                    to the creators of this site or to
                    anyone willing to help.`;

    			t9 = space();
    			p3 = element("p");
    			p3.textContent = "Keep in mind that this chat is public,\n                    anyone can read it, so don't exchange\n                    private information and use common-sense.";
    			t11 = space();
    			button = element("button");
    			button.textContent = "Continue";
    			attr(h1, "class", "font-bold text-2xl text-purple-700 svelte-t9ifgy");
    			attr(p0, "class", "text-gray-700 mb-3 svelte-t9ifgy");
    			attr(p1, "class", "text-gray-700 mb-3 svelte-t9ifgy");
    			attr(p2, "class", "text-gray-700 mb-3 svelte-t9ifgy");
    			attr(p3, "class", "text-gray-700 mb-3 svelte-t9ifgy");
    			attr(button, "class", "bg-purple-900 hover:bg-purple-700 w-full p-2 py-4 text-xl mt-3 rounded-xl text-center font-semibold tracking-wide uppercase text-white  svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, h1, anchor);
    			insert(target, t1, anchor);
    			insert(target, p0, anchor);
    			insert(target, t3, anchor);
    			insert(target, p1, anchor);
    			insert(target, t5, anchor);
    			insert(target, p2, anchor);
    			insert(target, t9, anchor);
    			insert(target, p3, anchor);
    			insert(target, t11, anchor);
    			insert(target, button, anchor);

    			if (!mounted) {
    				dispose = listen(button, "click", /*dismissIntro*/ ctx[9]);
    				mounted = true;
    			}
    		},
    		p: noop,
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(h1);
    			if (detaching) detach(t1);
    			if (detaching) detach(p0);
    			if (detaching) detach(t3);
    			if (detaching) detach(p1);
    			if (detaching) detach(t5);
    			if (detaching) detach(p2);
    			if (detaching) detach(t9);
    			if (detaching) detach(p3);
    			if (detaching) detach(t11);
    			if (detaching) detach(button);
    			mounted = false;
    			dispose();
    		}
    	};
    }

    function create_fragment(ctx) {
    	let div1;
    	let t0;
    	let div0;
    	let a;
    	let current;
    	let mounted;
    	let dispose;
    	let if_block = /*showChat*/ ctx[5] && create_if_block(ctx);

    	return {
    		c() {
    			div1 = element("div");
    			if (if_block) if_block.c();
    			t0 = space();
    			div0 = element("div");
    			a = element("a");

    			a.innerHTML = `<span class="tracking-wider flex svelte-t9ifgy"><span class="text-white  svelte-t9ifgy">Nostri</span><span class="text-purple-300 svelte-t9ifgy">Chat</span></span> 
            <svg fill="#ffffff" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="25px" height="25px" viewBox="0 0 571.004 571.004" xml:space="preserve" class="svelte-t9ifgy"><g class="svelte-t9ifgy"><g class="svelte-t9ifgy"><path d="M533.187,269.019c-1.432-1.746-2.219-3.876-1.252-5.993c1.868-4.08,0.611-7.658-0.931-11.465
                            c-0.877-2.167-0.796-4.716-1.15-7.095c-0.221-1.493-0.057-3.199-0.742-4.435c-1.775-3.199-3.812-6.275-5.949-9.245
                            c-2.681-3.717-5.564-7.291-8.38-10.914c-3.325-4.284-6.581-8.633-10.09-12.766c-0.706-0.833-2.604-1.42-3.607-1.085
                            c-2.411,0.808-4.732,2.052-6.874,3.452c-2.771,1.812-5.435,3.317-8.928,3.713c-3.953,0.453-8.062,1.403-11.604,3.154
                            c-5.189,2.562-9.747,6.401-14.924,9c-4.913,2.464-8.328,6.112-11.184,10.567c-0.783,1.22-1.705,2.371-2.685,3.444
                            c-3.252,3.574-5.549,7.629-7.051,12.248c-1.154,3.554-2.378,7.226-4.373,10.322c-1.963,3.044-3.256,6.194-4.162,9.601
                            c-0.285,1.065-0.44,2.167-0.656,3.251c-2.212-0.539-4.19-0.873-6.06-1.518c-1.709-0.592-3.684-1.15-4.879-2.375
                            c-2.979-3.052-6.528-5.059-10.388-6.577c-3.448-1.354-6.581-3.06-9.441-5.496c-1.514-1.29-3.771-1.738-5.721-2.489
                            c-1.419-0.547-3.043-0.714-4.3-1.501c-3.439-2.146-6.639-4.68-10.11-6.765c-2.256-1.359-4.737-2.542-7.271-3.166
                            c-1.722-0.424-2.293-0.865-2.216-2.599c0.241-5.227-0.832-10.175-3.235-14.872c-2.855-5.582-8.723-8.625-14.777-7.589
                            c-2.697,0.461-5.573,1.347-8.128,0.833c-3.329-0.669-6.516-2-10.028-1.861c-0.612,0.025-1.31-0.437-1.864-0.82
                            c-4.076-2.832-8.152-5.663-12.163-8.584c-1.489-1.085-2.782-1.154-4.442-0.322c-1.221,0.612-2.705,0.955-4.08,0.967
                            c-6.047,0.062-12.098-0.082-18.148-0.077c-5.173,0.004-10.498,1.815-15.377-1.399c-0.241-0.159-0.588-0.216-0.886-0.221
                            c-3.023-0.028-4.488-1.632-5.096-4.524c-0.171-0.82-1.436-1.971-2.236-2c-3.986-0.143-7.984-0.041-11.971,0.139
                            c-2.187,0.102-4.619,0.004-6.483,0.922c-3.941,1.942-7.556,4.533-11.355,6.773c-1.505,0.889-3.023,1.085-3.872-0.763
                            c0.979-1.261,2.337-2.272,2.627-3.525c0.771-3.37-3.705-7.181-6.969-6.059c-1.498,0.514-3.003,1.208-4.272,2.138
                            c-2.464,1.807-4.725,3.896-7.144,5.769c-3.011,2.33-6.055,4.655-10.449,4.737c0.983-3.753-1.718-5.104-4.108-6.597
                            c-1.094-0.686-2.293-1.281-3.525-1.652c-3.276-1-6.348-0.763-8.956,1.828c-2.158,2.142-3.488,2.179-6.014,0.367
                            c-3.081-2.208-3.986-2.175-7.128,0c-1.122,0.775-2.346,1.832-3.586,1.926c-4.268,0.318-6.646,3.052-8.931,6.132
                            c-1.632,2.203-3.244,4.472-5.173,6.405c-4.378,4.39-8.911,8.629-13.48,12.815c-0.608,0.559-1.95,0.873-2.709,0.608
                            c-3.378-1.191-5.582-3.823-6.899-7.001c-2.521-6.075-4.957-12.203-7.07-18.429c-0.816-2.399-1.11-5.165-0.865-7.687
                            c0.559-5.786,1.771-11.51,2.411-17.291c1.196-10.796,3.583-21.343,7.405-31.445c6.773-17.891,13.934-35.643,21.2-53.342
                            c4.619-11.249,7.817-22.852,10.167-34.75c1.644-8.319,2.477-16.63,1.901-25.137c-0.286-4.227,0.232-8.56,0.808-12.787
                            c1.669-12.232-2.46-19.547-13.843-24.068c-1.403-0.559-2.766-1.228-4.149-1.844c-2.15,0-4.3,0-6.455,0
                            c-2.909,0.91-5.871,1.681-8.715,2.762c-3.827,1.457-7.989,2.484-10.51,6.145c-1.701,2.472-4.088,3.5-6.916,4.06
                            c-3.9,0.771-7.797,1.62-11.62,2.705c-3.378,0.959-6.369,2.709-9.135,5.872c6.863,1.652,13.211,3.305,19.617,4.692
                            c7.629,1.652,14.558,4.729,20.518,9.763c2.954,2.493,5.667,5.447,6.165,9.425c0.51,4.084,0.608,8.271,0.392,12.383
                            c-0.563,10.694-4.137,20.661-7.976,30.515c-2.358,6.059-5.406,11.876-7.36,18.054c-4.321,13.656-8.486,27.348-14.19,40.522
                            c-3.309,7.646-6.83,15.251-8.307,23.534c-1.722,9.657-3.264,19.343-4.917,29.013c-0.845,4.958-0.877,10.049-2.864,14.819
                            c-0.873,2.093-1.269,4.406-1.693,6.654c-0.975,5.182-1.832,10.379-2.733,15.573c0,7.838,0,15.675,0,23.513
                            c0.632,3.905,1.363,7.801,1.877,11.722c1.481,11.232,4.773,21.955,8.825,32.489c0.816,2.121,1.322,4.378,1.783,6.613
                            c0.718,3.473,1.069,7.365,4.309,9.303c2.427,1.452,2.982,3.402,3.603,5.671c1.828,6.684,1.318,13.428,0.147,20.086
                            c-1.114,6.341-0.845,12.525,0.861,18.65c2.313,8.318,4.72,16.613,7.291,24.859c0.461,1.48,1.71,2.896,2.946,3.916
                            c5.3,4.382,10.735,8.605,16.108,12.897c0.355,0.281,0.645,0.656,0.914,1.028c2.652,3.672,6.373,5.879,10.677,6.638
                            c8.262,1.457,16.275,4.117,24.664,4.929c1.363,0.131,2.742,0.453,4.035,0.906c2.362,0.828,4.696,1.733,7.038,2.623
                            c1.257,0.824,2.391,1.832,3.415,3.064c-0.698,2.239-1.901,4.234-3.199,6.164c-3.529,5.239-8.344,8.948-14.007,11.633
                            c-5.818,2.754-11.975,4.442-18.242,5.744c-8.115,1.686-16.259,3.231-24.378,4.88c-6.789,1.379-13.248,3.79-19.633,6.414
                            c-8.25,3.39-16.463,6.879-24.77,10.13c-6.447,2.525-13.158,4.149-20.086,4.68c-2.077,0.159-4.178,0.017-6.267,0.065
                            c-0.604,0.017-1.326,0.045-1.783,0.367c-3.46,2.437-7.446,3.407-11.481,4.272c-1.607,0.347-3.203,0.742-4.802,1.117
                            c-4.423,1.049-7.703,3.672-10.237,7.36c-2.481,3.619-3.827,7.691-4.762,11.914c-1.26,5.708-1.685,11.521-1.921,17.344
                            c-0.306,7.405-0.526,14.814-0.828,22.22c-0.082,2.023-0.367,4.035-0.486,6.059c-0.033,0.592,0.012,1.302,0.314,1.779
                            c3.525,5.654,7.299,11.126,12.276,15.643c4.251,3.859,8.993,6.769,14.819,7.557c0.171,0.024,0.326,0.175,0.485,0.265
                            c1.775,0,3.55,0,5.32,0c1.032-0.253,2.085-0.444,3.097-0.767c2.216-0.702,4.415-1.461,6.663-2.212
                            c-0.196-1.881-0.971-3.166-2.317-3.962c-1.236-0.734-2.595-1.301-3.958-1.771c-1.73-0.596-3.55-0.942-5.275-1.554
                            c-1.114-0.396-2.208-0.968-3.174-1.648c-1.367-0.968-1.979-2.424-2.052-4.097c0.069-0.102,0.118-0.257,0.212-0.298
                            c4.643-1.885,7.16-5.879,9.694-9.837c0.298-0.461,0.294-1.195,0.241-1.787c-0.445-4.696-1.775-9.184-3.354-13.599
                            c-1.75-4.884-3.595-9.73-5.333-14.614c-0.551-1.547-0.836-3.183-1.326-4.749c-0.318-1.017,0.11-1.543,0.938-1.971
                            c1.64-0.841,3.423-0.832,5.189-0.886c2.464-0.073,4.945,0.041,7.393-0.188c1.408-0.131,2.925-0.515,4.121-1.236
                            c13.692-8.303,28.474-14.003,43.791-18.413c13.876-3.998,27.997-6.915,42.244-9.229c6.247-1.012,12.501-1.967,18.76-2.897
                            c0.918-0.134,1.665-0.428,2.371-1.027c4.227-3.595,9.217-5.586,14.635-6.259c5.773-0.715,11.608-0.951,17.393-1.563
                            c3.578-0.379,7.161-0.905,10.678-1.656c4.308-0.918,8.045-3.129,11.146-6.205c2.688-2.669,5.132-5.59,7.593-8.482
                            c3.28-3.855,6.414-7.834,9.727-11.661c1.02-1.179,2.432-2.012,3.631-3.039c0.792-0.674,1.501-0.653,2.391-0.11
                            c4.125,2.529,8.576,4.32,13.199,5.712c5.716,1.722,11.566,2.75,17.495,3.374c10.983,1.159,22,1.204,33.023,0.906
                            c3.166-0.086,6.333-0.09,9.503-0.184c0.93-0.029,1.718,0.171,2.473,0.729c3.309,2.444,6.646,4.852,9.963,7.291
                            c3.117,2.293,6.345,4.402,9.927,5.92c0.641,0.273,1.277,0.612,1.95,0.735c2.758,0.497,4.741,2.235,6.744,4.002
                            c5.908,5.214,11.343,10.894,16.161,17.111c6.324,8.156,12.468,16.455,18.617,24.745c6.152,8.295,12.342,16.557,19.396,24.125
                            c6.863,7.36,14.423,13.868,23.122,18.984c0.775,0.457,1.432,0.955,1.844,1.815c3.187,6.655,8.475,11.09,15.076,14.093
                            c6.81,3.097,14.006,4.256,21.444,4.142c10.33-0.159,20.062-2.53,28.906-8.014c5.264-3.264,9.572-7.471,12.347-13.097
                            c1.15-2.338,2.109-4.737,2.269-7.385c0.016-0.29,0.212-0.571,0.326-0.853c0-0.633,0-1.27,0-1.901
                            c-3.488-0.6-6.802,0.208-10.045,1.362c-3.101,1.102-6.124,2.416-9.25,3.443c-2.692,0.886-5.442,1.673-8.225,2.195
                            c-4.554,0.853-8.042-1.113-10.037-5.41c0.804-1.049,1.995-1.195,3.194-1.253c2.338-0.113,4.685-0.143,7.022-0.302
                            c0.799-0.053,1.664-0.249,2.338-0.648c0.6-0.359,1.121-1.024,1.411-1.673c0.498-1.126,0.311-1.44-0.869-2.085
                            c-3.402-1.856-6.993-3.264-10.714-4.324c-8.421-2.399-17.055-3.028-25.757-3.061c-1.836-0.008-3.677-0.004-5.513,0.082
                            c-0.963,0.045-1.66-0.249-2.366-0.906c-4.843-4.5-9.094-9.53-13.166-14.721c-6.613-8.429-12.48-17.389-18.47-26.259
                            c-2.836-4.198-5.786-8.319-8.769-12.411c-0.999-1.375-2.244-2.574-3.419-3.811c-0.384-0.404-0.885-0.727-1.383-0.991
                            c-1.358-0.727-2.269-0.408-2.905,1.003c-0.229,0.511-0.379,1.062-0.648,1.828c-0.633-0.465-1.179-0.841-1.697-1.253
                            c-5.03-4.019-8.866-9.058-11.905-14.655c-2.954-5.446-5.627-11.048-8.344-16.626c-2.607-5.353-5.092-10.767-8.438-15.712
                            c-1.521-2.248-3.317-4.312-4.9-6.523c-0.783-1.094-1.709-1.229-2.949-1.094c-5.324,0.579-10.625,0.494-15.843-0.894
                            c-2.591-0.689-5.035-1.718-7.1-3.488c-1.473-1.269-2.562-2.746-3.211-4.513c1.95-0.433,3.893-0.897,5.818-1.424
                            c6.459-1.767,12.926-2.469,19.552-2.081c7.964,0.466,15.92,1.159,23.892,1.437c2.853,0.098,5.966-0.172,8.557-1.244
                            c3.859-1.596,7.544-3.799,10.971-6.206c5.075-3.566,9.702-7.78,14.847-11.232c2.379-1.595,3.203-3.292,3.306-5.92
                            c0.134-3.509,1.9-4.781,5.3-4.149c0.6,0.114,1.203,0.253,1.787,0.44c3.852,1.229,7.633,1.028,11.489-0.163
                            c2.962-0.914,6.066-1.354,9.053-2.195c0.547-0.154,1.024-1.199,1.163-1.909c0.094-0.481-0.616-1.068-0.693-1.648
                            c-0.127-0.922-0.384-2.402,0.057-2.705c0.854-0.575,2.154-0.656,3.265-0.636c0.881,0.016,1.733,0.62,2.627,0.729
                            c2.064,0.258,3.995,0.021,5.247-1.986c1.232-1.971,1.277-3.864-0.163-5.757c-0.465-0.608-1.069-1.249-1.191-1.946
                            c-0.163-0.938-0.273-2.199,0.212-2.881c1.779-2.488,3.771-4.83,5.77-7.152c1.828-2.121,4.251-3.354,6.997-3.541
                            c0.967-0.065,2.158,0.742,2.966,1.465c0.633,0.562,0.686,1.729,1.261,2.407c0.674,0.795,1.628,1.347,2.465,2.007
                            c0.571-0.877,1.358-1.688,1.656-2.651c0.311-0.992-0.028-2.175,0.236-3.187c0.213-0.812,0.743-1.738,1.416-2.195
                            c3.591-2.439,7.442-4.524,10.861-7.177c2.574-1.991,4.508-4.786,6.944-6.98c4.182-3.771,9.526-5.097,14.789-6.472
                            c3.452-0.901,4.194-1.921,3.134-5.365c-0.514-1.673-1.228-3.309-2.052-4.854c-1.062-1.987-0.531-3.362,1.297-4.402
                            c0.727-0.412,1.498-0.751,2.252-1.114c2.387-1.139,4.08-2.701,4.688-5.521c0.612-2.827,1.75-5.549,2.741-8.286
                            c1.339-3.692,2.432-7.65,7.34-8.144c0.147-0.017,0.294-0.061,0.441-0.094c0-1.077,0-2.15,0-3.228
                            c-1.135-1.775-2.15-3.639-3.432-5.3C536.084,271.981,534.492,270.614,533.187,269.019z" class="svelte-t9ifgy"></path></g></g></svg>`;

    			attr(a, "href", "#");
    			attr(a, "class", "text-white bg-purple-900 hover:bg-purple-700 w-full p-5 rounded-full flex-shrink-1 text-center font-semibold flex flex-row items-center gap-4 svelte-t9ifgy");
    			attr(div0, "class", "self-end svelte-t9ifgy");
    			attr(div1, "class", "fixed bottom-5 right-5 mb-5 flex flex-col item-end font-sans svelte-t9ifgy");
    		},
    		m(target, anchor) {
    			insert(target, div1, anchor);
    			if (if_block) if_block.m(div1, null);
    			append(div1, t0);
    			append(div1, div0);
    			append(div0, a);
    			current = true;

    			if (!mounted) {
    				dispose = listen(a, "click", prevent_default(/*toggleChat*/ ctx[8]));
    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (/*showChat*/ ctx[5]) {
    				if (if_block) {
    					if_block.p(ctx, dirty);

    					if (dirty & /*showChat*/ 32) {
    						transition_in(if_block, 1);
    					}
    				} else {
    					if_block = create_if_block(ctx);
    					if_block.c();
    					transition_in(if_block, 1);
    					if_block.m(div1, t0);
    				}
    			} else if (if_block) {
    				group_outros();

    				transition_out(if_block, 1, 1, () => {
    					if_block = null;
    				});

    				check_outros();
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div1);
    			if (if_block) if_block.d();
    			mounted = false;
    			dispose();
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let { websiteOwnerPubkey } = $$props;
    	let { chatType } = $$props;
    	let { chatTags } = $$props;
    	let { chatReferenceTags } = $$props;
    	let { relays } = $$props;
    	let showChat = false;
    	let dismissedIntro = true;
    	let minimizeChat = false;

    	function toggleChat() {
    		if (showChat) {
    			$$invalidate(7, minimizeChat = !minimizeChat);
    		} else {
    			$$invalidate(5, showChat = !showChat);
    		}
    	}

    	function dismissIntro() {
    		$$invalidate(6, dismissedIntro = true);
    	}

    	$$self.$$set = $$props => {
    		if ('websiteOwnerPubkey' in $$props) $$invalidate(0, websiteOwnerPubkey = $$props.websiteOwnerPubkey);
    		if ('chatType' in $$props) $$invalidate(1, chatType = $$props.chatType);
    		if ('chatTags' in $$props) $$invalidate(2, chatTags = $$props.chatTags);
    		if ('chatReferenceTags' in $$props) $$invalidate(3, chatReferenceTags = $$props.chatReferenceTags);
    		if ('relays' in $$props) $$invalidate(4, relays = $$props.relays);
    	};

    	return [
    		websiteOwnerPubkey,
    		chatType,
    		chatTags,
    		chatReferenceTags,
    		relays,
    		showChat,
    		dismissedIntro,
    		minimizeChat,
    		toggleChat,
    		dismissIntro
    	];
    }

    class Widget extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance, create_fragment, safe_not_equal, {
    			websiteOwnerPubkey: 0,
    			chatType: 1,
    			chatTags: 2,
    			chatReferenceTags: 3,
    			relays: 4
    		});
    	}
    }

    var div = document.createElement('DIV');
    var script = document.currentScript;
    const websiteOwnerPubkey = script.getAttribute('data-website-owner-pubkey');
    const chatType = script.getAttribute('data-chat-type');
    let chatTags = script.getAttribute('data-chat-tags');
    let chatReferenceTags = script.getAttribute('data-chat-reference-tags');
    let relays = script.getAttribute('data-relays');
    script.parentNode.insertBefore(div, script);

    if (!relays) {
    	relays = 'wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.info,wss://nostr-pub.wellorder.net,wss://relay.current.fyi,wss://relay.nostr.band';
    }

    relays = relays.split(',');
    chatTags = chatTags ? chatTags.split(',') : [];
    chatReferenceTags = chatReferenceTags ? chatReferenceTags.split(',') : [];

    new Widget({
    	target: div,
    	props: {
    		websiteOwnerPubkey,
    		chatType,
    		chatTags,
    		chatReferenceTags,
    		relays
    	},
    });

})();
//# sourceMappingURL=bundle.js.map
