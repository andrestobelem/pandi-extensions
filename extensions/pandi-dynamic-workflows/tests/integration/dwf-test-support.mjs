/**
 * Soporte de tests para pandi-dynamic-workflows (solo integración; no es runtime de extensión).
 *
 * Centraliza el bundle esbuild de index.ts y submódulos con los stubs estándar de DWF,
 * sin sacar código fuera del paquete de la extensión.
 */

import * as path from "node:path";
import { buildExtension, loadDefault, loadModule, REPO_ROOT, sdkStub } from "../../../shared/test/harness.mjs";

export { loadDefault, loadModule, REPO_ROOT };

export const EXT_DIR = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows");
export const SCAFFOLDS_DIR = path.join(EXT_DIR, "scaffolds");
export const DWF_INDEX = path.join(EXT_DIR, "index.ts");

/** Stubs compartidos por casi todas las suites de DWF. */
export function dwfStubs(customEditor = "render") {
	return {
		typebox: true,
		typeboxValue: true,
		ai: true,
		tui: true,
		sdk: (dir) => sdkStub(dir, { customEditor }),
	};
}

/**
 * Bundle del entry principal (index.ts) o de otro src bajo EXT_DIR.
 *
 * @param {object} opts
 * @param {string} opts.name — prefijo del tempdir (requerido).
 * @param {"render"|"full"} [opts.customEditor]
 * @param {boolean} [opts.copyScaffolds] — copia scaffolds/ junto al bundle.
 * @param {string} [opts.src] — absoluto; default index.ts.
 * @param {string} [opts.outName] — default dynamic-workflows.mjs.
 */
export async function buildDwfExtension({
	name,
	customEditor = "render",
	copyScaffolds = false,
	src = DWF_INDEX,
	outName = "dynamic-workflows.mjs",
	stubs: extraStubs = {},
	...rest
}) {
	if (!name) throw new Error("buildDwfExtension: { name } is required");
	return await buildExtension({
		name,
		src,
		outName,
		stubs: { ...dwfStubs(customEditor), ...extraStubs },
		...(copyScaffolds ? { copyDirs: { scaffolds: SCAFFOLDS_DIR } } : {}),
		...rest,
	});
}

/** Bundle de un submódulo relativo a EXT_DIR (p. ej. lifecycle/index.ts). */
export async function buildDwfModule({ name, relPath, outName, customEditor = "render", ...rest }) {
	return await buildDwfExtension({
		name,
		src: path.join(EXT_DIR, relPath),
		outName,
		customEditor,
		...rest,
	});
}
