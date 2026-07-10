/**
 * Helpers puros del proceso subagente: argv de `pi -p`, wrapper de env y
 * sanitización de opciones para la cache key. Extraídos de workflow-engine.ts
 * para achicar runSubagent sin mover el loop de spawn/schema/journal.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentOptions } from "../types.js";
import { sanitizeEnvForCache } from "./agent-env-persona.js";

/** Opciones de agente + campos internos que sanitizeAgentOpts debe excluir de la key. */
export type AgentProcessOptions = AgentOptions & {
	__workflowPhase?: unknown;
	__workflowNamespace?: string;
	prompt?: string;
	concurrency?: number;
	settle?: boolean;
};

/**
 * Nombre del bin de la distribución HOST, leído desde el package.json del host: la primera
 * clave `bin` si está presente ("pi" bajo pi vanilla, "picante" bajo pi-cante), si no
 * piConfig.name (las distros pueden renombrar el bin de forma independiente del nombre del producto).
 * Vuelve a "pi" como defecto.
 */
export function hostBinName(): string {
	try {
		const pkg = JSON.parse(readFileSync(path.join(getPackageDir(), "package.json"), "utf8")) as {
			bin?: string | Record<string, string>;
			piConfig?: { name?: string };
		};
		if (pkg.bin && typeof pkg.bin === "object") {
			const first = Object.keys(pkg.bin)[0];
			if (first) return first;
		}
		return pkg.piConfig?.name || "pi";
	} catch {
		return "pi";
	}
}

/**
 * Copia de agent options excluyendo campos que no afectan la salida del modelo, para
 * que la cache key sea estable ante cambios de name/timeout/cache. prompt también se
 * descarta: ya es el primer elemento del array de la key, y agents() esparce un spec
 * (con prompt) en options; excluirlo mantiene la key dependiente del prompt una sola vez.
 */
export function sanitizeAgentOpts(options: AgentProcessOptions): Record<string, unknown> {
	const {
		name: _name,
		timeoutMs: _timeoutMs,
		cache: _cache,
		concurrency: _concurrency,
		settle: _settle,
		agentType: _agentType,
		__workflowPhase: _workflowPhase,
		env,
		...rest
	} = options;
	delete (rest as { prompt?: string }).prompt;
	return { ...rest, ...(env ? { env: sanitizeEnvForCache(env) } : {}) };
}

export interface BuildAgentArgsInput {
	attemptPrompt: string;
	effectiveOptions: AgentOptions;
	resolvedProvider?: string;
	resolvedModel?: string;
	resolvedThinking?: string;
	/** Default de --approve cuando options.approve es undefined (p. ej. ctx.isProjectTrusted()). */
	defaultApprove: boolean;
}

/** Construye el argv de `pi -p --mode json ...` para un intento de subagente. */
export function buildAgentArgs(input: BuildAgentArgsInput): string[] {
	const { attemptPrompt, effectiveOptions, resolvedProvider, resolvedModel, resolvedThinking, defaultApprove } = input;
	const args = ["-p", "--no-session", "--mode", "json"];
	const explicitExtensions = effectiveOptions.extensions ?? [];
	if (effectiveOptions.includeExtensions !== true) args.push("--no-extensions");
	for (const extensionPath of explicitExtensions) args.push("--extension", extensionPath);
	const explicitSkills = effectiveOptions.skills ?? [];
	if (
		effectiveOptions.includeSkills === false ||
		(explicitSkills.length > 0 && effectiveOptions.includeSkills !== true)
	)
		args.push("--no-skills");
	for (const skillPath of explicitSkills) args.push("--skill", skillPath);
	if (effectiveOptions.approve ?? defaultApprove) args.push("--approve");
	else args.push("--no-approve");
	if (effectiveOptions.useContextFiles === false) args.push("--no-context-files");
	// model/provider/thinking se resuelven una vez arriba (resolvedModel) para que el run
	// registre exactamente lo que se pasa acá.
	if (resolvedProvider) args.push("--provider", resolvedProvider);
	if (resolvedModel) args.push("--model", resolvedModel);
	if (resolvedThinking) args.push("--thinking", resolvedThinking);
	if (effectiveOptions.tools?.length) args.push("--tools", effectiveOptions.tools.join(","));
	if (effectiveOptions.excludeTools?.length) args.push("--exclude-tools", effectiveOptions.excludeTools.join(","));
	if (effectiveOptions.systemPrompt) args.push("--system-prompt", effectiveOptions.systemPrompt);
	if (effectiveOptions.appendSystemPrompt) args.push("--append-system-prompt", effectiveOptions.appendSystemPrompt);
	args.push(attemptPrompt);
	return args;
}

/**
 * Resuelve comando + args del proceso hijo. Con envWrapper, el wrapper es el comando
 * y el bin de pi pasa como primer arg.
 */
export function buildAgentProcess(
	input: BuildAgentArgsInput & {
		piCommand: string;
		envWrapper?: { path: string; dir: string };
	},
): { command: string; args: string[] } {
	const agentArgs = buildAgentArgs(input);
	if (!input.envWrapper) return { command: input.piCommand, args: agentArgs };
	return { command: input.envWrapper.path, args: [input.piCommand, ...agentArgs] };
}
