/**
 * Regression: an agent killed by its timeout budget must SAY so, and queue wait
 * must be separated from runtime.
 *
 * Finding (run 2026-07-03T01-36-13 revisar-dw-farley): 3 reviewer agents were
 * SIGTERMed by DEFAULT_AGENT_TIMEOUT_MS (10 min) mid-work (61-89 real turns,
 * 10-18 MB of conversation), but their .md artifacts only said "code: 143" —
 * nothing named the timeout or its budget. Worse, elapsedMs (23-31 min) counts
 * the semaphore QUEUE wait (concurrency 4, 64 agents), so the tell-tale
 * "everyone dies at exactly 10 min" pattern was invisible, and the workflow
 * retried a timed-out agent with the same budget (same failure, doubled cost).
 *
 * This drives a real agent() through the Worker with a fake `pi` that emits one
 * message_end and then hangs forever, under a small timeoutMs. With the fix:
 *  - SubagentResult carries timedOut:true and queuedMs,
 *  - the .md artifact records `- timedOut: true (timeoutMs 1500)` and `- queuedMs: N`,
 * so post-mortems (and workflow scripts deciding whether to retry) can see the
 * harness killed a productive agent.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/agent-timeout-observability.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// One agent with a small explicit timeout; return the fields under test.
const WORKFLOW = [
	"export const meta = { name: 'timeout-obs', description: 'timeout observability', phases: [{ title: 'P' }] };",
	"phase('P');",
	"const [r] = await agents([{ prompt: 'hang forever', name: 'hanger', timeoutMs: 1500, cache: false }], { settle: true });",
	"return { ok: r?.ok ?? null, timedOut: r?.timedOut ?? null, queuedMs: r?.queuedMs ?? null, elapsedMs: r?.elapsedMs ?? null, code: r?.code ?? null };",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-timeout-obs",
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

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-timeout-obs-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "timeout-obs.js"), `${WORKFLOW}\n`, "utf8");

	// Fake `pi`: emit one message_end (the agent IS productive), then hang forever
	// so the harness timeout (1500 ms) SIGTERMs it — the production scenario.
	const event = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "working" }], usage: { input: 1, output: 1 } },
	});
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${event}\n`)});\nsetTimeout(() => {}, 120_000);\n`,
		{ mode: 0o755 },
	);
	return { project, fakePi };
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const { project, fakePi } = await makeProject();
	const { pi, tools } = makePi();
	(ext.activate ?? ext)(pi, makeCtx(project));
	const tool = tools.get("dynamic_workflow");
	const ctx = makeCtx(project);

	const wrapper = path.join(project, "pi-wrapper.sh");
	await fs.writeFile(
		wrapper,
		`#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePi)} "$@"\n`,
		{ mode: 0o755 },
	);
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = wrapper;

	let result;
	let executeError;
	try {
		const res = await tool.execute(
			"tc-timeout-obs",
			{ action: "run", name: "timeout-obs", input: {}, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		result = res?.details?.result;
	} catch (err) {
		executeError = err instanceof Error ? err.message : String(err);
	}
	const out = result?.output;

	check("run completes (settle) despite the timed-out agent", result?.ok === true, executeError ?? result?.error);
	check("SubagentResult.timedOut is true", out?.timedOut === true, JSON.stringify(out));
	check(
		"SubagentResult.elapsedMs includes the timeout budget",
		typeof out?.elapsedMs === "number" && out.elapsedMs >= 1400,
		JSON.stringify(out),
	);
	check(
		"SubagentResult.queuedMs is separated from runtime",
		typeof out?.queuedMs === "number" && out.queuedMs >= 0 && out.queuedMs < out.elapsedMs && out.queuedMs < 1000,
		JSON.stringify(out),
	);
	check("agent failed with the SIGTERM code", out?.ok === false && out?.code === 143, JSON.stringify(out));

	// The .md artifact must name the timeout budget and the queue wait.
	let md = "";
	try {
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		const runs = await fs.readdir(runsDir);
		const agentsDir = path.join(runsDir, runs[0], "agents");
		const mdName = (await fs.readdir(agentsDir)).find((f) => f.endsWith(".md"));
		md = await fs.readFile(path.join(agentsDir, mdName), "utf8");
	} catch {
		// md stays empty; checks fail with evidence
	}
	check(
		"artifact names the timeout and its budget (- timedOut: true (timeoutMs 1500))",
		/- timedOut: true \(timeoutMs 1500\)/.test(md),
		md.split("\n").slice(0, 10).join(" | "),
	);
	const queuedMatch = /^- queuedMs: (\d+)$/m.exec(md);
	check(
		"artifact separates queue wait (- queuedMs: N)",
		queuedMatch !== null,
		md.split("\n").slice(0, 10).join(" | "),
	);
	check("artifact queuedMs remains small", queuedMatch !== null && Number(queuedMatch[1]) < 1000, queuedMatch?.[0]);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
