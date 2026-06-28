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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-workflows-loadable-"));
	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n",
	);
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} input() {} render() { return []; } }\n`,
	);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(
		tuiStub,
		`export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`,
	);

	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:typebox/value=${typeboxValueStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--alias:@earendil-works/pi-ai=${aiStub}`,
			`--alias:@earendil-works/pi-tui=${tuiStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { url: pathToFileURL(out).href };
}

async function listProjectWorkflows() {
	const dir = path.join(REPO_ROOT, ".pi", "workflows");
	let entries = [];
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
	check(
		"project workflows: continuous-improvement.js present",
		workflows.some((file) => path.basename(file) === "continuous-improvement.js"),
		workflows.map((file) => path.basename(file)).join(", "),
	);

	for (const file of workflows) {
		const rel = path.relative(REPO_ROOT, file);
		const code = await fs.readFile(file, "utf8");
		let error;
		try {
			transformWorkflowCode(code);
		} catch (err) {
			error = err && err.message ? err.message : String(err);
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
		console.error(err && err.stack ? err.stack : String(err));
		process.exit(1);
	});
