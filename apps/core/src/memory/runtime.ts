import path from "node:path";
import { runtimeConfig } from "../config/runtime.ts";
import { ObsidianIndex } from "./obsidian-index.ts";

// Construction has no I/O; an absent vault leaves this optional capability idle.
export const obsidianIndex = new ObsidianIndex({
    vaultPath: process.env.ULTRON_OBSIDIAN_VAULT?.trim(),
    cachePath: path.join(runtimeConfig.projectRoot, "data", "indexes", "obsidian.json"),
});
