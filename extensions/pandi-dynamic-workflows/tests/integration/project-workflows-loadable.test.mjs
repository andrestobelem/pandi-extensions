/**
 * Behavior: every committed project workflow under `.pi/workflows/*.js` must
 * actually LOAD under the real runtime rule. The workflow runner rejects static
 * `import` statements and any non-`export default` top-level `export`
 * (`transformWorkflowCode`), and runs workflows in a sandbox without
 * `require`/node builtins. A workflow that violates this fails at second 0 with
 * "Static import statements are not supported in workflows" — which is exactly
 * how `.pi/workflows/continuous-improvement.js` silently broke after the
 * import-ban was introduced.
 *
 * This guard calls the REAL exported `transformWorkflowCode` on each project
 * workflow and asserts it does not throw, so the class of bug can never return
 * unnoticed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

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
		let error;
		try {
			transformWorkflowCode(code);
		} catch (err) {
			error = err?.message ? err.message : String(err);
		}
		check(`loads under runtime rule: ${rel}`, !error, error);
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
