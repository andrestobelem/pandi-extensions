/**
 * Personas built-in/del proyecto y acceso default a tools/skills/extensions
 * (web-search + context7) para subagentes de dynamic-workflows.
 */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentOptions } from "../types.js";
import { resolvePackageExtensionPaths } from "./package-extension-paths.js";

export const DEFAULT_AGENT_WEB_SEARCH_TOOL = "web_search";
export const DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE = "pi-codex-web-search";
export const DEFAULT_CONTEXT7_SKILL_NAME = "context7-cli";
const READ_ONLY_AGENT_TOOLS = ["read", "grep", "find", "ls"];
const PACKAGED_PERSONA_DIRS_SYMBOL = Symbol.for("@pandi-coding-agent/pandi-personas/directories");

type GlobalRegistry = Record<PropertyKey, unknown>;

function personaDirectoryRegistry(): string[] {
	const state = globalThis as GlobalRegistry;
	const current = state[PACKAGED_PERSONA_DIRS_SYMBOL];
	if (Array.isArray(current)) return current as string[];
	const dirs: string[] = [];
	state[PACKAGED_PERSONA_DIRS_SYMBOL] = dirs;
	return dirs;
}

export function registerPersonaDirectory(dir: string): void {
	const resolved = path.resolve(dir);
	const dirs = personaDirectoryRegistry();
	if (!dirs.includes(resolved)) dirs.push(resolved);
}

export function registeredPersonaDirectories(): string[] {
	return [...personaDirectoryRegistry()];
}

export const BUILTIN_AGENT_PERSONAS: Record<string, AgentOptions> = {
	explore: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt:
			"Explorá amplio, pero mantenete basado en evidencia. Preferí inspección read-only, citá archivos/líneas y explicitá la incertidumbre.",
	},
	reviewer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Actuá como reviewer de código escéptico. Buscá riesgos de corrección, seguridad, concurrencia y mantenibilidad. No edites archivos; citá evidencia concreta.",
	},
	planner: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Actuá como planner cuidadoso. Descomponé la tarea, identificá dependencias y riesgos, y proponé un plan mínimo verificable con trade-offs claros.",
	},
	architect: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Actuá como arquitecto de software. Diseñá la solución: definí componentes, interfaces, límites y flujo de datos; evaluá trade-offs y restricciones; y justificá el diseño contra los requisitos. No edites archivos; citá evidencia concreta.",
	},
	implementer: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "medium",
		systemPrompt:
			"Actuá como implementer que diseña un patch concreto. Preferí cambios mínimos, preservá el comportamiento existente y explicá los pasos de verificación. No edites archivos salvo autorización explícita del caller.",
	},
	researcher: {
		tools: READ_ONLY_AGENT_TOOLS,
		thinking: "high",
		systemPrompt:
			"Actuá como researcher. Reuní evidencia independiente, compará alternativas, citá fuentes o archivos y separá hechos de supuestos.",
	},
};

export const PERSONA_OPTION_KEYS = new Set<keyof AgentOptions>([
	"tools",
	"excludeTools",
	"skills",
	"includeSkills",
	"extensions",
	"model",
	"provider",
	"thinking",
	"includeExtensions",
	"approve",
	"useContextFiles",
	"systemPrompt",
	"appendSystemPrompt",
	"timeoutMs",
	"keys",
	"env",
	"inheritEnv",
]);

function sanitizePersonaOptions(value: unknown): AgentOptions {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Los archivos de persona deben contener un objeto JSON.");
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
		throw new Error("agentType solo puede contener letras, números, '.', '_' y '-'.");
	return name;
}

async function readPersonaFile(file: string, agentType: string, source: string): Promise<AgentOptions | undefined> {
	try {
		return sanitizePersonaOptions(JSON.parse(await fs.readFile(file, "utf8")));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(
			`No se pudo cargar la persona ${agentType} desde ${source}: ${err instanceof Error ? err.message : String(err)}`,
			{
				cause: err,
			},
		);
	}
}

async function loadProjectPersona(ctx: ExtensionContext, agentType: string): Promise<AgentOptions | undefined> {
	if (!ctx.isProjectTrusted()) return undefined;
	const name = normalizePersonaName(agentType);
	return await readPersonaFile(path.join(ctx.cwd, CONFIG_DIR_NAME, "personas", `${name}.json`), agentType, "proyecto");
}

async function loadPackagedPersona(agentType: string): Promise<AgentOptions | undefined> {
	const name = normalizePersonaName(agentType);
	for (const dir of registeredPersonaDirectories()) {
		const persona = await readPersonaFile(path.join(dir, `${name}.json`), agentType, dir);
		if (persona) return persona;
	}
	return undefined;
}

export async function applyPersonaOptions(ctx: ExtensionContext, options: AgentOptions): Promise<AgentOptions> {
	if (!options.agentType) return { ...options };
	const name = normalizePersonaName(options.agentType);
	const projectPersona = await loadProjectPersona(ctx, name);
	const packagedPersona = projectPersona ? undefined : await loadPackagedPersona(name);
	const persona = projectPersona ?? packagedPersona ?? BUILTIN_AGENT_PERSONAS[name.toLowerCase()];
	if (!persona) throw new Error(`agentType desconocido: ${options.agentType}`);
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

async function resolveDefaultWebSearchExtensions(ctx: ExtensionContext): Promise<string[]> {
	const packageRoots = appendUniqueValues(undefined, [
		path.join(getAgentDir(), "npm", "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE),
		// La cwd entry carga code desde el project directory en cada subagent, así se gatea
		// detrás de project trust como loadProjectPersona — un untrusted cwd no debe poder
		// drop node_modules/pi-codex-web-search y get it auto-attached. La global agent-dir
		// entry arriba permanece ungated.
		...(ctx.isProjectTrusted() ? [path.join(ctx.cwd, "node_modules", DEFAULT_WEB_SEARCH_EXTENSION_PACKAGE)] : []),
	]);
	const extensions: string[] = [];
	for (const packageRoot of packageRoots) {
		if (!existsSync(packageRoot)) continue;
		extensions.push(...(await resolvePackageExtensionPaths(packageRoot)));
	}
	return appendUniqueValues(undefined, extensions);
}

function resolveDefaultContext7Skill(ctx: ExtensionContext): string | undefined {
	const skillRoots = appendUniqueValues(undefined, [
		// Las cwd-relative roots cargan un skill (attacker-controllable SKILL.md instructions)
		// desde el project directory en cada subagent, así se gatean detrás de project trust
		// como loadProjectPersona y resolveDefaultWebSearchExtensions — un untrusted cwd
		// no debe poder drop .agents/skills/context7-cli y get it auto-attached antes de /trust
		// runs. Las global agent-dir / home roots permanecen ungated.
		...(ctx.isProjectTrusted()
			? [
					path.join(ctx.cwd, ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
					path.join(ctx.cwd, CONFIG_DIR_NAME, "skills", DEFAULT_CONTEXT7_SKILL_NAME),
				]
			: []),
		// getAgentDir() ya resuelve el global skills root de la distribución host
		// (~/.pi/agent bajo vanilla pi, ~/.picante/agent bajo picante), así no
		// se necesita hardcoded ~/.pi fallback aquí.
		path.join(getAgentDir(), "skills", DEFAULT_CONTEXT7_SKILL_NAME),
		path.join(os.homedir(), ".agents", "skills", DEFAULT_CONTEXT7_SKILL_NAME),
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
