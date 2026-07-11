import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startPandiSessionHeartbeat, stopPandiSessionHeartbeat } from "./session-registry.js";

export function registerSessionHooks(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => startPandiSessionHeartbeat(event, ctx));
	pi.on("session_shutdown", () => stopPandiSessionHeartbeat());
}
