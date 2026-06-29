/**
 * Regression: agent({schema}) must validate the FULL agent output, not the
 * display-truncated copy.
 *
 * Finding: runSubagent truncated the parsed output to MAX_AGENT_OUTPUT_IN_RESULT
 * (24000 chars) BEFORE running extractJsonCandidate/validateStructuredData. A
 * long-but-valid JSON payload was therefore cut mid-value, extraction failed,
 * and the schema-retry prompt misattributed the failure to a schema mismatch.
 *
 * This drives a real agent() through the Worker with a fake `pi` binary
 * (PI_DYNAMIC_WORKFLOWS_PI_COMMAND) that emits a single JSON-mode `turn_end`
 * event whose assistant text is one valid JSON object exceeding 24000 chars.
 * With the fix the agent returns the parsed object (data.tail === "END");
 * before the fix the truncated JSON did not parse and data was null.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/schema-untruncated-output.test.mjs
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
	"export const meta = { name: 'schema-trunc', description: 'schema on long output', phases: [{ title: 'P' }] };",
	"phase('P');",
	"const schema = { type: 'object', required: ['tail'], properties: { tail: { type: 'string' } } };",
	"const data = await agent('emit big json', { schema, schemaRetries: 0, cache: false });",
	"return { data };",
].join("\n");

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dw-schema-trunc",
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-schema-trunc-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(path.join(project, ".pi", "workflows", "schema-trunc.js"), `${WORKFLOW}\n`, "utf8");

	// Fake `pi` binary: emit ONE JSON-mode turn_end event whose assistant text is a
	// single valid JSON object well past 24000 chars, with `tail` as the LAST field
	// so any truncation drops it (and breaks JSON parse).
	const filler = "x".repeat(40_000);
	const payload = JSON.stringify({ filler, tail: "END" });
	const event = JSON.stringify({
		type: "turn_end",
		message: { role: "assistant", content: [{ type: "text", text: payload }] },
	});
	const fakePi = path.join(project, "fake-pi.mjs");
	await fs.writeFile(fakePi, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${event}\n`)});\n`, {
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

	const res = await tool.execute(
		"tc-schema-trunc",
		{ action: "run", name: "schema-trunc", input: {}, timeoutMs: 30_000 },
		new AbortController().signal,
		undefined,
		ctx,
	);
	const result = res?.details?.result;
	const data = result?.output?.data;

	check("run succeeds", result?.ok === true, result?.error);
	check(
		"schema validated against UNTRUNCATED output (data.tail === 'END')",
		data != null && data.tail === "END",
		JSON.stringify({ data: data == null ? data : { tail: data.tail, fillerLen: (data.filler || "").length } }),
	);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main();
