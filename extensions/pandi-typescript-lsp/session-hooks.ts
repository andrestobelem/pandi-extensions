import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onAgentEnd, onAgentStart, onToolResult } from "./hook-handlers.js";
import type { TypescriptLspRuntime } from "./runtime.js";

export function registerTypescriptLspHooks(pi: ExtensionAPI, runtime: TypescriptLspRuntime): void {
	pi.on("tool_result", (event, ctx) => onToolResult(runtime, event, ctx));
	pi.on("agent_start", () => onAgentStart(runtime));
	pi.on("agent_end", async (event, ctx) => onAgentEnd(runtime, event, ctx));
}
