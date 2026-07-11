/**
 * Herramienta `typescript_diagnostics` (pull / a demanda).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDiagnostics } from "./diagnostics.js";
import { TIMEOUT_MESSAGE, toolResult } from "./runner.js";
import type { TypescriptLspRuntime } from "./runtime.js";
import { parseScope } from "./settings.js";

export function registerTypescriptDiagnosticsTool(pi: ExtensionAPI, runtime: TypescriptLspRuntime): void {
	pi.registerTool({
		name: "typescript_diagnostics",
		label: "Diagnósticos de TypeScript",
		description:
			"Ejecutá diagnósticos de TypeScript (tsc --noEmit) a pedido y devolvé los errores. scope='touched' (default) chequea solo los archivos escritos/editados en este turno; scope='project' tipa-chequea el proyecto completo (<cwd>/tsconfig.json). Esto es solo feedback de diagnósticos — no un language server completo (sin hover/go-to-definition). tsc se invoca con un array argv, nunca con un shell.",
		promptSnippet: "Tipa-chequeá los archivos tocados o el proyecto con typescript_diagnostics.",
		promptGuidelines: [
			"Usá typescript_diagnostics para verificar que tus ediciones de TypeScript compilan (tsc --noEmit) en vez de escribir a mano comandos bash `tsc` o `npx tsc`.",
			"Preferí scope='touched' para chequear solo los archivos que cambiaste; usá scope='project' para un chequeo de tipos completo antes de dar por terminada la tarea.",
			"typescript_diagnostics solo reporta diagnósticos — no puede hacer hover, go-to-definition, ni completions.",
		],
		parameters: Type.Object({
			scope: Type.Optional(
				StringEnum(["touched", "project"] as const, {
					description:
						"'touched' (default): solo los archivos editados en este turno. 'project': el <cwd>/tsconfig.json completo.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = parseScope(params.scope) ?? runtime.scope;
			const effectiveCtx: ExtensionContext = { ...ctx, signal: signal ?? ctx.signal };

			let outcome: Awaited<ReturnType<TypescriptLspRuntime["runTouchedCheck"]>>;
			if (requested === "project") {
				outcome = await runtime.runProjectCheck(effectiveCtx);
			} else {
				if (runtime.touched.size === 0) {
					return toolResult("No se tocó ningún archivo TypeScript en este turno.", {
						scope: "touched",
						count: 0,
						diagnostics: [],
					});
				}
				outcome = await runtime.runTouchedCheck(effectiveCtx, [...runtime.touched]);
			}

			if (outcome.status === "no-engine") {
				return toolResult(
					"No se encontró tsconfig.json ni tsc — no se pueden ejecutar los diagnósticos de TypeScript.",
					{
						isError: true,
						scope: requested,
					},
				);
			}
			if (outcome.status === "timeout") {
				return toolResult(TIMEOUT_MESSAGE, { isError: true, timedOut: true, scope: requested });
			}

			const diags = outcome.diags;
			const formatted = formatDiagnostics(diags, { maxErrors: runtime.maxErrors });
			const text = formatted.hasErrors
				? `Diagnósticos de TypeScript (${diags.length}):\n${formatted.text}`
				: "No hay diagnósticos de TypeScript — limpio.";
			return toolResult(text, {
				scope: requested,
				hasErrors: formatted.hasErrors,
				count: diags.length,
				diagnostics: diags,
			});
		},
	});
}
