import path from "node:path";

import { runtimeConfig } from "../config/runtime.ts";
import { NotificationCenter } from "./notification-center.ts";

/** Construção sem I/O; o arquivo só é lido quando uma operação é executada. */
export const notificationCenter = new NotificationCenter({
    filePath: path.join(runtimeConfig.projectRoot, "data", "notifications.json"),
});
