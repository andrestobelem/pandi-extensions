/**
 * Memoria local del proyecto (.pi/memory/) con tool `remember` e inyección en system prompt.
 *
 * - memory.ts / paths.ts — lógica pura y rutas
 * - remember-tool-handler.ts — execute de `remember`
 * - session-hooks.ts — inyección en before_agent_start
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectLocalMemory } from "./session-hooks.js";
import { registerRememberTool } from "./tool-handler.js";

export default function localMemoryExtension(pi: ExtensionAPI): void {
	registerRememberTool(pi);

	pi.on("before_agent_start", async (event, ctx) => injectLocalMemory(event, ctx));
}
