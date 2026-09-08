import { HudServer } from "./hud-server.ts";

const hud = new HudServer();

await hud.start();
hud.update({
    state: "listening",
    message: "Prévia da interface neural",
    transcript: "Aguardando comando de voz...",
    response: "Prévia visual: nenhum microfone, modelo ou dispositivo foi iniciado.",
});

console.log(`HUD disponível em ${hud.url()}`);

const shutdown = (): void => {
    hud.stop();
    process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
