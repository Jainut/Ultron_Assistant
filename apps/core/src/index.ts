import {routeCommand} from "./assistant/command-router.js";

const commands = [
    "Que horas são?",
    "Me diga as horas",
    "Me diga a hora",
    "Faça um café",
];

for (const command of commands) {
    const result = routeCommand(command);
    console.log(`Comando: ${command}`);
    console.log(`Resultado: ${result.message}`);
}