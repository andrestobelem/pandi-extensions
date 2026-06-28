/**
 * Agent environment, persona, and default-access kernel for pi-dynamic-workflows.
 *
 * Builds the env wrapper for agent subprocesses (key allow-listing, isolation,
 * value sanitization), resolves built-in/project personas, and applies default
 * tool/skill/extension access (web-search + context7). 14 of 20 decls are
 * module-private; index.ts imports back the 6 it still calls.
 *
 * Deferred runtime cycle with index.ts: the persona/default consts are imported
 * from ./index.js but read only inside cluster function bodies; AgentOptions crosses
 * as import type (erased). CONFIG_DIR_NAME/getAgentDir/ExtensionContext come from the
 * framework package (no cycle). Extracted byte-identically from index.ts.
 */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_AGENT_PERSONAS,
	PERSONA_OPTION_KEYS,
	DEFAULT_AGENT_WEB_SEARCH_TOOL,
	DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE,
	DEFAULT_CONTEXT7_SKILL_NAME,
} from "./index.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOptions } from "./index.js";

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

interface AgentEnvAccess {
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
		if (!AGENT_ENV_NAME_RE.test(trimmed)) throw new Error(`Invalid agent key/env name: ${trimmed}`);
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
		if (!AGENT_ENV_NAME_RE.test(key)) throw new Error(`Invalid agent env name: ${key}`);
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
		if (Object.prototype.hasOwnProperty.call(inlineEnv, key)) values[key] = String(inlineEnv[key]);
		else if (process.env[key] !== undefined) values[key] = process.env[key]!;
		else missingKeys.push(key);
	}
	return { keyNames, missingKeys, values, isolatedEnv, useEnvCommand };
}

export function formatAgentAccessMarkdown(options: AgentOptions, envAccess: AgentEnvAccess): string {
	const list = (values: string[] | undefined, fallback = "default") =>
		values && values.length ? values.join(", ") : fallback;
	const skillAccess = options.skills?.length
		? `${options.skills.join(", ")}${options.includeSkills === true ? " + discovery" : " (explicit only)"}`
		: options.includeSkills === false
			? "disabled"
			: "default discovery";
	const extensionAccess = options.extensions?.length
		? `${options.extensions.join(", ")}${options.includeExtensions === true ? " + discovery" : " (explicit only)"}`
		: options.includeExtensions === true
			? "default discovery"
			: "disabled";
	return [
		`- tools: ${list(options.tools)}`,
		`- excludeTools: ${list(options.excludeTools, "none")}`,
		`- skills: ${skillAccess}`,
		`- extensions: ${extensionAccess}`,
		`- keys: ${envAccess.keyNames.length ? `${envAccess.keyNames.join(", ")} (values redacted)` : envAccess.useEnvCommand ? "none selected" : "default inherited environment"}`,
		...(envAccess.missingKeys.length ? [`- missingKeys: ${envAccess.missingKeys.join(", ")}`] : []),
		`- env: ${envAccess.useEnvCommand ? (envAccess.isolatedEnv ? "isolated + selected keys" : "inherited + selected overrides") : "process default"}`,
	].join("\n");
}

export function sanitizeEnvForCache(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const key of Object.keys(env).sort()) out[key] = "[set]";
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
			'  case "$name" in BASH*|EUID|PPID|SHELLOPTS|UID) ;; *) unset "$name" 2>/dev/null || true ;; esac',
			"done < <(env)",
		);
	}
	for (const key of Object.keys(envAccess.values).sort())
		lines.push(`export ${key}=${shellSingleQuote(envAccess.values[key] ?? "")}`);
	lines.push('exec "$@"');
	await fs.writeFile(scriptPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o700 });
	return { path: scriptPath, dir };
}

function sanitizePersonaOptions(value: unknown): AgentOptions {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Persona files must contain a JSON object.");
	const source = value as Record<string, unknown>;
	const out: AgentOptions = {};
	for (const key of PERSONA_OPTION_KEYS) {
		if (source[key] !== undefined) (out as Record<string, unknown>)[key] = source[key];
	}
	return out;
}

function mergePersonaOptions(persona: AgentOptions, options: AgentOptions): AgentOptions {
	const appendSystemPrompt = [persona.appendSystemPrompt, options.appendSystemPrompt]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n\n");
	return {
		...persona,
		...options,
		...(appendSystemPrompt ? { appendSystemPrompt } : {}),
	};
}

function normalizePersonaName(agentType: string): string {
	const name = agentType.trim();
	if (!/^[a-zA-Z0-9._-]+$/.test(name))
		throw new Error("agentType may only contain letters, numbers, '.', '_', and '-'.");
	return name;
}

async function loadProjectPersona(ctx: ExtensionContext, agentType: string): Promise<AgentOptions | undefined> {
	if (!ctx.isProjectTrusted()) return undefined;
	const name = normalizePersonaName(agentType);
	const file = path.join(ctx.cwd, CONFIG_DIR_NAME, "personas", `${name}.json`);
	try {
		return sanitizePersonaOptions(JSON.parse(await fs.readFile(file, "utf8")));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to load persona ${agentType}: ${err instanceof Error ? err.message : String(err)}`, {
			cause: err,
		});
	}
}

export async function applyPersonaOptions(ctx: ExtensionContext, options: AgentOptions): Promise<AgentOptions> {
	if (!options.agentType) return { ...options };
	const name = normalizePersonaName(options.agentType);
	const projectPersona = await loadProjectPersona(ctx, name);
	const persona = projectPersona ?? BUILTIN_AGENT_PERSONAS[name.toLowerCase()];
	if (!persona) throw new Error(`Unknown agentType: ${options.agentType}`);
	return mergePersonaOptions(persona, options);
}

function appendUniqueValues(values: string[] | undefined, additions: string[]): string[] {
	const out = [...(values ?? [])];
	const seen = new Set(out);
	for (const value of additions) {
		if (!seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

function existingRealPath(candidate: string): string | undefined {
	try {
		if (!existsSync(candidate)) return undefined;
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

async function resolvePiPackageExtensionPaths(packageRoot: string): Promise<string[]> {
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
			pi?: { extensions?: unknown };
		};
		const extensions = manifest.pi?.extensions;
		if (Array.isArray(extensions)) {
			const resolved = extensions
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => existingRealPath(path.resolve(packageRoot, entry)))
				.filter((entry): entry is string => !!entry);
			if (resolved.length) return resolved;
		}
	} catch {
		// Fall back to conventional entrypoints below.
	}
	const fallback =
		existingRealPath(path.join(packageRoot, "src", "index.ts")) ??
		existingRealPath(path.join(packageRoot, "index.ts"));
	return fallback ? [fallback] : [];
}

async function resolveDefaultWebSearchExtensions(ctx: ExtensionContext): Promise<string[]> {
	const packageRoots = appendUniqueValues(undefined, [
		path.join(getAgentDir(), "npm", "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE),
		path.join(ctx.cwd, "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE),
	]);
	const extensions: string[] = [];
	for (const packageRoot of packageRoots) {
		if (!existsSync(packageRoot)) continue;
		extensions.push(...(await resolvePiPackageExtensionPaths(packageRoot)));
	}
	return appendUniqueValues(undefined, extensions);
}

function resolveDefaultContext7Skill(ctx: ExtensionContext): string | undefined {
	const skillRoots = appendUniqueValues(undefined, [
		path.join(ctx.cwd, ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(ctx.cwd, CONFIG_DIR_NAME, "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(getAgentDir(), "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(os.homedir(), ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(os.homedir(), ".pi", "agent", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
	]);
	for (const skillRoot of skillRoots) {
		if (existsSync(path.join(skillRoot, "SKILL.md"))) return existingRealPath(skillRoot) ?? skillRoot;
	}
	return undefined;
}

export async function applyDefaultAgentAccess(ctx: ExtensionContext, options: AgentOptions): Promise<AgentOptions> {
	const out: AgentOptions = { ...options };
	let webSearchExtensions: string[] = [];
	if (out.includeExtensions !== false) {
		webSearchExtensions = await resolveDefaultWebSearchExtensions(ctx);
		if (out.includeExtensions !== true && webSearchExtensions.length)
			out.extensions = appendUniqueValues(out.extensions, webSearchExtensions);
	}
	const hasExplicitToolAllowlist = Array.isArray(out.tools) && out.tools.length > 0;
	const excludesWebSearch = out.excludeTools?.includes(DEFAULT_AGENT_WEB_SEARCH_TOOL) === true;
	const webSearchAvailable =
		out.includeExtensions === true ||
		webSearchExtensions.length > 0 ||
		(out.extensions ?? []).some((extensionPath) => /web[-_]?search|codex-web-search/i.test(extensionPath));
	if (hasExplicitToolAllowlist && webSearchAvailable && !excludesWebSearch) {
		out.tools = appendUniqueValues(out.tools, [DEFAULT_AGENT_WEB_SEARCH_TOOL]);
	}
	if (out.includeSkills !== false && out.skills?.length) {
		const context7Skill = resolveDefaultContext7Skill(ctx);
		if (context7Skill) out.skills = appendUniqueValues(out.skills, [context7Skill]);
	}
	return out;
}
