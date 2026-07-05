#!/usr/bin/env node
/**
 * run-dir additive fields — pins #31 (G1-G4) as backwards-compatible runtime data.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const LONG_PROMPT_SENTINEL = `PROMPT-SENTINEL-${"x".repeat(20_000)}`;
const WORKFLOW = [
	"export const meta = { name: 'additive-fields', description: 'G1-G4 smoke' };",
	"phase('Scout');",
	"const out = await agent(args.prompt, { name: 'field-agent', tools: ['read'] });",
	"return { out };",
].join("\n");

async function buildExtension(src, outName, name) {
	const { url } = await sharedBuildExtension({
		name,
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", src),
		outName,
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
	return import(url);
}

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
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-additive-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "additive.js"), `${WORKFLOW}\n`, "utf8");
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\n` +
			`process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "agent ok" }] } }) + "\\n");\n` +
			`process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "agent ok" }], usage: { input: 123, output: 7, totalTokens: 130, cacheRead: 5, cacheWrite: 0, cost: { total: 0.0042 } } } }) + "\\n");\n`,
		"utf8",
	);
	await fs.chmod(fakePi, 0o755);
	return { project, fakePi };
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function main() {
	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	try {
		const mod = await buildExtension("index.ts", "dynamic-workflows.mjs", "run-dir-additive-index");
		const collector = await buildExtension(
			"run-report-collector.ts",
			"run-report-collector.mjs",
			"run-dir-additive-collector",
		);
		const { project, fakePi } = await makeProject();
		process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
		const { pi, tools } = makePi();
		(mod.default.activate ?? mod.default)(pi, makeCtx(project));
		const tool = tools.get("dynamic_workflow");
		const res = await tool.execute(
			"tc-additive",
			{ action: "run", name: "additive", input: { prompt: LONG_PROMPT_SENTINEL }, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		);
		const result = res?.details?.result;
		check("workflow run succeeds", result?.ok === true, result?.error);
		const runDir = result?.runDir;
		const events = runDir ? await readEvents(runDir) : [];
		const phaseEvent = events.find((e) => e.type === "phase" && e.label === "Scout");
		check(
			"G1: structured phase event persisted",
			!!phaseEvent,
			JSON.stringify(events.filter((e) => e.type === "phase")),
		);
		check("G1: phase event has id/time", typeof phaseEvent?.id === "number" && typeof phaseEvent?.time === "string");

		const agentEnd = events.find((e) => e.type === "agent" && e.name === "field-agent" && e.state !== "running");
		check("agent completion event found", !!agentEnd, JSON.stringify(events.filter((e) => e.type === "agent")));
		check("G2: completion event has bounded promptCopy", typeof agentEnd?.promptCopy === "string");
		check("G2: promptCopy is bounded", (agentEnd?.promptCopy ?? "").length <= 16_000);
		check("G2: promptTruncated flag set", agentEnd?.promptTruncated === true, JSON.stringify(agentEnd));
		check(
			"G4: completion event has focus metrics",
			agentEnd?.metrics?.inputTokensPeak === 128,
			JSON.stringify(agentEnd?.metrics),
		);
		check(
			"G4: completion event has cost",
			agentEnd?.metrics?.costTotal === 0.0042,
			JSON.stringify(agentEnd?.metrics),
		);

		for (const file of ["workflow-source.js", "workflow-transformed.cjs", "workflow-graph.json"]) {
			let exists = false;
			try {
				await fs.stat(path.join(runDir, file));
				exists = true;
			} catch {
				exists = false;
			}
			check(`G3: ${file} snapshot exists`, exists);
		}
		let graph = null;
		try {
			graph = JSON.parse(await fs.readFile(path.join(runDir, "workflow-graph.json"), "utf8"));
		} catch {
			graph = null;
		}
		check("G3: graph snapshot names workflow", graph?.workflow?.name === "additive", JSON.stringify(graph?.workflow));

		await fs.rm(path.join(runDir, "metrics.json"), { force: true });
		const report = await collector.collectRunReport(runDir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		check(
			"report uses structured phase",
			report.phases.some((p) => p.label === "Scout" && p.source === "event"),
			JSON.stringify(report.phases),
		);
		const reportAgent = report.agents.find((a) => a.name === "field-agent");
		check(
			"report uses event prompt copy",
			reportAgent?.prompt?.text === agentEnd?.promptCopy,
			JSON.stringify(reportAgent?.prompt),
		);
		check(
			"report uses event metrics fallback",
			reportAgent?.metrics?.inputTokensPeak === 128,
			JSON.stringify(reportAgent?.metrics),
		);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
	}

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
