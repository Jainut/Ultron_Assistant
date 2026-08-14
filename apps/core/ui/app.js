const canvas = document.querySelector("#network");
const context = canvas.getContext("2d");
const stateElement = document.querySelector("#state");
const messageElement = document.querySelector("#message");
const transcriptElement = document.querySelector("#transcript");
const responseElement = document.querySelector("#response");
const connectionElement = document.querySelector("#connection");

const nodes = [];
let width = 0;
let height = 0;

function resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(scale, 0, 0, scale, 0, 0);

    if (nodes.length > 0) return;

    const count = Math.max(24, Math.floor(width / 42));
    for (let index = 0; index < count; index += 1) {
        nodes.push({
            id: `ambient-${index}`,
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - .5) * .12,
            vy: (Math.random() - .5) * .12,
            size: Math.random() * 1.5 + .5,
        });
    }
}

function renderNetwork() {
    context.clearRect(0, 0, width, height);
    context.lineWidth = .5;

    for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;

        context.fillStyle = "rgba(73, 229, 246, .6)";
        context.fillRect(node.x, node.y, node.size, node.size);

        for (const peer of nodes) {
            const distance = Math.hypot(node.x - peer.x, node.y - peer.y);
            if (distance < 145) {
                context.strokeStyle = `rgba(59, 184, 201, ${.1 * (1 - distance / 145)})`;
                context.beginPath();
                context.moveTo(node.x, node.y);
                context.lineTo(peer.x, peer.y);
                context.stroke();
            }
        }
    }

    requestAnimationFrame(renderNetwork);
}

function applySnapshot(snapshot) {
    document.body.dataset.state = snapshot.state || "listening";
    stateElement.textContent = (snapshot.state || "online").toUpperCase();
    messageElement.textContent = (snapshot.message || "Sistema operacional").toUpperCase();
    if (snapshot.transcript) transcriptElement.textContent = snapshot.transcript;
    if (snapshot.response) responseElement.textContent = snapshot.response;
}

function connect() {
    const events = new EventSource("/api/events");
    events.onopen = () => { connectionElement.textContent = "LINK LOCAL"; };
    events.onmessage = (event) => applySnapshot(JSON.parse(event.data));
    events.onerror = () => {
        connectionElement.textContent = "RECONECTANDO";
        events.close();
        window.setTimeout(connect, 1500);
    };
}

window.addEventListener("resize", resize);
window.setInterval(() => {
    document.querySelector("#clock").textContent = new Date().toLocaleTimeString("pt-BR");
}, 250);

resize();
renderNetwork();
connect();
