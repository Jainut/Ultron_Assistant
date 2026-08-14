import { HudServer } from "./hud-server.ts";

const hud = new HudServer();

await hud.start();
hud.update({
    state: "listening",
    message: "Interface neural operacional",
    transcript: "Aguardando comando de voz...",
    response: "Todos os sistemas estão online.",
});

console.log(`HUD disponível em ${hud.url()}`);

const shutdown = (): void => {
    hud.stop();
    process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
