import path from  "node:path";

const localAppData = process.env.LOCALAPPDATA;

if (!localAppData) {
    throw new Error("Não foi possível determinar o diretório LOCALAPPDATA");
}

export interface ApplicationCofig {
    command: string;
    args: string[];
}

export const applications: Record<string, ApplicationCofig> = {
    calculadora: {
        command: "calc.exe",
        args: [],
    },

    "bloco de notas": {
        command: "notepad.exe",
        args: [],
    },

    vscode: {
        command: path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
        args: [],
    },

    zen: {
        command: "C:\\Program Files\\Zen Browser\\zen.exe",
        args: [],
    },
}