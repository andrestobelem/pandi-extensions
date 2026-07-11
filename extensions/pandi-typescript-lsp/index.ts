/**
 * pandi-typescript-lsp: feedback de diagnósticos de TypeScript en el borde coherente.
 *
 * Superficies: agent_end (advisory/autofix), tool `typescript_diagnostics`, comando `/tsc`.
 * Arquitectura modularizada al estilo pandi-auto-compact:
 * - runner.ts — spawn de tsc + checkProject
 * - runtime.ts — estado de sesión
 * - hook-handlers.ts — tool_result / agent_start / agent_end
 * - tool-handler.ts / command-handler.ts — superficies invocables
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTscCommand } from "./command-handler.js";
import { onAgentEnd, onAgentStart, onToolResult } from "./hook-handlers.js";
import { createTypescriptLspRuntime } from "./runtime.js";
import { registerTypescriptDiagnosticsTool } from "./tool-handler.js";

// Reexportado para la suite de integración (helpers puros + runTsc).
export {
	buildTscArgs,
	diagnosticsKey,
	filterToTouched,
	findNearestTsconfig,
	formatDiagnostics,
	isTsFile,
	parseTscDiagnostics,
	resolveTscCommand,
	shouldRun,
} from "./diagnostics.js";
export { runTsc } from "./runner.js";
export { parseMax, parseMode, parseOnOff, parseScope } from "./settings.js";

export default function typescriptLspExtension(pi: ExtensionAPI): void {
	const runtime = createTypescriptLspRuntime(pi);

	pi.on("tool_result", (event, ctx) => onToolResult(runtime, event, ctx));
	pi.on("agent_start", () => onAgentStart(runtime));
	pi.on("agent_end", async (event, ctx) => onAgentEnd(runtime, event, ctx));

	registerTypescriptDiagnosticsTool(pi, runtime);
	registerTscCommand(pi, runtime);
}
