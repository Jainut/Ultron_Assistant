const canvas = document.querySelector("#network");
const context = canvas.getContext("2d", { alpha: true });
const stateElement = document.querySelector("#state");
const messageElement = document.querySelector("#message");
const transcriptElement = document.querySelector("#transcript");
const responseElement = document.querySelector("#response");
const connectionElement = document.querySelector("#connection");
const performanceButton = document.querySelector("#performance-mode");
const renderDetail = document.querySelector("#render-detail");
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");

const stateLabels = {
    booting: "INICIALIZANDO",
    listening: "OUVINDO",
    thinking: "PROCESSANDO",
    speaking: "FALANDO",
    sleeping: "EM ESPERA",
    error: "ATENÇÃO",
};
const metricElements = [
    ["speech_end_to_action_start", document.querySelector("#action-latency")],
    ["transcription_duration", document.querySelector("#metric-transcription")],
    ["intent_duration", document.querySelector("#metric-intent")],
    ["tool_duration", document.querySelector("#metric-tool")],
    ["speech_end_to_first_audio", document.querySelector("#metric-voice")],
];
const qualityLevels = {
    normal: { count: 420, neighbors: 5, fps: 30, dpr: 1.5, pulses: 14 },
    economical: { count: 230, neighbors: 4, fps: 18, dpr: 1, pulses: 6 },
};

let currentState = "booting";
let currentMessage = "Inicializando sistemas";
let connectionStatus = "connecting";
let manualEconomy = readPerformancePreference();
let automaticEconomy = false;
let width = 0;
let height = 0;
let graph = null;
let projected = [];
let projectedOrbits = [];
let glow = null;
let halo = null;
let rotation = .43;
let animationTime = 8;
let lastFrameTime = 0;
let drawingAverage = 0;
let measuredFrames = 0;
let animationFrame = 0;
let animationTimer = 0;
let snapshotFrame = 0;
let pendingSnapshot = null;
let sphereVisible = true;
let pageActive = true;
let eventSource = null;
let reconnectTimer = 0;
let clockTimer = 0;

function readPerformancePreference() {
    try {
        return window.localStorage.getItem("ultron.hud.performance") === "1";
    } catch {
        return false;
    }
}

function quality() {
    return qualityLevels[manualEconomy || automaticEconomy ? "economical" : "normal"];
}

function formatTiming(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
    if (value < 1000) return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " ms";
    return (value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " s";
}

function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function updateConversation(element, text) {
    if (element.textContent === text) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    element.textContent = text;
    // Preserve a user's scroll position while streaming a longer answer.
    if (atBottom) element.scrollTop = element.scrollHeight;
    element.tabIndex = element.scrollHeight > element.clientHeight ? 0 : -1;
}

function updateTimings(timings) {
    if (!timings || typeof timings !== "object" || Array.isArray(timings)) return;
    let measured = false;
    for (const [name, element] of metricElements) {
        const value = Object.hasOwn(timings, name) ? timings[name] : undefined;
        const formatted = formatTiming(value);
        measured ||= formatted !== "—";
        setText(element, formatted);
    }
    setText(document.querySelector("#metric-note"), measured
        ? "Dados do último comando concluído."
        : "Nenhuma medição disponível nesta interação.");
}

function updateStateDisplay() {
    document.body.dataset.state = currentState;
    document.body.dataset.connected = String(connectionStatus === "connected");
    const disconnected = connectionStatus === "retrying";
    setText(stateElement, disconnected ? "SEM CONEXÃO" : stateLabels[currentState]);
    setText(messageElement, disconnected ? "Aguardando conexão com o Ultron..." : currentMessage);
    requestDraw();
}

function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    if (typeof snapshot.state === "string" && Object.hasOwn(stateLabels, snapshot.state)) {
        currentState = snapshot.state;
    }
    if (typeof snapshot.message === "string") currentMessage = snapshot.message;
    if (typeof snapshot.transcript === "string") updateConversation(transcriptElement, snapshot.transcript);
    if (typeof snapshot.response === "string") updateConversation(responseElement, snapshot.response);
    if (Object.hasOwn(snapshot, "timings")) updateTimings(snapshot.timings);
    updateStateDisplay();
}

function queueSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    // Coalesce streaming snapshots; never accumulate a history of DOM updates.
    pendingSnapshot = { ...pendingSnapshot };
    for (const field of ["state", "message", "transcript", "response", "timings"]) {
        if (Object.hasOwn(snapshot, field)) pendingSnapshot[field] = snapshot[field];
    }
    if (document.hidden || !pageActive || snapshotFrame) return;
    snapshotFrame = window.requestAnimationFrame(() => {
        snapshotFrame = 0;
        const next = pendingSnapshot;
        pendingSnapshot = null;
        if (next) applySnapshot(next);
    });
}

function setConnection(status) {
    connectionStatus = status;
    setText(connectionElement, {
        connecting: "CONECTANDO",
        connected: "CONECTADO",
        retrying: "RECONECTANDO",
    }[status]);
    updateStateDisplay();
}

function connect() {
    if (!pageActive || eventSource) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (connectionStatus === "connected") setConnection("connecting");
    const events = new EventSource("/api/events");
    eventSource = events;
    events.onopen = () => {
        if (eventSource === events) setConnection("connected");
    };
    events.onmessage = (event) => {
        if (eventSource !== events) return;
        try {
            queueSnapshot(JSON.parse(event.data));
        } catch {
            // A malformed event must not discard the last valid state or the stream.
        }
    };
    events.onerror = () => {
        if (eventSource !== events) return;
        events.close();
        eventSource = null;
        setConnection("retrying");
        reconnectTimer = window.setTimeout(connect, 1500);
    };
}

function disconnect() {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    eventSource?.close();
    eventSource = null;
}

/** A stable graph: nearest-neighbor links are computed once, never per frame. */
function createNeuralNetwork(requestedCount, requestedNeighbors = 5) {
    const count = Math.min(640, Math.max(32, Math.floor(requestedCount)));
    const neighbors = Math.min(6, Math.max(2, Math.floor(requestedNeighbors)));
    let seed = 8217;
    const random = () => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const surfaceCount = Math.floor(count * .87);
    const nodes = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < count; index += 1) {
        const inner = index >= surfaceCount;
        const localIndex = inner ? index - surfaceCount : index;
        const localCount = inner ? count - surfaceCount : surfaceCount;
        const y = 1 - 2 * (localIndex + .5) / localCount;
        const ring = Math.sqrt(1 - y * y);
        const angle = localIndex * goldenAngle + (random() - .5) * .12;
        const radius = inner ? .4 + random() * .4 : .97 + random() * .045;
        nodes.push({
            x: Math.cos(angle) * ring * radius,
            y: y * radius,
            z: Math.sin(angle) * ring * radius,
            size: .55 + random() * .85,
            beacon: index % 23 === 0,
        });
    }
    const edgeKeys = new Set();
    const edges = [];
    for (let index = 0; index < nodes.length; index += 1) {
        const closest = [];
        const node = nodes[index];
        for (let peer = 0; peer < nodes.length; peer += 1) {
            if (peer === index) continue;
            const other = nodes[peer];
            const distance = (node.x - other.x) ** 2 + (node.y - other.y) ** 2 + (node.z - other.z) ** 2;
            let insertion = closest.findIndex(candidate => candidate.distance > distance);
            if (insertion < 0) insertion = closest.length;
            if (insertion < neighbors) closest.splice(insertion, 0, { peer, distance });
            if (closest.length > neighbors) closest.pop();
        }
        for (const { peer } of closest) {
            const a = Math.min(index, peer);
            const b = Math.max(index, peer);
            const key = a * count + b;
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push({ a, b });
            }
        }
    }
    const orbits = [
        { radius: 1.15, tilt: .63, turn: -.34 },
        { radius: 1.11, tilt: 1.32, turn: .85 },
        { radius: 1.07, tilt: -.87, turn: -.75 },
    ].map((orbit, orbitIndex) => {
        const points = [];
        for (let index = 0; index <= 160; index += 1) {
            const angle = index / 160 * Math.PI * 2;
            const x = Math.cos(angle) * orbit.radius;
            const y = Math.sin(angle) * Math.cos(orbit.tilt) * orbit.radius;
            const z = Math.sin(angle) * Math.sin(orbit.tilt) * orbit.radius;
            points.push({
                x: x * Math.cos(orbit.turn) - y * Math.sin(orbit.turn),
                y: x * Math.sin(orbit.turn) + y * Math.cos(orbit.turn),
                z,
                gap: (index + orbitIndex * 7) % 39 < 3,
            });
        }
        return points;
    });
    return { nodes, edges, orbits };
}

function createGlowSprite() {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 64;
    const paint = sprite.getContext("2d");
    if (!paint) return null;
    const gradient = paint.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(218, 249, 255, .95)");
    gradient.addColorStop(.08, "rgba(136, 226, 255, .8)");
    gradient.addColorStop(.2, "rgba(38, 153, 255, .35)");
    gradient.addColorStop(1, "rgba(13, 82, 190, 0)");
    paint.fillStyle = gradient;
    paint.fillRect(0, 0, 64, 64);
    return sprite;
}

function allocateProjection(points) {
    return points.map(() => ({ x: 0, y: 0, z: 0, scale: 1, bucket: 0 }));
}

function resize() {
    if (!context) {
        setText(renderDetail, "Canvas indisponível · conversa preservada");
        return;
    }
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    const settings = quality();
    const scale = Math.min(window.devicePixelRatio || 1, settings.dpr);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (!graph || graph.nodes.length !== settings.count) {
        graph = createNeuralNetwork(settings.count, settings.neighbors);
        projected = allocateProjection(graph.nodes);
        projectedOrbits = graph.orbits.map(allocateProjection);
    }
    glow ||= createGlowSprite();
    const radius = Math.min(width, height) * .355;
    halo = context.createRadialGradient(width * .47, height * .46, radius * .2, width / 2, height / 2, radius * 1.17);
    halo.addColorStop(0, "rgba(14, 64, 123, .07)");
    halo.addColorStop(.73, "rgba(14, 71, 135, .02)");
    halo.addColorStop(.86, "rgba(22, 97, 181, .07)");
    halo.addColorStop(1, "rgba(8, 48, 96, 0)");
    requestDraw();
}

function project(points, target, radius, yaw, tilt) {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const tiltCosine = Math.cos(tilt);
    const tiltSine = Math.sin(tilt);
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const x = point.x * cosine + point.z * sine;
        const rotatedZ = -point.x * sine + point.z * cosine;
        const y = point.y * tiltCosine - rotatedZ * tiltSine;
        const z = point.y * tiltSine + rotatedZ * tiltCosine;
        const scale = 3.6 / (3.6 - z);
        const result = target[index];
        result.x = width / 2 + x * radius * scale;
        result.y = height / 2 + y * radius * scale;
        result.z = z;
        result.scale = scale;
        result.bucket = Math.max(0, Math.min(4, Math.floor((z + 1) * 2.5)));
    }
}

function drawOrbits(front) {
    context.lineWidth = front ? .85 : .55;
    context.strokeStyle = front ? "rgba(97, 197, 255, .46)" : "rgba(52, 115, 176, .18)";
    context.beginPath();
    for (let ring = 0; ring < projectedOrbits.length; ring += 1) {
        const points = projectedOrbits[ring];
        for (let index = 1; index < points.length; index += 1) {
            const a = points[index - 1];
            const b = points[index];
            if (graph.orbits[ring][index].gap || (b.z >= 0) !== front) continue;
            context.moveTo(a.x, a.y);
            context.lineTo(b.x, b.y);
        }
    }
    context.stroke();
}

function drawReticle(radius) {
    const centerX = width / 2;
    const centerY = height / 2;
    context.lineWidth = .6;
    context.strokeStyle = "rgba(65, 124, 176, .28)";
    context.beginPath();
    for (let index = 0; index < 96; index += 1) {
        if (index > 34 && index < 44 || index > 76 && index < 86) continue;
        const angle = index / 96 * Math.PI * 2;
        const outer = radius * 1.24;
        const inner = outer - (index % 4 === 0 ? 5 : 2);
        context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
        context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    }
    context.stroke();
    context.strokeStyle = "rgba(69, 166, 245, .34)";
    context.lineWidth = 1.2;
    context.beginPath();
    context.arc(centerX, centerY, radius * 1.205, -.87, -.30);
    context.stroke();
    context.beginPath();
    context.arc(centerX, centerY, radius * 1.205, Math.PI - .87, Math.PI - .30);
    context.stroke();
}

function drawEdges() {
    for (let bucket = 0; bucket < 5; bucket += 1) {
        context.lineWidth = .46 + bucket * .09;
        context.strokeStyle = "rgba(55, 151, 242, " + (.10 + bucket * .068) + ")";
        context.beginPath();
        for (const edge of graph.edges) {
            const a = projected[edge.a];
            const b = projected[edge.b];
            if (Math.floor((a.bucket + b.bucket) / 2) !== bucket) continue;
            context.moveTo(a.x, a.y);
            context.lineTo(b.x, b.y);
        }
        context.stroke();
    }
}

function drawNodes() {
    for (let bucket = 0; bucket < 5; bucket += 1) {
        context.fillStyle = "rgba(147, 222, 255, " + (.18 + bucket * .16) + ")";
        context.beginPath();
        for (let index = 0; index < projected.length; index += 1) {
            const point = projected[index];
            if (point.bucket !== bucket) continue;
            const size = graph.nodes[index].size * point.scale * (bucket === 4 ? 1.08 : .8);
            context.moveTo(point.x + size, point.y);
            context.arc(point.x, point.y, size, 0, Math.PI * 2);
        }
        context.fill();
    }
    if (!glow) return;
    for (let index = 0; index < projected.length; index += 1) {
        const point = projected[index];
        if (!graph.nodes[index].beacon || point.z < -.2) continue;
        const size = (16 + Math.sin(animationTime * 1.4 + index) * 2) * point.scale;
        context.drawImage(glow, point.x - size / 2, point.y - size / 2, size, size);
    }
}

function drawPulses() {
    if (!glow || currentState === "sleeping") return;
    const amount = quality().pulses;
    const pace = currentState === "thinking" ? .42 : .22;
    for (let index = 0; index < amount; index += 1) {
        const edge = graph.edges[(index * 79 + 17) % graph.edges.length];
        const a = projected[edge.a];
        const b = projected[edge.b];
        if (a.z < -.1 && b.z < -.1) continue;
        const progress = (animationTime * pace + index * .173) % 1;
        const x = a.x + (b.x - a.x) * progress;
        const y = a.y + (b.y - a.y) * progress;
        context.globalAlpha = Math.sin(progress * Math.PI) * .9;
        context.drawImage(glow, x - 7, y - 7, 14, 14);
    }
    context.globalAlpha = 1;
}

function renderNetwork(now) {
    if (!context || !graph || !width || !height) return;
    const started = performance.now();
    const delta = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, .1) : 0;
    lastFrameTime = now;
    if (!motionPreference.matches) {
        animationTime += delta;
        rotation += delta * (currentState === "thinking" ? .095 : currentState === "sleeping" ? .016 : .042);
    }
    const radius = Math.min(width, height) * .355;
    const tilt = .20 + Math.sin(animationTime * .13) * .06;
    project(graph.nodes, projected, radius, rotation, tilt);
    for (let index = 0; index < graph.orbits.length; index += 1) {
        project(graph.orbits[index], projectedOrbits[index], radius, rotation * .27, .12);
    }
    context.clearRect(0, 0, width, height);
    context.fillStyle = halo;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = currentState === "sleeping" ? .45 : 1;
    drawReticle(radius);
    drawOrbits(false);
    drawEdges();
    drawNodes();
    drawOrbits(true);
    drawPulses();
    context.globalAlpha = 1;

    // Downgrade only after sustained expensive draws, never from a single resize.
    const elapsed = performance.now() - started;
    drawingAverage = measuredFrames ? drawingAverage * .95 + elapsed * .05 : elapsed;
    measuredFrames += 1;
    if (measuredFrames > 60 && drawingAverage > 12 && !manualEconomy && !automaticEconomy) {
        automaticEconomy = true;
        updateRenderControl();
        resize();
    }
}

function canAnimate() {
    return context && pageActive && !document.hidden && sphereVisible;
}

function stopAnimation() {
    window.clearTimeout(animationTimer);
    window.cancelAnimationFrame(animationFrame);
    animationTimer = 0;
    animationFrame = 0;
    lastFrameTime = 0;
}

function animate(now) {
    animationFrame = 0;
    if (!canAnimate()) return;
    renderNetwork(now);
    if (motionPreference.matches || animationFrame || animationTimer) return;
    // No 60/120 Hz idle rAF loop: only schedule the next budgeted frame.
    animationTimer = window.setTimeout(() => {
        animationTimer = 0;
        animationFrame = window.requestAnimationFrame(animate);
    }, 1000 / quality().fps);
}

function requestDraw() {
    if (!canAnimate() || animationFrame || animationTimer) return;
    animationFrame = window.requestAnimationFrame(animate);
}

function updateRenderControl() {
    performanceButton.setAttribute("aria-pressed", String(manualEconomy));
    document.body.dataset.performance = manualEconomy || automaticEconomy ? "economical" : "normal";
    const detail = motionPreference.matches
        ? "Animação pausada · acessibilidade"
        : quality().fps + " FPS máx. · " + (manualEconomy ? "econômico" : automaticEconomy ? "ajuste automático" : "adaptativo");
    setText(renderDetail, detail);
}

function updateClock() {
    const date = new Date();
    const clock = document.querySelector("#clock");
    setText(clock, date.toLocaleTimeString("pt-BR"));
    clock.dateTime = date.toISOString();
    setText(document.querySelector("#date"), date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "").toUpperCase());
}

function resumeClock() {
    window.clearInterval(clockTimer);
    updateClock();
    if (!document.hidden && pageActive) clockTimer = window.setInterval(updateClock, 1000);
}

performanceButton.addEventListener("click", () => {
    manualEconomy = !manualEconomy;
    automaticEconomy = false;
    drawingAverage = 0;
    measuredFrames = 0;
    try {
        window.localStorage.setItem("ultron.hud.performance", manualEconomy ? "1" : "0");
    } catch {
        // Privacy mode may disallow storage; the control still works this session.
    }
    stopAnimation();
    updateRenderControl();
    resize();
});

motionPreference.addEventListener("change", () => {
    stopAnimation();
    updateRenderControl();
    requestDraw();
});

document.addEventListener("visibilitychange", () => {
    stopAnimation();
    if (document.hidden) {
        window.cancelAnimationFrame(snapshotFrame);
        snapshotFrame = 0;
        window.clearInterval(clockTimer);
    } else {
        if (pendingSnapshot) queueSnapshot(pendingSnapshot);
        resumeClock();
        requestDraw();
    }
});

if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
        sphereVisible = entry.isIntersecting;
        if (sphereVisible) requestDraw();
        else stopAnimation();
    }).observe(canvas);
}

if ("ResizeObserver" in window) {
    new ResizeObserver(resize).observe(canvas);
} else {
    window.addEventListener("resize", resize);
}

window.addEventListener("pagehide", () => {
    pageActive = false;
    disconnect();
    stopAnimation();
    window.cancelAnimationFrame(snapshotFrame);
    snapshotFrame = 0;
    window.clearInterval(clockTimer);
});
window.addEventListener("pageshow", () => {
    pageActive = true;
    if (pendingSnapshot) queueSnapshot(pendingSnapshot);
    resumeClock();
    requestDraw();
    connect();
});
// Loopback still works without internet; only SSE errors mark the local link down.
window.addEventListener("online", connect);

updateRenderControl();
resize();
resumeClock();
connect();
