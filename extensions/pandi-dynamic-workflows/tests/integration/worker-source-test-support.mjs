import * as path from "node:path";
import { REPO_ROOT, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

export const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");

/** Extrae el set de globals inyectados: `sandbox.<name> = …`, excluyendo internos con prefijo `_`. */
export function injectedGlobals(source) {
	const names = new Set();
	for (const m of source.matchAll(/sandbox\.([A-Za-z][A-Za-z0-9]*)\s*=/g)) names.add(m[1]);
	return names;
}

export async function loadWorkerSource(name) {
	const { url } = await sharedBuildExtension({
		name,
		src: path.join(EXT_DIR, "worker-source.ts"),
		outName: "worker-source.mjs",
	});
	const mod = await import(url);
	return mod.WORKFLOW_WORKER_SOURCE;
}

export async function loadInjectedGlobals(name) {
	return injectedGlobals(await loadWorkerSource(name));
}
