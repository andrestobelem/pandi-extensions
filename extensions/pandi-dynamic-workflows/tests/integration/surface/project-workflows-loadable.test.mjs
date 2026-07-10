/**
 * Comportamiento: cada workflow de proyecto commiteado bajo `.pi/workflows/*.js` debe
 * compilar y cargar como módulo bajo la regla real de runtime. El runner de workflows rechaza
 * statements `import` estáticos y cualquier `export` top-level que no sea `export default`
 * (`transformWorkflowCode`), y luego evalúa el módulo CommonJS transformado en un sandbox
 * sin `require` ni builtins de node. Un workflow que viola esto falla en el segundo 0 con
 * "Static import statements are not supported in workflows" — exactamente así se rompió
 * `.pi/workflows/continuous-improvement.js` en silencio cuando se introdujo el ban de imports.
 *
 * Este guard llama el `transformWorkflowCode` exportado REAL, evalúa el módulo transformado
 * en un contexto VM mínimo y aserta que exporta una función de workflow. Deliberadamente NO
 * ejecuta el body del workflow: los workflows de proyecto son confiables/costosos y pueden
 * spawnear agentes, correr bash o escribir artifacts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { sdkStub, buildExtension as sharedBuildExtension } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		console.log(`FAIL: ${label}${detail ? `  [${String(detail).slice(0, 300)}]` : ""}`);
	}
}

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-workflows-loadable",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

async function listProjectWorkflows() {
	const dir = path.join(REPO_ROOT, ".pi", "workflows");
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

function loadTransformedWorkflow(rel, compiled) {
	const module = { exports: {} };
	const context = vm.createContext({ module, exports: module.exports });
	vm.runInContext(compiled, context, { filename: rel, timeout: 1000 });
	return module.exports;
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const transformWorkflowCode = mod.transformWorkflowCode;
	check("transformWorkflowCode: exported", typeof transformWorkflowCode === "function", typeof transformWorkflowCode);
	if (typeof transformWorkflowCode !== "function") return;

	const workflows = await listProjectWorkflows();
	check("project workflows: at least one .js present", workflows.length > 0, `found ${workflows.length}`);

	for (const file of workflows) {
		const rel = path.relative(REPO_ROOT, file);
		const code = await fs.readFile(file, "utf8");
		let compiled;
		let transformError;
		try {
			compiled = transformWorkflowCode(code);
		} catch (err) {
			transformError = err?.message ? err.message : String(err);
		}
		check(`compiles under runtime rule: ${rel}`, !transformError, transformError);
		if (transformError) continue;

		let loaded;
		let loadError;
		try {
			loaded = loadTransformedWorkflow(rel, compiled);
		} catch (err) {
			loadError = err?.message ? err.message : String(err);
		}
		check(`module-loads in workflow VM: ${rel}`, !loadError, loadError);
		check(`exports workflow function: ${rel}`, typeof loaded === "function", typeof loaded);
	}
}

main()
	.then(() => {
		console.log(`\n${passed} passed, ${failed} failed`);
		process.exit(failed === 0 ? 0 : 1);
	})
	.catch((err) => {
		console.error(err?.stack ? err.stack : String(err));
		process.exit(1);
	});
