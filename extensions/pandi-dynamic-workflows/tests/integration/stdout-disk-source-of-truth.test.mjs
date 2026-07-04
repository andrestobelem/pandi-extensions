/**
 * Regression: agent output/schema/metrics must be parsed from the COMPLETE
 * on-disk live stdout artifact, not the bounded in-memory buffer.
 *
 * Finding (run 2026-07-03T01-36-13 revisar-dw-farley): when a subagent's FINAL
 * JSON-mode line (the agent_end replay of all messages) exceeds
 * MAX_JOURNALED_STREAM (200 KB) and ends with "\n", the in-memory tail-trim in
 * runStreamingAgentProcess ({preserveLineBoundary:true}) finds that terminal
 * newline as the "first newline of the tail" and slices past it — leaving
 * result.stdout EMPTY while the full 16 MB conversation sits in the on-disk
 * .stdout.log. Downstream, schema extraction saw "empty output", burned 3
 * schema retries per agent (~20 min of reviewer work each), the script retried
 * whole agents, blew past maxAgents=64, and the run failed. Focus metrics
 * (parsed from the same buffer) reported "0 turns, 0 tok" for a 74-turn agent.
 *
 * This drives a real agent() through the Worker with a fake `pi` binary
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND) that emits a realistic stream: one small
 * message_end (assistant text + usage) followed by ONE giant agent_end line
 * (>200 KB, trailing "\n") carrying the final assistant text — a valid JSON
 * object whose `tail` field is last. With the fix the agent's schema data
 * parses (data.tail === "END") and focus metrics count the message_end turn;
 * before the fix the run fails with "empty output" and metrics report 0 turns.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/stdout-disk-source-of-truth.test.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

// A workflow that asks one agent for a schema'd JSON value and returns its parsed data.
const WORKFLOW = [
	"export const meta = { name: 'stdout-disk', description: 'disk is source of truth', phases: [{ title: 'P' }] };",
	"phase('P');",
	"const schema = { type: 'object', required: ['tail'], properties: { tail: { type: 'string' } } };",
	"const data = await agent('emit giant final line', { schema, schemaRetries: 0, cache: false });",
	"return { data };",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-stdout-disk",
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-stdout-disk-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "stdout-disk.js"), `${WORKFLOW}\n`, "utf8");

	// Fake `pi` binary emitting a realistic JSON-mode stream:
	//  1. a SMALL message_end with assistant text + usage (the focus-metrics turn),
	//  2. ONE GIANT agent_end line (>200_000 chars, trailing "\n") whose messages
	//     carry the final assistant text: a valid JSON object with `tail` LAST so
	//     any truncation drops it (and breaks JSON parse).
	const midEvent = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "working on it" }],
			usage: {
				input: 2,
				output: 54,
				cacheRead: 0,
				cacheWrite: 7414,
				totalTokens: 7470,
				cost: { input: 0.00002, output: 0.0027, cacheRead: 0, cacheWrite: 0.092675, total: 0.095395 },
			},
		},
	});
	const payload = JSON.stringify({ filler: "x".repeat(250_000), tail: "END" });
	const endEvent = JSON.stringify({
		type: "agent_end",
		messages: [
			{ role: "user", content: [{ type: "text", text: "emit giant final line" }] },
			{ role: "assistant", content: [{ type: "text", text: payload }] },
		],
	});
	const stream = `${midEvent}\n${endEvent}\n`;
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(fakePi, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stream)});\n`, {
		mode: 0o755,
	});
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

	// PI_DYNAMIC_WORKFLOWS_PI_COMMAND is passed verbatim to spawn() as the command, so
	// it must be a single executable. Use a wrapper shell script that execs node + fake-pi.
	const wrapper = path.join(project, "pi-wrapper.sh");
	await fs.writeFile(
		wrapper,
		`#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePi)} "$@"\n`,
		{ mode: 0o755 },
	);
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = wrapper;

	// Pre-fix the run FAILS (schema sees "empty output") and execute throws;
	// catch it so the checks report evidence instead of crashing the suite.
	let result;
	let executeError;
	try {
		const res = await tool.execute(
			"tc-stdout-disk",
			{ action: "run", name: "stdout-disk", input: {}, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			ctx,
		);
		result = res?.details?.result;
	} catch (err) {
		executeError = err instanceof Error ? err.message : String(err);
	}
	const data = result?.output?.data;

	check("run succeeds despite >200KB final agent_end line", result?.ok === true, executeError ?? result?.error);
	check(
		"schema validated against the COMPLETE on-disk stream (data.tail === 'END')",
		data != null && data.tail === "END",
		JSON.stringify({ data: data == null ? data : { tail: data.tail, fillerLen: (data.filler || "").length } }),
	);

	// Focus metrics must be folded from the complete stream too: the small
	// message_end (with usage) precedes the giant line, so turns/output tokens
	// are only visible when parsing goes beyond the in-memory tail.
	let agentMetrics;
	try {
		const runsDir = path.join(project, ".pi", "workflows", "runs");
		const runs = await fs.readdir(runsDir);
		const metrics = JSON.parse(await fs.readFile(path.join(runsDir, runs[0], "metrics.json"), "utf8"));
		agentMetrics = metrics?.agents?.[0];
	} catch {
		// leave agentMetrics undefined; checks below fail with evidence
	}
	check(
		"focus metrics count the message_end turn (turns === 1)",
		agentMetrics?.turns === 1,
		JSON.stringify(agentMetrics ?? null),
	);
	check(
		"focus metrics sum output tokens from the full stream (out === 54)",
		agentMetrics?.outputTokensTotal === 54,
		JSON.stringify(agentMetrics ?? null),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
