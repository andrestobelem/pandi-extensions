#!/usr/bin/env node
/**
 * Regression: action=resume must honor explicit limit params.
 *
 * Found live during the Farley review (2026-07-03): a failed run was resumed
 * with maxAgents=150, but the resumed run executed with maxAgents=64
 * (DEFAULT_MAX_AGENTS) and died at the same wall again. Cause: the resume
 * handler never forwarded params.concurrency/maxAgents/timeoutMs/agentTimeoutMs
 * — resumeWorkflow rebuilt limits from input.json alone, silently ignoring the
 * knobs the tool schema advertises. (The start branch already merges
 * {...limitParamsFromInput(input), ...params}.)
 *
 * Contract pinned here:
 *   - resume with explicit maxAgents/concurrency runs with those limits.
 *   - resume WITHOUT explicit params keeps the input.json-derived limits
 *     (existing precedence preserved).
 *
 * The probe workflow fails until ready.txt exists, then returns the limits it
 * actually ran with — so the resumed execution reports its own budget.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const WORKFLOW = [
	"export const meta = { name: 'lim', description: 'limits probe' };",
	"let ready = false;",
	"try { await readFile('ready.txt'); ready = true; } catch {}",
	"if (!ready) throw new Error('not ready yet (stays resumable)');",
	"return { maxAgents: limits.maxAgents, concurrency: limits.concurrency };",
].join("\n");

function makePi() {
	const tools = new Map();
	return {
		pi: {
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
			exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
		},
		tools,
	};
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

const settle = (p) =>
	p.then(
		(v) => ({ ok: true, v }),
		(e) => ({ ok: false, msg: String(e?.message ?? e) }),
	);

async function seedFailedRun(run, project, name, input) {
	await fs.writeFile(path.join(project, ".pi", "workflows", `${name}.js`), `${WORKFLOW}\n`, "utf8");
	const seeded = await settle(run({ action: "run", name, input, timeoutMs: 30_000 }));
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const runId = (await fs.readdir(runsDir)).find((d) => d.includes(name));
	return { seeded, runId };
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-resume-limits",
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
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-resume-limits-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);
	const run = (params) =>
		tool.execute(`tc-${Math.random().toString(36).slice(2)}`, params, new AbortController().signal, undefined, ctx);

	// --- explicit params on resume win ------------------------------------------
	const a = await seedFailedRun(run, project, "lima", {});
	check("seed a: failed as designed", a.seeded.ok === false, a.seeded.ok ? "unexpected ok" : "");
	check("seed a: run dir exists", !!a.runId);
	await fs.writeFile(path.join(project, "ready.txt"), "go\n", "utf8");
	const resumedA = await settle(run({ action: "resume", name: a.runId, maxAgents: 33, concurrency: 2 }));
	check("resume a: succeeds", resumedA.ok === true, resumedA.ok ? "" : resumedA.msg.slice(0, 200));
	const outA = resumedA.v?.details?.result?.output;
	check("resume honors explicit maxAgents=33", outA?.maxAgents === 33, JSON.stringify(outA));
	check("resume honors explicit concurrency=2", outA?.concurrency === 2, JSON.stringify(outA));

	// --- without explicit params, input.json-derived limits win ------------------
	await fs.rm(path.join(project, "ready.txt"), { force: true });
	const b = await seedFailedRun(run, project, "limb", { maxAgents: 21 });
	check("seed b: failed as designed", b.seeded.ok === false);
	await fs.writeFile(path.join(project, "ready.txt"), "go\n", "utf8");
	const resumedB = await settle(run({ action: "resume", name: b.runId }));
	check("resume b: succeeds", resumedB.ok === true, resumedB.ok ? "" : resumedB.msg.slice(0, 200));
	const outB = resumedB.v?.details?.result?.output;
	check("input.json limits still win when no params passed", outB?.maxAgents === 21, JSON.stringify(outB));

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
