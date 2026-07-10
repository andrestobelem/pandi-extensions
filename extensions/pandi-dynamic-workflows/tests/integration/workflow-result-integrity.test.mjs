#!/usr/bin/env node
/**
 * workflow-result-integrity — pin #77: empty and truncated agent outputs must be
 * explicit in runtime state, run views, and generated reports.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

const LARGE_OUTPUT = "L".repeat(30_000);
const WORKFLOW = [
	"export const meta = { name: 'result-integrity', description: 'empty/truncated output observability' };",
	"const [normal, empty, large] = await agents([",
	"  { prompt: 'NORMAL_OUTPUT', name: 'normal-output', cache: false },",
	"  { prompt: 'EMPTY_OUTPUT', name: 'empty-output', cache: false },",
	"  { prompt: 'LARGE_OUTPUT', name: 'large-output', cache: false },",
	"], { settle: true, concurrency: 3 });",
	"return {",
	"  normal: normal && { output: normal.output, outputEmpty: normal.outputEmpty, outputChars: normal.outputChars, outputTruncated: normal.outputTruncated },",
	"  empty: empty && { output: empty.output, outputEmpty: empty.outputEmpty, outputChars: empty.outputChars, outputTruncated: empty.outputTruncated },",
	"  large: large && { output: large.output, outputEmpty: large.outputEmpty, outputChars: large.outputChars, outputTruncated: large.outputTruncated },",
	"};",
].join("\n");

async function buildModule(src, outName, name) {
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
			sanitizeHtml: "export default function sanitizeHtml(html) { return String(html); }\n",
		},
	});
	return await import(url);
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-result-integrity-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "result-integrity.js"), `${WORKFLOW}\n`, "utf8");
	const fakePi = path.join(project, "fake-pi.mjs");
	const script = `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || "";
if (prompt.includes("EMPTY_OUTPUT")) process.exit(0);
const text = prompt.includes("LARGE_OUTPUT") ? ${JSON.stringify(LARGE_OUTPUT)} : "normal result";
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1 } } }) + "\\n");
`;
	await fs.writeFile(fakePi, script, { mode: 0o755 });
	return { project, fakePi };
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function main() {
	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	let project;
	try {
		const mod = await buildModule("index.ts", "dynamic-workflows.mjs", "workflow-result-integrity-index");
		const collector = await buildModule(
			"observe/collector.ts",
			"run-report-collector.mjs",
			"workflow-result-integrity-collector",
		);
		const reportHtml = await buildModule(
			"observe/html.ts",
			"run-report-html.mjs",
			"workflow-result-integrity-report-html",
		);
		const runView = await buildModule("tui/run-view.ts", "run-view.mjs", "workflow-result-integrity-run-view");
		const made = await makeProject();
		project = made.project;
		process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = made.fakePi;
		const { pi, tools } = makePi();
		(mod.default.activate ?? mod.default)(pi, makeCtx(project));
		const tool = tools.get("dynamic_workflow");
		check("tool registered", !!tool);
		const res = await tool.execute(
			"tc-result-integrity",
			{ action: "run", name: "result-integrity", input: {}, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		);
		const result = res?.details?.result;
		check("workflow succeeds", result?.ok === true, result?.error);
		const runDir = result?.runDir;
		const out = result?.output;
		check("empty SubagentResult keeps an empty output string", out?.empty?.output === "", JSON.stringify(out?.empty));
		check("empty SubagentResult marks outputEmpty", out?.empty?.outputEmpty === true, JSON.stringify(out?.empty));
		check("empty SubagentResult records zero outputChars", out?.empty?.outputChars === 0, JSON.stringify(out?.empty));
		check(
			"large SubagentResult marks outputTruncated",
			out?.large?.outputTruncated === true,
			JSON.stringify(out?.large),
		);
		check(
			"large SubagentResult records full outputChars",
			out?.large?.outputChars === LARGE_OUTPUT.length,
			JSON.stringify(out?.large),
		);

		const status = await readJson(path.join(runDir, "status.json"));
		const persisted = await readJson(path.join(runDir, "result.json"));
		for (const [label, record] of [
			["status", status],
			["result", persisted],
		]) {
			const summary = record.integrity?.agentOutputs;
			check(`${label}: integrity counts observed agents`, summary?.observed === 3, JSON.stringify(record.integrity));
			check(`${label}: integrity counts empty output`, summary?.empty === 1, JSON.stringify(record.integrity));
			check(
				`${label}: integrity counts truncated output`,
				summary?.truncated === 1,
				JSON.stringify(record.integrity),
			);
		}

		const parsed = await mod.readRunEvents(runDir);
		const emptyAgent = parsed.agents.find((a) => a.name === "empty-output");
		const largeAgent = parsed.agents.find((a) => a.name === "large-output");
		check("parser preserves empty output string", emptyAgent?.output === "", JSON.stringify(emptyAgent));
		check("parser preserves outputEmpty", emptyAgent?.outputEmpty === true, JSON.stringify(emptyAgent));
		check("parser preserves outputTruncated", largeAgent?.outputTruncated === true, JSON.stringify(largeAgent));

		const report = await collector.collectRunReport(runDir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		const reportEmpty = report.agents.find((a) => a.name === "empty-output");
		const reportLarge = report.agents.find((a) => a.name === "large-output");
		check("collector includes empty output block", reportEmpty?.output?.text === "", JSON.stringify(reportEmpty));
		check("collector exposes outputEmpty", reportEmpty?.outputEmpty === true, JSON.stringify(reportEmpty));
		check("collector exposes outputTruncated", reportLarge?.outputTruncated === true, JSON.stringify(reportLarge));

		const html = reportHtml.buildRunReportHtml(report);
		check("report HTML surfaces empty output", /output:empty|empty output/i.test(html), html.slice(0, 1000));
		check(
			"report HTML surfaces truncated output",
			/output:truncated|truncated output/i.test(html),
			html.slice(0, 1000),
		);

		const view = await runView.formatRunView(status);
		check("run view surfaces empty output", view.includes("output:empty"), view);
		check("run view surfaces truncated output", view.includes("output:truncated"), view);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
		if (project) await fs.rm(project, { recursive: true, force: true });
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
