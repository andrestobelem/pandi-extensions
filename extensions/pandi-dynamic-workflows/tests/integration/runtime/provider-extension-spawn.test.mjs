/**
 * Issue #86: subagentes con --no-extensions deben re-inyectar la extensión del provider
 * custom (p. ej. claude-bridge) para que el hijo conozca el provider del padre.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-provider-extension-integration" });
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	const theme = { fg: (_color, value) => value };
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		model: { provider: "anthropic", id: "claude-sonnet-4" },
		modelRegistry: { find: () => undefined },
		ui: {
			theme,
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
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-provider-extension", params, new AbortController().signal, undefined, ctx);
}

async function makeProject() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-provider-ext-"));
	const workflows = path.join(dir, ".pi", "workflows");
	await fs.mkdir(workflows, { recursive: true });
	return dir;
}

async function writeWorkflow(project, name, body) {
	const file = path.join(project, ".pi", "workflows", `${name}.js`);
	await fs.writeFile(file, body, "utf8");
	return file;
}

async function scenarioProviderExtensionSpawn(url, outDir) {
	const project = await makeProject();
	const bridgePackage = path.join(outDir, "agentdir", "npm", "node_modules", "pi-claude-bridge");
	const bridgeExt = path.join(bridgePackage, "src", "index.ts");
	await fs.mkdir(path.dirname(bridgeExt), { recursive: true });
	await fs.writeFile(
		path.join(bridgePackage, "package.json"),
		JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }),
		"utf8",
	);
	await fs.writeFile(bridgeExt, "export default function claudeBridgeExtension() {}\n", "utf8");

	await writeWorkflow(
		project,
		"provider-bridge",
		`
module.exports = async function workflow(ctx) {
  await ctx.agent("bridge child", {
    name: "bridge-child",
    model: "claude-bridge/sonnet",
    tools: ["read"],
    cache: false,
  });
  return "ok";
};
`,
	);

	const fakePi = path.join(outDir, "fake-pi-provider.mjs");
	const argvLog = path.join(outDir, "fake-pi-provider-argv.jsonl");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\nimport fs from "node:fs";\nfs.appendFileSync(process.env.PI_FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst prompt = process.argv[process.argv.length - 1] || "";\nconsole.log(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "fake:" + prompt }] } }));\n`,
		{ mode: 0o700 },
	);

	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	const oldArgvLog = process.env.PI_FAKE_ARGV_LOG;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	process.env.PI_FAKE_ARGV_LOG = argvLog;
	try {
		const ext = await freshExtension(url);
		const { pi, tools } = makePi();
		ext(pi);
		const ctx = makeCtx(project);
		const response = await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "provider-bridge",
			maxAgents: 3,
			concurrency: 1,
			timeoutMs: 30_000,
		});
		check(
			"provider extension: workflow succeeds",
			response.details?.result?.ok === true,
			response.details?.result?.error,
		);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
		if (oldArgvLog === undefined) delete process.env.PI_FAKE_ARGV_LOG;
		else process.env.PI_FAKE_ARGV_LOG = oldArgvLog;
	}

	const calls = (await fs.readFile(argvLog, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const valuesFor = (args, flag) =>
		args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : [])).filter(Boolean);
	const spawnCall = calls[0];
	const expectedBridgeExt = await fs.realpath(bridgeExt);

	check(
		"provider extension: child still uses --no-extensions",
		spawnCall.includes("--no-extensions"),
		JSON.stringify(spawnCall),
	);
	check(
		"provider extension: claude-bridge extension is re-injected",
		valuesFor(spawnCall, "--extension").includes(expectedBridgeExt),
		JSON.stringify(spawnCall),
	);
	check(
		"provider extension: qualified model is forwarded verbatim",
		valuesFor(spawnCall, "--model").includes("claude-bridge/sonnet"),
		JSON.stringify(spawnCall),
	);
	check(
		"provider extension: no redundant --provider when model is qualified",
		!spawnCall.includes("--provider"),
		JSON.stringify(spawnCall),
	);
}

async function main() {
	try {
		const { outDir, url } = await buildExtension();
		await scenarioProviderExtensionSpawn(url, outDir);
	} catch (error) {
		check("provider extension suite crashed", false, error instanceof Error ? error.message : String(error));
	}
	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) process.exit(1);
}

main();
