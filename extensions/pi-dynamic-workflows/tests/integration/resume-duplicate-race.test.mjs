#!/usr/bin/env node
/**
 * Regression: two CONCURRENT resumes of the same run must not both execute.
 *
 * Farley review 2026-07-03, finding #1 (High): resumeWorkflow checks
 * `activeRuns.has(runId)` and then awaits resolveWorkflow/readFile/loadJournal/…
 * before startWorkflowBackground/runWorkflowWithUi eventually registers the run,
 * so two resumes fired in the same tick both pass the guard and both drive
 * runWorkflow against the SAME runDir/journal (duplicate agents, artifact
 * clobbering, corrupted status).
 *
 * Contract pinned here:
 *   - Firing action=resume twice without awaiting the first: exactly ONE call
 *     executes; the other is rejected with an "already active/being resumed"
 *     error (no silent double execution).
 *   - A sequential resume after the first finishes still works (the reservation
 *     is released on completion), rejected only for non-resumable states.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// Sleeps so both resumes overlap, then fails so the run stays resumable.
const WORKFLOW = [
	"export const meta = { name: 'race', description: 'resume race probe' };",
	"await sleep(500);",
	"throw new Error('boom (stays resumable)');",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-resume-race",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
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
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
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

const settle = (p) =>
	p.then(
		(v) => ({ ok: true, v }),
		(e) => ({ ok: false, msg: String(e?.message ?? e) }),
	);

// A resume attempt "executed" unless it was rejected as already active/resuming.
const wasRejectedAsActive = (r) => {
	if (!r.ok) return /already (active|being resumed|resuming)/i.test(r.msg);
	const text = JSON.stringify(r.v ?? "");
	return /already (active|being resumed|resuming)/i.test(text);
};

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-resume-race-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "race.js"), `${WORKFLOW}\n`, "utf8");
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);
	const run = (params) =>
		tool.execute(`tc-${Math.random().toString(36).slice(2)}`, params, new AbortController().signal, undefined, ctx);

	// Seed: one failed (resumable) run.
	const first = await settle(run({ action: "run", name: "race", input: {}, timeoutMs: 30_000 }));
	const runsDir = path.join(project, ".pi", "workflows", "runs");
	const runIds = (await fs.readdir(runsDir)).filter((d) => d.includes("race"));
	check("seed run left exactly one run dir", runIds.length === 1, JSON.stringify({ first, runIds }));
	const runId = runIds[0];

	// The race: two resumes in the same tick.
	const [a, b] = await Promise.all([
		settle(run({ action: "resume", name: runId, timeoutMs: 30_000 })),
		settle(run({ action: "resume", name: runId, timeoutMs: 30_000 })),
	]);
	const rejectedAsActive = [a, b].filter(wasRejectedAsActive).length;
	check(
		"exactly one concurrent resume is rejected as already active",
		rejectedAsActive === 1,
		JSON.stringify({ a: a.ok ? "(ran)" : a.msg, b: b.ok ? "(ran)" : b.msg }),
	);

	// Reservation released: a later sequential resume reaches normal validation
	// (it executes again — the run is still failed/resumable — not "already active").
	const later = await settle(run({ action: "resume", name: runId, timeoutMs: 30_000 }));
	check(
		"sequential resume afterwards is not blocked by a stale reservation",
		!wasRejectedAsActive(later),
		later.ok ? "(ran)" : later.msg,
	);

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
