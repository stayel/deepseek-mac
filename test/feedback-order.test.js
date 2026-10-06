// Ordering self-test for agent_bridge.js (no browser, no network, no sends).
//
// Loads the REAL agent_bridge.js inside a stubbed DOM and drives the REAL
// feedback queue through its _debug hook. What this proves:
//   * a result enqueued later but dispatched earlier is still delivered first
//   * the queue drains in dispatch-seq order regardless of arrival order
// What this does NOT prove: anything about DeepSeek's live DOM (send button
// discovery, streaming detection). Those need a run on the real page.
//
// Usage: node test/feedback-order.test.js [path/to/agent_bridge.js] [--verbose]

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const srcPath = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'agent_bridge.js');
const SRC = fs.readFileSync(srcPath, 'utf8');

const bridgeLog = [];
const timerCalls = { setTimeout: 0, setInterval: 0 };

function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        className: '', id: '', innerText: '', textContent: '', innerHTML: '', value: '',
        style: {}, dataset: {}, children: [], childNodes: [], parentElement: null,
        classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        hasAttribute() { return false; },
        appendChild(c) { this.children.push(c); if (c) c.parentElement = this; return c; },
        insertBefore(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        closest() { return null; }, contains() { return false; }, matches() { return false; },
        getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        focus() {}, blur() {}, click() {}, scrollIntoView() {}, cloneNode() { return makeEl(tag); },
    };
    return el;
}

const documentStub = {
    head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
    createElement: t => makeEl(t),
    createTextNode: t => ({ nodeValue: String(t) }),
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, getElementsByClassName: () => [],
    addEventListener() {}, removeEventListener() {}, execCommand: () => true,
    createTreeWalker: () => ({ nextNode: () => null }),
};

function store() {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear(),
        get length() { return m.size; },
        key: i => Array.from(m.keys())[i] || null,
    };
}

const windowStub = {
    document: documentStub,
    chrome: { webview: { postMessage(msg) { bridgeLog.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); } } },
    sessionStorage: store(),
    localStorage: store(),
    location: { hostname: 'chat.deepseek.com', href: 'https://chat.deepseek.com/', protocol: 'https:' },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflow: 'visible' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } },
    Event: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    MouseEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    HTMLTextAreaElement: { prototype: { value: { set() {} } } },
    // Timers are recorded, never run: the module's scan loop must not fire, and the
    // dry-run queue path is fully synchronous by design.
    setTimeout: () => { timerCalls.setTimeout++; return 1; },
    setInterval: () => { timerCalls.setInterval++; return 1; },
    clearTimeout() {}, clearInterval() {},
    alert() {}, confirm: () => true, prompt: () => null,
};
windowStub.window = windowStub;

const sandbox = {
    window: windowStub, document: documentStub, navigator: windowStub.navigator,
    location: windowStub.location, chrome: windowStub.chrome,
    sessionStorage: windowStub.sessionStorage, localStorage: windowStub.localStorage,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout: windowStub.setTimeout, setInterval: windowStub.setInterval,
    clearTimeout: windowStub.clearTimeout, clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame, cancelAnimationFrame: windowStub.cancelAnimationFrame,
    performance: windowStub.performance, MutationObserver: windowStub.MutationObserver,
    Event: windowStub.Event, KeyboardEvent: windowStub.KeyboardEvent, MouseEvent: windowStub.MouseEvent,
    Node: windowStub.Node, NodeFilter: windowStub.NodeFilter,
    getComputedStyle: windowStub.getComputedStyle,
    HTMLTextAreaElement: windowStub.HTMLTextAreaElement,
    Proxy, Reflect, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, Symbol, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;
sandbox.self = windowStub;

let loadError = null;
try {
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: srcPath });
} catch (e) {
    loadError = e;
}

const bridge = windowStub.__agentBridge;

function fail(msg) { console.log('  FAIL  ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('  ok    ' + msg); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log('agent_bridge.js: ' + srcPath + ' (' + SRC.length + ' chars)');
if (loadError) {
    console.log('  FAIL  module threw during load: ' + loadError.message);
    process.exitCode = 1;
}
if (!bridge) {
    console.log('  FAIL  window.__agentBridge was never assigned (init aborted)');
    process.exitCode = 1;
}
if (!bridge || !bridge._debug || typeof bridge._debug.testFeedbackOrder !== 'function') {
    console.log('  FAIL  _debug.testFeedbackOrder missing');
    process.exitCode = 1;
} else {
    const cases = [
        { name: 'arrival 5,3,1,4,2 -> deliver 1..5', seqs: [5, 3, 1, 4, 2], expect: [1, 2, 3, 4, 5] },
        { name: 'arrival 2,1 -> deliver 1,2', seqs: [2, 1], expect: [1, 2] },
        { name: 'arrival 1 -> deliver 1', seqs: [1], expect: [1] },
        { name: 'arrival 4,3,2,1 -> deliver 1..4', seqs: [4, 3, 2, 1], expect: [1, 2, 3, 4] },
        { name: 'arrival 1,2,3,4,5 (already ordered)', seqs: [1, 2, 3, 4, 5], expect: [1, 2, 3, 4, 5] },
        { name: 'default 5-item shuffle', seqs: null, expect: [1, 2, 3, 4, 5] },
        { name: 'duplicates 3,3,2,1 -> 1,2,3,3', seqs: [3, 3, 2, 1], expect: [1, 2, 3, 3] },
    ];
    for (const c of cases) {
        const r = bridge._debug.testFeedbackOrder(c.seqs);
        if (r && r.error) { fail(c.name + ' -> threw: ' + r.error); continue; }
        if (!r) { fail(c.name + ' -> no result'); continue; }
        if (!eq(r.drained, c.expect)) { fail(c.name + ' -> got ' + JSON.stringify(r.drained) + ' expected ' + JSON.stringify(c.expect)); continue; }
        pass(c.name + ' (ok=' + r.ok + ')');
    }

    // The queue must be left clean by the self-test.
    const state = bridge._debug.feedbackQueueState ? bridge._debug.feedbackQueueState() : null;
    if (state && state.pending.length === 0 && state.draining === false) pass('queue left clean after self-test');
    else fail('queue not clean after self-test: ' + JSON.stringify(state));

    // Regression guard for the defect this test exists for: the old code let a
    // random 3-7s timer decide who entered the send slot first. If a future edit
    // reintroduces a per-result random pre-send timer outside the queue, the
    // source will contain the old pattern again.
    const bad = /pendingFeedbackTimer\s*=\s*setTimeout\s*\(\s*sendFeedbackNow/.test(SRC);
    if (bad) fail('old random pre-send timer pattern is back in the source');
    else pass('no random pre-send timer outside the queue');
}

if (verbose) {
    console.log('--- bridge logs ---');
    for (const l of bridgeLog) console.log(l);
    console.log('--- timers: ' + JSON.stringify(timerCalls));
}
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS');
