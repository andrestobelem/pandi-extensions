#!/usr/bin/env node
/**
 * Regression: a fail-fast agents() rejection must not orphan its siblings.
 *
 * Farley review 2026-07-03, finding #4: when a non-settle agents() branch
 * rejected, mapLimit rejected immediately but did nothing about the rest of
 * the fan-out — the in-flight sibling subagents kept RUNNING to completion
 * (their results discarded) and idle workers kept PICKING UP NEW items, all
 * unobserved, silently burning tokens and maxAgents budget. Visible whenever
 * the workflow catches the rejection and continues (fallback logic).
 *
 * Note a subagent that merely exits nonzero RESOLVES with ok:false (it does
 * not reject); the fan-out rejects on real throws — schema validation
 * (schemaOnInvalid "throw"), maxAgents budget, abort — which are exactly the
 * failure modes observed live (schema:bad, budget walls). The failing branch
 * here uses a schema the fake pi can never satisfy.
 *
 * Contract pinned here (real Worker + faked pi subprocess, same seam as
 * race-cancellation.test.mjs):
 *   - agents() still rejects with the ORIGINAL branch error.
 *   - the in-flight sibling receives SIGTERM at failure time (not at run end).
 *   - queued items are never started after the failure.
 *   - settle:true keeps its independent-branches semantics (all run, nulls).
 *
 * Determinism: the failing branch waits (filesystem barrier) until the sibling
 * has spawned before exiting 1; concurrency 2 with 4 items guarantees items
 * 2/3 are still queued at failure time. The run then sleeps so orphans would
 * have a window to complete/spawn before run-end teardown could mask the bug.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// The workflow CATCHES the fan-out rejection and keeps the run alive, so orphaned
// siblings (the bug) have time to complete / spawn before run-end teardown.
const WORKFLOW = [
	"let err = null;",
	"try { await agents(args.items, { concurrency: 2 }); } catch (e) { err = String((e && e.message) || e); }",
	"await sleep(2500);",
	"return { err };",
].join("\n");

const SETTLE_WORKFLOW = [
	"const results = await agents(args.items, { concurrency: 2, settle: true });",
	"return { nulls: results.filter((r) => r === null).length, total: results.length };",
].join("\n");

// A schema the fake pi can never satisfy: the failing branch throws (schemaOnInvalid
// defaults to "throw"); schemaRetries 0 keeps it to a single attempt.
const failingItem = (id, need) => ({
	prompt: `[role:fail-barrier][id:${id}][need:${need}] dud`,
	schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
	schemaRetries: 0,
});

// Roles encoded in the prompt:
//   [role:fail-barrier][id:X][need:N] -> wait until N `spawned-*` markers exist, then exit 1.
//   [role:lose][id:X] -> write spawned-X; SIGTERM -> cancelled-X; else complete after 1s (completed-X).
//   [role:ok][id:X]   -> write spawned-X, emit output, exit 0.
async function writeFakePi(barrierDir, tag) {
	const fakePi = path.join(barrierDir, `fake-pi-${tag}.cjs`);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[process.argv.length - 1] || "";
const dir = ${JSON.stringify(barrierDir)};
function marker(name) { try { fs.writeFileSync(path.join(dir, name), "x"); } catch {} }
function emitThenExit(text) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n", () => process.exit(0));
}
const id = (/\\[id:([a-z0-9]+)\\]/.exec(prompt) || [])[1] || "x";
if (/\\[role:fail-barrier\\]/.test(prompt)) {
  const need = Number((/\\[need:(\\d+)\\]/.exec(prompt) || [])[1] || "1");
  const start = Date.now();
  (function poll() {
    let n = 0;
    try { n = fs.readdirSync(dir).filter((f) => f.startsWith("spawned-")).length; } catch {}
    if (n >= need || Date.now() - start > 8000) { marker("failed-" + id); process.exit(1); }
    else setTimeout(poll, 15);
  })();
} else if (/\\[role:ok\\]/.test(prompt)) {
  marker("spawned-" + id); emitThenExit("OK-" + id);
} else {
  process.on("SIGTERM", () => { marker("cancelled-" + id); process.exit(143); });
  marker("spawned-" + id);
  setTimeout(() => { marker("completed-" + id); process.exit(0); }, 1000);
}
`,
		{ mode: 0o700 },
	);
	return fakePi;
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

async function withFakePi(fakePi, fn) {
	const old = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		return await fn();
	} finally {
		if (old === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = old;
	}
}

async function listMarkers(dir, prefix) {
	return (await fs.readdir(dir)).filter((f) => f.startsWith(prefix));
}

let tagSeq = 0;
async function makeRunner(url, workflowName, workflowBody) {
	const tag = tagSeq++;
	const mod = await import(`${url}?i=${tag}`);
	const ext = mod.default;
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-ff-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", `${workflowName}.js`), `${workflowBody}\n`, "utf8");
	const barrierDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-ff-barrier-"));
	const fakePi = await writeFakePi(barrierDir, `ff-${tag}`);
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const run = (params) =>
		withFakePi(fakePi, async () => {
			const res = await tool.execute("tc-ff", params, new AbortController().signal, undefined, makeCtx(project));
			return res?.details?.result;
		});
	return { run, barrierDir };
}

async function scenarioFailFastCancelsSiblings(url) {
	const { run, barrierDir } = await makeRunner(url, "ff", WORKFLOW);
	const result = await run({
		action: "run",
		name: "ff",
		input: {
			items: [
				failingItem("f0", 1),
				{ prompt: "[role:lose][id:s1] slow sibling" },
				{ prompt: "[role:lose][id:s2] queued" },
				{ prompt: "[role:lose][id:s3] queued" },
			],
		},
		concurrency: 2,
		maxAgents: 8,
		timeoutMs: 60_000,
	});
	check("fail-fast: run succeeds (workflow caught the rejection)", result?.ok === true, result?.error);
	check(
		"fail-fast: agents() rejected with the ORIGINAL branch error",
		typeof result?.output?.err === "string" && result.output.err.length > 0,
		JSON.stringify(result?.output),
	);
	const cancelled = await listMarkers(barrierDir, "cancelled-");
	const completed = await listMarkers(barrierDir, "completed-");
	const spawned = await listMarkers(barrierDir, "spawned-");
	check(
		"fail-fast: the in-flight sibling was SIGTERMed at failure (not run to completion)",
		cancelled.length === 1 && cancelled[0] === "cancelled-s1" && completed.length === 0,
		`cancelled=${JSON.stringify(cancelled)} completed=${JSON.stringify(completed)}`,
	);
	check(
		"fail-fast: queued items were never started after the failure",
		!spawned.includes("spawned-s2") && !spawned.includes("spawned-s3"),
		`spawned=${JSON.stringify(spawned)}`,
	);
}

async function scenarioSettleUnaffected(url) {
	const { run, barrierDir } = await makeRunner(url, "ff-settle", SETTLE_WORKFLOW);
	const result = await run({
		action: "run",
		name: "ff-settle",
		input: {
			items: [failingItem("f0", 1), { prompt: "[role:ok][id:o1] fine" }, { prompt: "[role:ok][id:o2] fine" }],
		},
		concurrency: 2,
		maxAgents: 8,
		timeoutMs: 60_000,
	});
	check("settle: run succeeds", result?.ok === true, result?.error);
	check(
		"settle: independent branches all ran (1 null of 3)",
		result?.output?.nulls === 1 && result?.output?.total === 3,
		JSON.stringify(result?.output),
	);
	const spawned = await listMarkers(barrierDir, "spawned-");
	check("settle: every item still executed", spawned.length >= 2, JSON.stringify(spawned));
}

async function main() {
	const { url } = await sharedBuildExtension({
		name: "pi-dw-agents-failfast",
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
	await scenarioFailFastCancelsSiblings(url);
	await scenarioSettleUnaffected(url);

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
