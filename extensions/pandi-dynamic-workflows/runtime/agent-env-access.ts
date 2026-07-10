/**
 * Wrapper de env para subprocesses de agentes: allow-list de keys, aislamiento y
 * sanitización de valores para cache/journal.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentOptions } from "../types.js";

const AGENT_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_AGENT_ENV_KEYS = [
	"PATH",
	"HOME",
	"SHELL",
	"TERM",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
];

export interface AgentEnvAccess {
	keyNames: string[];
	missingKeys: string[];
	values: Record<string, string>;
	isolatedEnv: boolean;
	useEnvCommand: boolean;
}

function uniqueStringList(values: Iterable<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		if (!AGENT_ENV_NAME_RE.test(trimmed)) throw new Error(`Nombre de key/env de agente inválido: ${trimmed}`);
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	return out;
}

export function normalizeAgentEnvAccess(options: AgentOptions): AgentEnvAccess {
	const inlineEnv = options.env ?? {};
	const inlineKeys = Object.keys(inlineEnv);
	for (const key of inlineKeys) {
		if (!AGENT_ENV_NAME_RE.test(key)) throw new Error(`Nombre de env de agente inválido: ${key}`);
	}
	const keyNames = uniqueStringList([...(options.keys ?? []), ...inlineKeys]);
	const hasScopedEnv = keyNames.length > 0 || options.inheritEnv === false;
	const isolatedEnv = options.inheritEnv === false || (hasScopedEnv && options.inheritEnv !== true);
	const useEnvCommand = hasScopedEnv;
	const values: Record<string, string> = {};
	const missingKeys: string[] = [];
	if (useEnvCommand && isolatedEnv) {
		for (const key of BASE_AGENT_ENV_KEYS) {
			const value = process.env[key];
			if (value !== undefined) values[key] = value;
		}
		if (!values.PATH) values.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
	}
	for (const key of keyNames) {
		if (Object.hasOwn(inlineEnv, key)) values[key] = String(inlineEnv[key]);
		else if (process.env[key] !== undefined) values[key] = process.env[key]!;
		else missingKeys.push(key);
	}
	return { keyNames, missingKeys, values, isolatedEnv, useEnvCommand };
}

export function formatAgentAccessMarkdown(options: AgentOptions, envAccess: AgentEnvAccess): string {
	const list = (values: string[] | undefined, fallback = "predeterminado") =>
		values?.length ? values.join(", ") : fallback;
	const skillAccess = options.skills?.length
		? `${options.skills.join(", ")}${options.includeSkills === true ? " + descubrimiento" : " (solo explícitas)"}`
		: options.includeSkills === false
			? "deshabilitado"
			: "descubrimiento predeterminado";
	const extensionAccess = options.extensions?.length
		? `${options.extensions.join(", ")}${options.includeExtensions === true ? " + descubrimiento" : " (solo explícitas)"}`
		: options.includeExtensions === true
			? "descubrimiento predeterminado"
			: "deshabilitado";
	return [
		`- tools: ${list(options.tools)}`,
		`- excludeTools: ${list(options.excludeTools, "ninguno")}`,
		`- skills: ${skillAccess}`,
		`- extensions: ${extensionAccess}`,
		`- keys: ${envAccess.keyNames.length ? `${envAccess.keyNames.join(", ")} (valores ocultos)` : envAccess.useEnvCommand ? "ninguna seleccionada" : "entorno heredado predeterminado"}`,
		...(envAccess.missingKeys.length ? [`- missingKeys: ${envAccess.missingKeys.join(", ")}`] : []),
		`- env: ${envAccess.useEnvCommand ? (envAccess.isolatedEnv ? "aislado + keys seleccionadas" : "heredado + overrides seleccionados") : "default del proceso"}`,
	].join("\n");
}

export function sanitizeEnvForCache(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	// La key de cache/journal se guarda en disco: nunca pongas valores raw de env.
	// Hasheá cada valor para ocultar posibles secrets sin perder distinción entre
	// valores distintos de la misma variable al reanudar un resultado journaled.
	for (const key of Object.keys(env).sort())
		out[key] = `sha256:${createHash("sha256")
			.update(env[key] ?? "")
			.digest("hex")}`;
	return out;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function createAgentEnvWrapper(envAccess: AgentEnvAccess): Promise<{ path: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-env-"));
	const scriptPath = path.join(dir, "run-agent.sh");
	const lines = ["#!/usr/bin/env bash", "set -euo pipefail"];
	if (envAccess.isolatedEnv) {
		lines.push(
			"while IFS='=' read -r name _; do",
			'  case "$name" in BASH*|EUID|PPID|SHELLOPTS|UID|PI_DYNAMIC_WORKFLOWS_DEPTH) ;; *) unset "$name" 2>/dev/null || true ;; esac',
			"done < <(env)",
		);
	}
	for (const key of Object.keys(envAccess.values).sort())
		lines.push(`export ${key}=${shellSingleQuote(envAccess.values[key] ?? "")}`);
	lines.push('exec "$@"');
	await fs.writeFile(scriptPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o700 });
	return { path: scriptPath, dir };
}
