/**
 * Durable behavioral integration test for ctx.workflow() composition in extensions/pi-dynamic-workflows/index.ts.
 *
 * This pins the observable runtime contract for sub-workflows:
 *   - ctx.workflow(name, input) returns the child workflow output inside the same run.
 *   - The child shares runId/runDir/limits and emits workflow start/end events.
 *   - Depth is capped at 1 (a sub-workflow cannot call another sub-workflow).
 *   - The agent budget is shared across parent + child.
 *   - Resume cache keys are namespaced by sub-workflow code, so changing the child code
 *     re-executes child cached calls without re-running unchanged parent calls.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/dynamic-workflow-composition.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		failures.push(label + (detail ? `  [${detail}]` : ""));
		console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
	}
}

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-integration-"));

	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n",
	);
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} input() {} render() { return []; } }\n`,
	);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(
		tuiStub,
		`export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`,
	);

	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:typebox/value=${typeboxValueStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--alias:@earendil-works/pi-ai=${aiStub}`,
			`--alias:@earendil-works/pi-tui=${tuiStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi(execImpl = async () => ({ code: 0, killed: false, stdout: "", stderr: "" })) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const execCalls = [];
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
		getThinkingLevel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return execImpl(cmd, args, opts, execCalls.length);
		},
	};
	return { pi, tools, commands, handlers, shortcuts, execCalls };
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
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function writeWorkflow(project, relativeName, code) {
	const file = path.join(project, ".pi", "workflows", relativeName.endsWith(".js") ? relativeName : `${relativeName}.js`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, code, "utf8");
	return file;
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
}

async function scenarioComposition(url) {
	const project = await makeProject();
	await writeWorkflow(project, "parent", `
module.exports = async function workflow(ctx, input) {
  await ctx.log("parent before child");
  const parent = { runId: ctx.runId, runDir: ctx.runDir, maxAgents: ctx.limits.maxAgents, input: ctx.input };
  const child = await ctx.workflow("lib/child", { value: input.value, parentRunId: ctx.runId, parentRunDir: ctx.runDir, maxAgents: ctx.limits.maxAgents });
  await ctx.writeArtifact("parent-after.json", { childRunId: child.runId });
  return { parent, child };
};
`);
	await writeWorkflow(project, "lib/child", `
module.exports = async function workflow(ctx, input) {
  await ctx.log("child running", input);
  await ctx.writeArtifact("child-output.json", { runId: ctx.runId, runDir: ctx.runDir, input: ctx.input });
  return { runId: ctx.runId, runDir: ctx.runDir, input: ctx.input, maxAgents: ctx.limits.maxAgents };
};
`);

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const response = await runTool(tools.get("dynamic_workflow"), ctx, {
		action: "run",
		name: "parent",
		input: { value: "from-parent" },
		maxAgents: 7,
		concurrency: 2,
		timeoutMs: 30_000,
	});
	const result = response.details.result;
	check("composition: parent run succeeds", result.ok === true, result.error);
	check("composition: child receives input", result.output.child.input.value === "from-parent", JSON.stringify(result.output));
	check("composition: child shares runId", result.output.parent.runId === result.output.child.runId, JSON.stringify(result.output));
	check("composition: child shares runDir", result.runDir === result.output.child.runDir, JSON.stringify(result.output));
	check("composition: child sees parent limits", result.output.child.maxAgents === 7, JSON.stringify(result.output.child));

	const childArtifact = await readJson(path.join(result.runDir, "child-output.json"));
	check("composition: child artifact lands in parent runDir", childArtifact.runDir === result.runDir, JSON.stringify(childArtifact));
	const events = await readEvents(result.runDir);
	check("composition: emits workflow start event", events.some((e) => e.type === "workflow" && e.phase === "start" && e.name === "lib/child"));
	check("composition: emits workflow end event", events.some((e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/child" && e.ok === true));
}

async function scenarioDepthLimit(url) {
	const project = await makeProject();
	await writeWorkflow(project, "parent-depth", `
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/nesting-child", {});
};
`);
	await writeWorkflow(project, "lib/nesting-child", `
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/grandchild", {});
};
`);
	await writeWorkflow(project, "lib/grandchild", "module.exports = async () => 'should-not-run';\n");

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	let message = "";
	try {
		await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "parent-depth", timeoutMs: 30_000 });
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	check("composition: nested ctx.workflow is rejected", /depth limit is 1|sub-workflows cannot call/i.test(message), message);
}

async function scenarioSharedAgentBudget(url, outDir) {
	const project = await makeProject();
	await writeWorkflow(project, "parent-agent-limit", `
module.exports = async function workflow(ctx) {
  const child = await ctx.workflow("lib/agent-child", {});
  const parent = await ctx.agent("parent after child", { name: "parent-agent", cache: false, includeSkills: false, includeExtensions: false });
  return { child, parent: parent.output };
};
`);
	await writeWorkflow(project, "lib/agent-child", `
module.exports = async function workflow(ctx) {
  const child = await ctx.agent("child one", { name: "child-agent", cache: false, includeSkills: false, includeExtensions: false });
  return { output: child.output };
};
`);
	const fakePi = path.join(outDir, "fake-pi-agent.mjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\nconst prompt = process.argv[process.argv.length - 1] || "";\nconsole.log(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "fake:" + prompt }] } }));\n`,
		{ mode: 0o700 },
	);

	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		const ext = await freshExtension(url);
		const { pi, tools } = makePi();
		ext(pi);
		const ctx = makeCtx(project);
		let message = "";
		try {
			await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "parent-agent-limit", maxAgents: 1, concurrency: 1, timeoutMs: 30_000 });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		check("composition: parent+child share maxAgents budget", /maxAgents=1/.test(message), message);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
	}
}

async function scenarioDefaultAgentAccess(url, outDir) {
	const project = await makeProject();
	const webSearchPackage = path.join(outDir, "agentdir", "npm", "node_modules", "pi-codex-web-search");
	const webSearchExt = path.join(webSearchPackage, "src", "index.ts");
	await fs.mkdir(path.dirname(webSearchExt), { recursive: true });
	await fs.writeFile(path.join(webSearchPackage, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }), "utf8");
	await fs.writeFile(webSearchExt, "export default function webSearchExtension() {}\n", "utf8");

	const context7Skill = path.join(project, ".agents", "skills", "context7-cli");
	await fs.mkdir(context7Skill, { recursive: true });
	await fs.writeFile(path.join(context7Skill, "SKILL.md"), "---\nname: context7-cli\ndescription: Test Context7 skill.\n---\n", "utf8");

	await writeWorkflow(project, "agent-access", `
module.exports = async function workflow(ctx) {
  await ctx.agent("default explicit tools", { name: "default-access", tools: ["read", "grep"], cache: false });
  await ctx.agent("explicit skill", { name: "explicit-skill", tools: ["read"], skills: ["./local-skill"], cache: false });
  await ctx.agent("opt out", { name: "opt-out", tools: ["read"], includeExtensions: false, includeSkills: false, cache: false });
  return "ok";
};
`);

	const fakePi = path.join(outDir, "fake-pi-access.mjs");
	const argvLog = path.join(outDir, "fake-pi-access-argv.jsonl");
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
		const response = await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "agent-access", maxAgents: 5, concurrency: 1, timeoutMs: 30_000 });
		check("agent access: workflow succeeds", response.details.result.ok === true, response.details.result.error);
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
		if (oldArgvLog === undefined) delete process.env.PI_FAKE_ARGV_LOG;
		else process.env.PI_FAKE_ARGV_LOG = oldArgvLog;
	}

	const calls = (await fs.readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const valuesFor = (args, flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []).filter(Boolean);
	const toolsFor = (args) => (valuesFor(args, "--tools")[0] || "").split(",").filter(Boolean);
	const defaultCall = calls[0];
	const explicitSkillCall = calls[1];
	const optOutCall = calls[2];
	const expectedWebSearchExt = await fs.realpath(webSearchExt);
	const expectedContext7Skill = await fs.realpath(context7Skill);

	check("agent access: default explicit tool allowlist gains web_search", toolsFor(defaultCall).includes("web_search"), JSON.stringify(defaultCall));
	check("agent access: default web_search extension is loaded explicitly", valuesFor(defaultCall, "--extension").includes(expectedWebSearchExt), JSON.stringify(defaultCall));
	check("agent access: default skill discovery stays enabled", !defaultCall.includes("--no-skills"), JSON.stringify(defaultCall));
	check("agent access: explicit skills also get context7", valuesFor(explicitSkillCall, "--skill").includes(expectedContext7Skill), JSON.stringify(explicitSkillCall));
	check("agent access: explicit skills keep explicit-only semantics", explicitSkillCall.includes("--no-skills"), JSON.stringify(explicitSkillCall));
	check("agent access: includeExtensions false opts out of web_search default", !toolsFor(optOutCall).includes("web_search") && valuesFor(optOutCall, "--extension").length === 0, JSON.stringify(optOutCall));
	check("agent access: includeSkills false opts out of skill defaults", optOutCall.includes("--no-skills") && valuesFor(optOutCall, "--skill").length === 0, JSON.stringify(optOutCall));
}

async function scenarioAgentStructuredOutputSurvivesTruncatedJsonEventStream(url, outDir) {
	const project = await makeProject();
	await writeWorkflow(project, "agent-truncated-json", `
module.exports = async function workflow(ctx) {
  const result = await ctx.agent("return the required structured object", {
    name: "truncated-json-agent",
    cache: false,
    includeSkills: false,
    includeExtensions: false,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "value"],
      properties: {
        ok: { type: "boolean" },
        value: { type: "string" },
      },
    },
  });
  return { output: result.output, data: result.data, schemaOk: result.schemaOk };
};
`);

	const expected = { ok: true, value: "kept" };
	const fakePi = path.join(outDir, "fake-pi-truncated-json.mjs");
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node\nconst huge = "x".repeat(210_000);\nconst expected = ${JSON.stringify(JSON.stringify(expected))};\nprocess.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: huge }] } }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: expected }] } }) + "\\n");\n`,
		{ mode: 0o700 },
	);

	const oldCommand = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		const ext = await freshExtension(url);
		const { pi, tools } = makePi();
		ext(pi);
		const ctx = makeCtx(project);
		const response = await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "agent-truncated-json", maxAgents: 1, concurrency: 1, timeoutMs: 30_000 });
		const result = response.details.result;
		check("agent JSON: workflow succeeds with truncated event stream", result.ok === true, result.error);
		check("agent JSON: parsed output is final assistant text", result.output.output === JSON.stringify(expected), JSON.stringify(result.output));
		check("agent JSON: structured data comes from assistant text", result.output.schemaOk === true && result.output.data?.ok === true && result.output.data?.value === "kept", JSON.stringify(result.output));
	} finally {
		if (oldCommand === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = oldCommand;
	}
}

async function scenarioGeneratedDraftLocation(url, outDir) {
	const project = await makeProject();
	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const code = "module.exports = async function workflow(ctx, input) { await ctx.writeArtifact('draft.json', input); return { ok: true, input }; };\n";
	const write = await runTool(tools.get("dynamic_workflow"), ctx, { action: "write", name: "location-check", code });
	const workflow = write.details.workflow;
	const expected = path.join(project, ".pi", "workflows", "drafts", "location-check.js");
	const oldGeneratedPath = path.join(project, ".pi", "workflows", "generated", "location-check.js");
	check("workflow drafts: written next to workflows/runs", workflow.path === expected, JSON.stringify(workflow));
	check("workflow drafts: file exists in workflows/drafts", existsSync(expected), expected);
	check("workflow drafts: old workflows/generated path is not used", !existsSync(oldGeneratedPath), oldGeneratedPath);

	const run = (await runTool(tools.get("dynamic_workflow"), ctx, {
		action: "run",
		name: "location-check",
		input: { value: 42 },
		timeoutMs: 30_000,
	})).details.result;
	check("workflow drafts: run resolves from workflows/drafts", run.ok === true && run.output.input.value === 42, JSON.stringify(run.output));

	const globalDraftDir = path.join(outDir, "agentdir", "workflows", "drafts");
	await fs.mkdir(globalDraftDir, { recursive: true });
	await fs.writeFile(path.join(globalDraftDir, "global-location.js"), "module.exports = async () => ({ global: true });\n", "utf8");
	const globalDraftRun = (await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "global-location", timeoutMs: 30_000 })).details.result;
	check("workflow drafts: global .pi fallback resolves drafts", globalDraftRun.ok === true && globalDraftRun.output.global === true, JSON.stringify(globalDraftRun.output));

	const globalRunId = "2000-01-01T00-00-00-000Z-global-fallback-00000000";
	const projectHash = crypto.createHash("sha1").update(project).digest("hex").slice(0, 12);
	const globalRunDir = path.join(outDir, "agentdir", "workflows", "runs", projectHash, globalRunId);
	await fs.mkdir(globalRunDir, { recursive: true });
	await fs.writeFile(path.join(globalRunDir, "result.json"), JSON.stringify({
		ok: true,
		state: "completed",
		runId: globalRunId,
		runDir: globalRunDir,
		workflow: "global-fallback",
		scope: "global",
		startedAt: new Date(0).toISOString(),
		endedAt: new Date(1).toISOString(),
		elapsedMs: 1,
		logs: [],
		agentCount: 0,
		peakParallelAgents: 0,
		output: "global",
	}, null, 2), "utf8");
	const runs = (await runTool(tools.get("dynamic_workflow"), ctx, { action: "runs" })).details.runs;
	check("workflow runs: global .pi fallback lists runs", runs.some((entry) => entry.runId === globalRunId), runs.map((entry) => entry.runId).join(","));

	let generatedPrefixMessage = "";
	try {
		await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "generated/location-check", timeoutMs: 30_000 });
	} catch (err) {
		generatedPrefixMessage = err instanceof Error ? err.message : String(err);
	}
	check("workflow drafts: generated/<name> prefix is rejected", /Workflow not found: generated\/location-check/.test(generatedPrefixMessage), generatedPrefixMessage);
}

async function scenarioChildCodeHashNamespacesResumeCache(url) {
	const project = await makeProject();
	await writeWorkflow(project, "parent-cache", `
module.exports = async function workflow(ctx) {
  const parent = await ctx.bash("printf shared-cache", { cache: true });
  const child = await ctx.workflow("lib/cache-child", {});
  return { parent: parent.stdout, child };
};
`);
	await writeWorkflow(project, "lib/cache-child", `
module.exports = async function workflow(ctx) {
  const child = await ctx.bash("printf shared-cache", { cache: true });
  return { version: "v1", stdout: child.stdout };
};
`);

	let execCount = 0;
	const ext = await freshExtension(url);
	const { pi, tools } = makePi(async (_cmd, args) => {
		execCount += 1;
		return { code: 0, killed: false, stdout: `exec-${execCount}:${args[1]}`, stderr: "" };
	});
	ext(pi);
	const ctx = makeCtx(project);
	const first = (await runTool(tools.get("dynamic_workflow"), ctx, { action: "run", name: "parent-cache", timeoutMs: 30_000 })).details.result;
	check("composition cache: first run executes parent + child bash", execCount === 2, `execCount=${execCount}`);
	check("composition cache: first child version is v1", first.output.child.version === "v1", JSON.stringify(first.output));

	await writeWorkflow(project, "lib/cache-child", `
module.exports = async function workflow(ctx) {
  const child = await ctx.bash("printf shared-cache", { cache: true });
  return { version: "v2", stdout: child.stdout };
};
`);
	const resumed = (await runTool(tools.get("dynamic_workflow"), ctx, { action: "resume", name: first.runId, force: true })).details.result;
	check("composition cache: unchanged parent bash is cached on resume", resumed.output.parent === first.output.parent, JSON.stringify(resumed.output));
	check("composition cache: changed child code re-executes child bash", execCount === 3, `execCount=${execCount}, output=${JSON.stringify(resumed.output)}`);
	check("composition cache: resumed child uses new code", resumed.output.child.version === "v2", JSON.stringify(resumed.output));
	check("composition cache: reports cached parent call", resumed.cachedCalls === 1, `cachedCalls=${resumed.cachedCalls}`);
}

async function main() {
	try {
		const { outDir, url } = await buildExtension();
		await scenarioComposition(url);
		await scenarioDepthLimit(url);
		await scenarioSharedAgentBudget(url, outDir);
		await scenarioDefaultAgentAccess(url, outDir);
		await scenarioAgentStructuredOutputSurvivesTruncatedJsonEventStream(url, outDir);
		await scenarioGeneratedDraftLocation(url, outDir);
		await scenarioChildCodeHashNamespacesResumeCache(url);
		console.log(`\n${passed} passed, ${failed} failed`);
		if (failed) {
			console.log(failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
