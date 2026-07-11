/**
 * Slash command `/tsc`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDiagnostics } from "./diagnostics.js";
import { TIMEOUT_MESSAGE } from "./runner.js";
import type { TypescriptLspRuntime } from "./runtime.js";
import { parseMax, parseOnOff, parseScope } from "./settings.js";

const SUBCOMMANDS = ["status", "on", "off", "run", "scope", "autofix", "max"] as const;

export function registerTscCommand(pi: ExtensionAPI, runtime: TypescriptLspRuntime): void {
	pi.registerCommand("tsc", {
		description:
			"Diagnósticos de TypeScript: status | on | off | run | scope <touched|project> | autofix <on|off> | max <n>",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/);
			if (tokens.length > 1) return null;
			const needle = (tokens[0] ?? "").toLowerCase();
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
			return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
		},
		handler: async (args, ctx) => handleTscCommand(runtime, args, ctx),
	});
}

async function handleTscCommand(runtime: TypescriptLspRuntime, args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const head = (tokens[0] ?? "status").toLowerCase();

	if (head === "status") {
		runtime.notify(
			ctx,
			`Diagnósticos de TypeScript: ${runtime.enabled ? "on" : "off"}; mode: ${runtime.mode}; scope: ${runtime.scope}; autofix: ${runtime.autofix ? "on" : "off"}; max: ${runtime.maxErrors}`,
			"info",
		);
		return;
	}

	if (head === "on") {
		runtime.enabled = true;
		runtime.lastKey = undefined;
		runtime.notify(ctx, "Diagnósticos de TypeScript habilitados.", "info");
		return;
	}

	if (head === "off") {
		runtime.enabled = false;
		runtime.touched.clear();
		runtime.notify(ctx, "Diagnósticos de TypeScript deshabilitados.", "warning");
		return;
	}

	if (head === "scope") {
		const next = parseScope(tokens[1]);
		if (!next) {
			runtime.notify(ctx, "Uso: /tsc scope <touched|project>", "warning");
			return;
		}
		runtime.scope = next;
		runtime.notify(ctx, `Diagnósticos de TypeScript, scope: ${runtime.scope}`, "info");
		return;
	}

	if (head === "autofix") {
		const next = parseOnOff(tokens[1]);
		if (next === undefined) {
			runtime.notify(ctx, "Uso: /tsc autofix <on|off>", "warning");
			return;
		}
		runtime.autofix = next;
		runtime.mode = runtime.autofix ? "autofix" : "advisory";
		runtime.notify(ctx, `Diagnósticos de TypeScript, autofix: ${runtime.autofix ? "on" : "off"}`, "info");
		return;
	}

	if (head === "max") {
		const next = parseMax(tokens[1]);
		if (next === undefined) {
			runtime.notify(ctx, "Uso: /tsc max <positive integer>", "warning");
			return;
		}
		runtime.maxErrors = next;
		runtime.notify(ctx, `Diagnósticos de TypeScript, max errors: ${runtime.maxErrors}`, "info");
		return;
	}

	if (head === "run") {
		const outcome =
			runtime.scope === "project"
				? await runtime.runProjectCheck(ctx)
				: await runtime.runTouchedCheck(ctx, [...runtime.touched]);
		if (outcome.status === "no-engine") {
			runtime.notify(
				ctx,
				runtime.scope === "touched" && runtime.touched.size === 0
					? "No se tocó ningún archivo TypeScript en este turno."
					: "No se encontró tsconfig.json ni tsc — no se pueden ejecutar los diagnósticos de TypeScript.",
				"warning",
			);
			return;
		}
		if (outcome.status === "timeout") {
			runtime.notify(ctx, TIMEOUT_MESSAGE, "warning");
			return;
		}
		const formatted = formatDiagnostics(outcome.diags, { maxErrors: runtime.maxErrors });
		runtime.notify(
			ctx,
			formatted.hasErrors
				? `Diagnósticos de TypeScript (${outcome.diags.length}):\n${formatted.text}`
				: "No hay diagnósticos de TypeScript — limpio.",
			formatted.hasErrors ? "warning" : "info",
		);
		return;
	}

	runtime.notify(ctx, "Uso: /tsc [status|on|off|run|scope <touched|project>|autofix <on|off>|max <n>]", "warning");
}
