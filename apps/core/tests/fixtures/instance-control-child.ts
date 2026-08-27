import { InstanceControl, instanceAddress } from "../../src/system/instance-control.ts";

// Isolated test fixture: no assistant, audio, models, devices or tools are imported.
const root = process.argv[2];
if (!root) throw new Error("Test root required");
const instance = await InstanceControl.acquire({ address: instanceAddress(root) });
if (!instance) {
    console.log(JSON.stringify({ owner: false }));
} else {
    instance.update({ phase: "ready", hudUrl: "http://127.0.0.1:19999" });
    const close = (): void => { void instance.close().then(() => process.exit(0)); };
    instance.onShutdown(close);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    process.stdin.once("data", close);
    console.log(JSON.stringify({ owner: true, pid: process.pid }));
}
