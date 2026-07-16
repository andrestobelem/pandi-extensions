/**
 * Re-inyección selectiva de extensiones que registran providers custom cuando los
 * subagentes corren con --no-extensions (issue #86).
 */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentOptions } from "../types.js";

/** Paquetes npm conocidos cuyo nombre no sigue la convención pi-<provider>. */
const PROVIDER_EXTENSION_PACKAGES: Partial<Record<string, string[]>> = {
	"claude-bridge": ["pi-claude-bridge"],
	"xai-auth": ["pi-xai-oauth", "pi-xai-auth"],
};

const builtinProviders = new Set<string>(getBuiltinProviders());

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

async function resolveInstalledPackageExtensionPaths(packageRoot: string): Promise<string[]> {
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

function providerPackageCandidates(provider: string): string[] {
	const known = PROVIDER_EXTENSION_PACKAGES[provider] ?? [];
	const conventional = [`pi-${provider}`, provider];
	return appendUniqueValues(undefined, [...known, ...conventional]);
}

function providerPackageRoots(ctx: ExtensionContext): string[] {
	return appendUniqueValues(undefined, [
		path.join(getAgentDir(), "npm", "node_modules"),
		...(ctx.isProjectTrusted() ? [path.join(ctx.cwd, "node_modules")] : []),
	]);
}

export function isBuiltinProvider(provider: string): boolean {
	return builtinProviders.has(provider);
}

/** Provider efectivo antes de la resolución de tier aliases (suficiente para elegir extensiones). */
export function resolveSpawnProvider(options: AgentOptions, ctx: ExtensionContext): string | undefined {
	if (options.provider) return options.provider;
	const model = options.model;
	if (model?.includes("/")) return model.split("/")[0];
	if (model) return ctx.model?.provider;
	return ctx.model?.provider;
}

export async function resolveProviderExtensionPaths(ctx: ExtensionContext, provider: string): Promise<string[]> {
	if (!provider || isBuiltinProvider(provider)) return [];
	const extensions: string[] = [];
	for (const modulesRoot of providerPackageRoots(ctx)) {
		if (!existsSync(modulesRoot)) continue;
		for (const packageName of providerPackageCandidates(provider)) {
			const packageRoot = path.join(modulesRoot, packageName);
			if (!existsSync(packageRoot)) continue;
			extensions.push(...(await resolveInstalledPackageExtensionPaths(packageRoot)));
		}
	}
	return appendUniqueValues(undefined, extensions);
}

/** Mantiene --no-extensions pero re-inyecta la extensión dueña del provider custom. */
export async function applyProviderExtensionAccess(
	ctx: ExtensionContext,
	options: AgentOptions,
): Promise<AgentOptions> {
	if (options.includeExtensions === true) return options;
	const provider = resolveSpawnProvider(options, ctx);
	if (!provider) return options;
	const providerExtensions = await resolveProviderExtensionPaths(ctx, provider);
	if (!providerExtensions.length) return options;
	return {
		...options,
		extensions: appendUniqueValues(options.extensions, providerExtensions),
	};
}
