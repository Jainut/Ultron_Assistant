import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const compiledUi = new URL("../../ui/app.js", import.meta.url);
const source = readFileSync(
    existsSync(compiledUi) ? compiledUi : new URL("../ui/app.js", import.meta.url),
    "utf8",
);

type Listener = (...args: any[]) => void;

class ElementStub {
    textContent = "";
    scrollHeight = 0;
    scrollTop = 0;
    clientHeight = 0;
    tabIndex = -1;
    width = 0;
    height = 0;
    dateTime = "";
    attributes = new Map<string, string>();
    listeners = new Map<string, Listener>();
    getContext: (...args: unknown[]) => unknown = () => null;
    getBoundingClientRect() { return { width: 600, height: 600 }; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
}

function createHarness(options: { canvas?: boolean; reducedMotion?: boolean; storageFailure?: boolean } = {}) {
    const elements = new Map<string, ElementStub>();
    const getElement = (selector: string) => {
        let element = elements.get(selector);
        if (!element) {
            element = new ElementStub();
            elements.set(selector, element);
        }
        return element;
    };
    const paint: Record<string, (...args: unknown[]) => unknown> = Object.fromEntries([
        "setTransform", "fillRect", "clearRect", "beginPath", "moveTo", "lineTo",
        "stroke", "fill", "arc", "drawImage",
    ].map(name => [name, () => undefined]));
    paint.createRadialGradient = () => ({ addColorStop: () => undefined });
    const makeCanvas = () => {
        const element = new ElementStub();
        element.getContext = () => options.canvas ? paint : null;
        return element;
    };
    elements.set("#network", makeCanvas());
    const documentListeners = new Map<string, Listener>();
    const windowListeners = new Map<string, Listener>();
    const motionListeners = new Map<string, Listener>();
    const frames = new Map<number, Listener>();
    const timers = new Map<number, Listener>();
    const intervals = new Map<number, Listener>();
    const storage = new Map<string, string>();
    const streams: EventStream[] = [];
    let nextId = 1;
    const document = {
        hidden: false,
        body: { dataset: {} as Record<string, string> },
        querySelector: getElement,
        createElement: makeCanvas,
        addEventListener: (name: string, listener: Listener) => documentListeners.set(name, listener),
    };
    const motion = {
        matches: options.reducedMotion ?? false,
        addEventListener: (name: string, listener: Listener) => motionListeners.set(name, listener),
    };
    class EventStream {
        closed = false;
        onopen?: Listener;
        onmessage?: Listener;
        onerror?: Listener;
        constructor(public readonly url: string) { streams.push(this); }
        close() { this.closed = true; }
    }
    const window = {
        devicePixelRatio: 2,
        matchMedia: () => motion,
        localStorage: {
            getItem: (key: string) => {
                if (options.storageFailure) throw new Error("Storage unavailable");
                return storage.get(key) ?? null;
            },
            setItem: (key: string, value: string) => {
                if (options.storageFailure) throw new Error("Storage unavailable");
                storage.set(key, value);
            },
        },
        requestAnimationFrame: (callback: Listener) => { const id = nextId++; frames.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: Listener) => { const id = nextId++; timers.set(id, callback); return id; },
        clearTimeout: (id: number) => timers.delete(id),
        setInterval: (callback: Listener) => { const id = nextId++; intervals.set(id, callback); return id; },
        clearInterval: (id: number) => intervals.delete(id),
        addEventListener: (name: string, listener: Listener) => windowListeners.set(name, listener),
    };
    const context = createContext({ document, window, EventSource: EventStream, performance });
    runInContext(source, context);
    return {
        context, document, elements, streams, frames, timers, intervals, storage, motion,
        element: getElement,
        evaluate: <T = unknown>(expression: string): T => runInContext(expression, context),
        snapshot: (value: unknown) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(value) }),
        frame: (time = 100) => {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback(time);
        },
        timeout: () => {
            const callbacks = [...timers.values()];
            timers.clear();
            for (const callback of callbacks) callback();
        },
        visibility: (hidden: boolean) => {
            document.hidden = hidden;
            documentListeners.get("visibilitychange")?.();
        },
        page: (event: string) => windowListeners.get(event)?.(),
    };
}

test("HUD neural graph is deterministic, bounded and has unique undirected links", () => {
    const hud = createHarness();
    type Graph = { nodes: { x: number; y: number; z: number }[]; edges: { a: number; b: number }[] };
    const graph = hud.evaluate<Graph>("createNeuralNetwork(420, 5)");
    assert.equal(graph.nodes.length, 420);
    assert.ok(graph.edges.length >= 1050);
    assert.ok(graph.edges.length <= 2100);
    const links = new Set<string>();
    const degrees = new Array<number>(420).fill(0);
    for (const edge of graph.edges) {
        assert.ok(edge.a < edge.b && edge.a >= 0 && edge.b < 420);
        links.add(`${edge.a}:${edge.b}`);
        degrees[edge.a] += 1;
        degrees[edge.b] += 1;
    }
    assert.equal(links.size, graph.edges.length);
    assert.ok(degrees.every(degree => degree >= 5));
    assert.ok(graph.nodes.every(node => [node.x, node.y, node.z].every(Number.isFinite)));
    assert.equal(JSON.stringify(graph), hud.evaluate("JSON.stringify(createNeuralNetwork(420, 5))"));
});

test("HUD formats only finite nonnegative measured timings, including zero", () => {
    const hud = createHarness();
    assert.equal(hud.evaluate("formatTiming(0)"), "0 ms");
    assert.equal(hud.evaluate("formatTiming(12.4)"), "12 ms");
    assert.equal(hud.evaluate("formatTiming(1250)"), "1,25 s");
    for (const invalid of ["NaN", "Infinity", "-1", "undefined", "null", "'100'"]) {
        assert.equal(hud.evaluate(`formatTiming(${invalid})`), "—");
    }
});

test("HUD telemetry updates preserve conversation and state, and empty strings clear text", () => {
    const hud = createHarness();
    hud.evaluate(`applySnapshot({ state: "speaking", message: "Respondendo", transcript: "Oi", response: "Olá" })`);
    hud.evaluate(`applySnapshot({ timings: { speech_end_to_action_start: 250, intent_duration: 0 } })`);
    assert.equal(hud.document.body.dataset.state, "speaking");
    assert.equal(hud.element("#state").textContent, "FALANDO");
    assert.equal(hud.element("#response").textContent, "Olá");
    assert.equal(hud.element("#message").textContent, "Respondendo");
    assert.equal(hud.element("#action-latency").textContent, "250 ms");
    assert.equal(hud.element("#metric-intent").textContent, "0 ms");
    assert.equal(hud.element("#metric-tool").textContent, "—");
    hud.evaluate(`applySnapshot({ timings: { tool_duration: 700 }, response: "", transcript: "" })`);
    assert.equal(hud.element("#action-latency").textContent, "—");
    assert.equal(hud.element("#metric-tool").textContent, "700 ms");
    assert.equal(hud.element("#response").textContent, "");
    assert.equal(hud.element("#transcript").textContent, "");
});

test("HUD rejects invalid states and renders supplied text as text, not HTML", () => {
    const hud = createHarness();
    hud.evaluate(`applySnapshot({ state: "listening" })`);
    hud.evaluate(`applySnapshot({ state: "__proto__", message: 4, response: "<img src=x onerror=alert(1)>" })`);
    assert.equal(hud.document.body.dataset.state, "listening");
    assert.equal(hud.element("#response").textContent, "<img src=x onerror=alert(1)>");
    assert.equal(hud.element("#message").textContent, "Inicializando sistemas");
    for (const value of [null, 42, [], "text"]) {
        hud.evaluate(`applySnapshot(${JSON.stringify(value)})`);
    }
    assert.equal(hud.document.body.dataset.state, "listening");
});

test("HUD coalesces streaming snapshots into one frame and tolerates malformed SSE", () => {
    const hud = createHarness();
    assert.equal(hud.streams[0].url, "/api/events");
    hud.snapshot({ state: "thinking", response: "A" });
    hud.snapshot({ response: "AB", transcript: "Comando" });
    assert.equal(hud.frames.size, 1);
    assert.equal(hud.element("#response").textContent, "");
    assert.doesNotThrow(() => hud.streams[0].onmessage?.({ data: "{broken" }));
    hud.frame();
    assert.equal(hud.element("#response").textContent, "AB");
    assert.equal(hud.element("#transcript").textContent, "Comando");
    assert.equal(hud.document.body.dataset.state, "thinking");
    assert.equal(hud.streams[0].closed, false);
});

test("HUD pauses hidden DOM work and applies only the latest state when visible", () => {
    const hud = createHarness();
    hud.visibility(true);
    hud.snapshot({ response: "A" });
    hud.snapshot({ response: "ABC" });
    assert.equal(hud.frames.size, 0);
    assert.equal(hud.intervals.size, 0);
    hud.visibility(false);
    assert.equal(hud.frames.size, 1);
    hud.frame();
    assert.equal(hud.element("#response").textContent, "ABC");
    assert.equal(hud.intervals.size, 1);
});

test("HUD reconnects once and does not accept callbacks from a closed stream", () => {
    const hud = createHarness();
    const first = hud.streams[0];
    first.onopen?.();
    assert.equal(hud.document.body.dataset.connected, "true");
    first.onerror?.();
    first.onerror?.();
    assert.equal(hud.element("#connection").textContent, "RECONECTANDO");
    assert.equal(hud.element("#state").textContent, "SEM CONEXÃO");
    assert.equal(hud.timers.size, 1);
    assert.equal(first.closed, true);
    hud.timeout();
    assert.equal(hud.streams.length, 2);
    first.onmessage?.({ data: JSON.stringify({ response: "Stale" }) });
    assert.equal(hud.frames.size, 0);
    hud.streams[1].onopen?.();
    assert.equal(hud.document.body.dataset.connected, "true");
    hud.page("pagehide");
    assert.equal(hud.streams[1].closed, true);
    assert.equal(hud.timers.size, 0);
    assert.equal(hud.intervals.size, 0);
    hud.page("pageshow");
    assert.equal(hud.streams.length, 3);
});

test("HUD performance control remains functional when localStorage is blocked", () => {
    const hud = createHarness({ storageFailure: true });
    hud.element("#performance-mode").listeners.get("click")?.();
    assert.equal(hud.element("#performance-mode").attributes.get("aria-pressed"), "true");
    assert.equal(hud.document.body.dataset.performance, "economical");
});

test("HUD keeps its loopback connection when the browser reports no internet", () => {
    const hud = createHarness();
    hud.streams[0].onopen?.();
    hud.page("offline");
    assert.equal(hud.streams[0].closed, false);
    assert.equal(hud.document.body.dataset.connected, "true");
    hud.snapshot({ response: "Continuo funcionando localmente." });
    hud.frame();
    assert.equal(hud.element("#response").textContent, "Continuo funcionando localmente.");
});

test("HUD renderer obeys node/DPR budgets and stops frames when hidden", () => {
    const hud = createHarness({ canvas: true });
    assert.equal(hud.evaluate("graph.nodes.length"), 420);
    assert.equal(hud.element("#network").width, 900);
    hud.frame();
    assert.equal(hud.frames.size, 0);
    assert.equal(hud.timers.size, 1);
    hud.element("#performance-mode").listeners.get("click")?.();
    assert.equal(hud.evaluate("graph.nodes.length"), 230);
    assert.equal(hud.element("#network").width, 600);
    assert.equal(hud.storage.get("ultron.hud.performance"), "1");
    hud.frame();
    hud.visibility(true);
    assert.equal(hud.frames.size, 0);
    assert.equal(hud.timers.size, 0);
});

test("HUD adaptive downgrade cannot start a second animation loop", () => {
    const hud = createHarness({ canvas: true });
    hud.evaluate("measuredFrames = 61; drawingAverage = 50");
    hud.frame();
    assert.equal(hud.evaluate("automaticEconomy"), true);
    assert.equal(hud.evaluate("graph.nodes.length"), 230);
    assert.equal(hud.frames.size + hud.timers.size, 1);
    hud.frame(200);
    assert.equal(hud.frames.size + hud.timers.size, 1);
});

test("HUD respects reduced motion with one static frame and still receives conversation", () => {
    const hud = createHarness({ canvas: true, reducedMotion: true });
    hud.frame();
    assert.equal(hud.frames.size, 0);
    assert.equal(hud.timers.size, 0);
    assert.match(hud.element("#render-detail").textContent, /Animação pausada/);
    hud.snapshot({ state: "speaking", response: "Tudo certo." });
    hud.frame(200);
    hud.frame(300);
    assert.equal(hud.element("#response").textContent, "Tudo certo.");
    assert.equal(hud.frames.size, 0);
    assert.equal(hud.timers.size, 0);
    assert.equal(hud.evaluate("animationTime"), 8);
});
