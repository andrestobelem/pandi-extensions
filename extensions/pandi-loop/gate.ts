/**
 * Política pura del gate destructivo de pandi-loop. loop-tools.ts decide cuándo aplicarla;
 * gate-patterns.ts y gate-shell-parse.ts clasifican comandos y rutas.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isDestructiveBash } from "./gate-patterns.js";
import { isUnsafeWritePath, unsafeBashWriteTarget } from "./gate-shell-parse.js";

export { DESTRUCTIVE_BASH_PATTERNS, isDestructiveBash } from "./gate-patterns.js";
export {
	AMP_REDIRECT_TARGET_RE,
	CD_TARGET_RE,
	commandChangesToUnsafeDir,
	GT_AMP_REDIRECT_TARGET_RE,
	isUnsafeWritePath,
	REDIRECT_TARGET_RE,
	TEE_ARGS_RE,
	unquote,
	unsafeBashWriteTarget,
} from "./gate-shell-parse.js";

export function destructiveReason(ctx: ExtensionContext, event: ToolCallEvent): string | undefined {
	if (event.toolName === "bash") {
		const rawCommand = (event.input as { command?: unknown }).command;
		if (typeof rawCommand === "string") {
			const command = rawCommand.replace(/\\\r?\n/g, " ");
			if (isDestructiveBash(command)) {
				return `autopilot bloqueó un comando de shell destructivo: ${command.slice(0, 200)}`;
			}
			const unsafeTarget = unsafeBashWriteTarget(ctx, command);
			if (unsafeTarget) {
				return `autopilot bloqueó una escritura de shell fuera del proyecto: ${unsafeTarget.slice(0, 200)}`;
			}
		}
		return undefined;
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const input = event.input as { file_path?: unknown; path?: unknown };
		const filePath = input.file_path ?? input.path;
		if (isUnsafeWritePath(ctx, filePath)) {
			return `autopilot bloqueó un ${event.toolName} fuera del proyecto: ${String(filePath).slice(0, 200)}`;
		}
		return undefined;
	}
	return undefined;
}
