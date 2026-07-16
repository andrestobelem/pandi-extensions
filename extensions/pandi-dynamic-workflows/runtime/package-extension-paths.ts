/** Resuelve los entrypoints declarados por un paquete Pi con fallback convencional. */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function existingRealPath(candidate: string): string | undefined {
	try {
		if (!existsSync(candidate)) return undefined;
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

export async function resolvePackageExtensionPaths(packageRoot: string): Promise<string[]> {
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
		// Un paquete sin manifest válido conserva el fallback convencional.
	}
	const fallback =
		existingRealPath(path.join(packageRoot, "src", "index.ts")) ??
		existingRealPath(path.join(packageRoot, "index.ts"));
	return fallback ? [fallback] : [];
}
