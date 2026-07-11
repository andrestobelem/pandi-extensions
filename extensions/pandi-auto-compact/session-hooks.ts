import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	onAgentEnd,
	onContext,
	onSessionBeforeCompact,
	onSessionCompact,
	onSessionStart,
	onTurnEnd,
} from "./hook-handlers.js";
import type { AutoCompactRuntime } from "./runtime.js";

export function registerAutoCompactHooks(pi: ExtensionAPI, runtime: AutoCompactRuntime): void {
	pi.on("session_start", (event, ctx) => onSessionStart(runtime, event, ctx));
	pi.on("session_before_compact", async (event, ctx) => onSessionBeforeCompact(runtime, event, ctx));
	pi.on("session_compact", (event, ctx) => onSessionCompact(runtime, event, ctx));
	pi.on("context", (event) => {
		const result = onContext(runtime, event);
		if (result) return { messages: result.messages as typeof event.messages };
	});
	pi.on("turn_end", (event, ctx) => onTurnEnd(runtime, event, ctx));
	pi.on("agent_end", (event, ctx) => onAgentEnd(runtime, event, ctx));
}
