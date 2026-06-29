/**
 * Durable guard for transformWorkflowCode — the compiler for the SINGLE workflow
 * authoring contract (top-level script + injected globals + `export const meta` +
 * top-level `return`). Asserts:
 *   - a new top-level script is wrapped in `module.exports = async function workflowMain`
 *     so its top-level `await`/`return` are legal;
 *   - `export const meta = { ... }` is lifted OUT of the wrapper and re-attached to the
 *     exported function (string-aware brace matching, so braces inside strings don't fool it);
 *   - `import` is rejected;
 *   - the legacy `export default async function workflow(ctx, input)` form still transforms
 *     (transitional — removed once all scaffolds/tests use the single interface).
 *
 * Mutation-free: imports the bundled runtime and calls the pure function in memory.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/transform-contract.test.mjs
 */
import * as path from "node:path";
import {
	createChecker,
	REPO_ROOT,
	sdkStub,
	buildExtension as sharedBuildExtension,
} from "../../../shared/test/harness.mjs";

const { check, counts } = createChecker();

let instance = 0;
async function loadRuntime() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-transform-contract",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
	});
	return await import(`${url}?i=${instance++}`);
}

// new Function(...) only PARSES the body; undefined globals (agent/log/args) are fine
// because nothing runs. This is a pure syntax check of the transformed output.
function compiles(code) {
	try {
		new Function("module", "exports", code);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const { transformWorkflowCode } = await loadRuntime();
	check(
		"runtime exports transformWorkflowCode",
		typeof transformWorkflowCode === "function",
		typeof transformWorkflowCode,
	);

	// 1) NEW contract: top-level script + meta + globals + return.
	const NEW = [
		"export const meta = { name: 'x', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] };",
		"log('hi ' + JSON.stringify(args));",
		"const r = await agent('p', { label: 'n', effort: 'high', schema: { type: 'object' } });",
		"return r;",
	].join("\n");
	const outNew = transformWorkflowCode(NEW);
	check(
		"new: body wrapped in module.exports async fn",
		/module\.exports = async function workflowMain\(\)/.test(outNew),
		outNew.slice(0, 60),
	);
	check("new: meta lifted out of the body", !/export const meta/.test(outNew), "still has export const meta");
	check("new: meta re-attached to the exported fn", /module\.exports\.meta =/.test(outNew), "no meta attach");
	check("new: transformed output parses (top-level return/await legal)", compiles(outNew), "parse failed");
	check("new: no leftover export keyword", !/(^|\n)\s*export\s/.test(outNew), "export leaked");

	// 2) string-aware brace matching: a `}` inside a meta string must not end the literal early.
	const TRICKY = "export const meta = { name: 'x', description: 'has } and { in string' };\nreturn 1;";
	const outTricky = transformWorkflowCode(TRICKY);
	check(
		"meta: braces inside strings handled",
		/module\.exports\.meta = \{ name: 'x'/.test(outTricky) && /return 1;/.test(outTricky),
		outTricky.slice(0, 120),
	);

	// 3) import is rejected.
	let importRejected = false;
	try {
		transformWorkflowCode("import x from 'y';\nreturn 1;");
	} catch {
		importRejected = true;
	}
	check("import statements are rejected", importRejected, "not rejected");

	// 4) legacy export-default form still transforms (transitional).
	const OLD = "export default async function workflow(ctx, input) { return 1; }";
	const outOld = transformWorkflowCode(OLD);
	check(
		"legacy: export default -> module.exports",
		/module\.exports = async function workflow\(ctx, input\)/.test(outOld),
		outOld.slice(0, 60),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
