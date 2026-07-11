/**
 * Engine smoke for the SINGLE (Workflow-tool) authoring contract, end-to-end through the
 * real Worker — with NO agent() calls, so it never needs provider auth.
 *
 * Authors a workflow in the new contract (top-level script, injected globals
 * `phase`/`log`/`args`/`parallel`/`pipeline`/`bash`/`writeArtifact`, `export const meta`,
 * and a top-level `return`) and runs it via the dynamic_workflow tool against a freshly
 * built extension, asserting:
 *   - it runs and returns the top-level value (transform wraps top-level return/await);
 *   - `args` is the parsed input object;
 *   - `parallel([thunks])` settles a thrown branch to null (partial-failure accounting);
 *   - `pipeline([items], ...stages)` threads stages per item;
 *   - `bash()` runs;
 *   - `export const meta` is lifted out and does not break execution.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/engine-smoke-new-contract.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { check, counts } = createChecker();

const WORKFLOW = [
	"export const meta = { name: 'smoke', description: 'no-agent engine smoke', phases: [{ title: 'P' }, { title: 'R' }] };",
	"phase('P');",
	"log('smoke start ' + JSON.stringify({ args }));",
	"const squares = await parallel([0, 1, 2].map((i) => async () => { if (i === 1) throw new Error('branch 1 fails'); return i * i; }));",
	"const doubled = await pipeline([1, 2, 3], async (x) => x + 1, async (x) => x * 2);",
	"const ls = await bash('echo inside');",
	"phase('R');",
	"const failed = squares.filter((v) => v == null).length;",
	"await writeArtifact('smoke.json', { squares, doubled, failed });",
	"return { squares, failed, doubled, echo: (ls.stdout || '').trim(), n: args && args.n };",
].join("\n");

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dw-engine-smoke" });
}

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		// Faithful enough for the smoke: execute `echo <x>` so bash() output threads through
		// the host bridge (real `pi.exec` runs the command; here we mimic just echo).
		exec: async (cmd, argv = []) => {
			if (cmd === "bash") {
				const m = /^echo\s+(.*)$/.exec(String(argv[1] ?? "").trim());
				return { code: 0, killed: false, stdout: m ? `${m[1]}\n` : "", stderr: "" };
			}
			return { code: 0, killed: false, stdout: "", stderr: "" };
		},
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-smoke-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "smoke.js"), `${WORKFLOW}\n`, "utf8");
	return project;
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const project = await makeProject();
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	const res = await tool.execute(
		"tc-smoke",
		{ action: "run", name: "smoke", input: { n: 4 }, timeoutMs: 30_000 },
		new AbortController().signal,
		undefined,
		ctx,
	);
	const result = res?.details?.result;
	const out = result?.output;

	check("new contract: run succeeds", result?.ok === true, result?.error);
	check("new contract: top-level return value surfaced", out != null && typeof out === "object", JSON.stringify(out));
	check("args reached the script (n=4)", out?.n === 4, JSON.stringify(out));
	check(
		"parallel settles a thrown branch to null",
		Array.isArray(out?.squares) && out.squares[1] === null,
		JSON.stringify(out?.squares),
	);
	check(
		"parallel keeps successful branches",
		out?.squares?.[0] === 0 && out?.squares?.[2] === 4,
		JSON.stringify(out?.squares),
	);
	check("partial-failure count is honest (failed=1)", out?.failed === 1, JSON.stringify(out));
	check(
		"pipeline threads stages per item ([4,6,8])",
		JSON.stringify(out?.doubled) === JSON.stringify([4, 6, 8]),
		JSON.stringify(out?.doubled),
	);
	check("bash ran (echo inside)", out?.echo === "inside", JSON.stringify(out?.echo));

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
