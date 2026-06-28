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
import { buildExtension as sharedBuildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-integration",
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

// F4: a child that ignores SIGTERM must be escalated to SIGKILL so the process runners can't
// hang forever (and, for the streaming runner, never release the agent semaphore).
const SIGTERM_IGNORING_CHILD = "process.on('SIGTERM', () => {}); const t = setInterval(() => {}, 1e9); setTimeout(() => { clearInterval(t); process.exit(0); }, 30000);";

async function scenarioRunProcessSigkillEscalation(url) {
	const mod = await import(`${url}?p=${instance++}`);
	check("runProcess: exported", typeof mod.runProcess === "function", typeof mod.runProcess);
	if (typeof mod.runProcess !== "function") return;
	const TIMED_OUT = Symbol("guard");
	const guard = new Promise((res) => setTimeout(() => res(TIMED_OUT), 6000));
	const run = mod.runProcess("node", ["-e", SIGTERM_IGNORING_CHILD], { cwd: REPO_ROOT, timeoutMs: 200, killGraceMs: 200 });
	const result = await Promise.race([run, guard]);
	check("runProcess: SIGTERM-ignoring child is force-killed so the promise resolves (no hang)", result !== TIMED_OUT, "did not resolve within 6s");
	if (result !== TIMED_OUT) check("runProcess: reports timedOut", result.timedOut === true, JSON.stringify(result));
}

async function scenarioStreamingSigkillEscalation(url) {
	const mod = await import(`${url}?s=${instance++}`);
	check("runStreamingAgentProcess: exported", typeof mod.runStreamingAgentProcess === "function", typeof mod.runStreamingAgentProcess);
	if (typeof mod.runStreamingAgentProcess !== "function") return;
	const TIMED_OUT = Symbol("guard");
	const guard = new Promise((res) => setTimeout(() => res(TIMED_OUT), 6000));
	const run = mod.runStreamingAgentProcess("node", ["-e", SIGTERM_IGNORING_CHILD], { cwd: REPO_ROOT, timeoutMs: 200, killGraceMs: 200, signal: new AbortController().signal });
	const result = await Promise.race([run, guard]);
	check("runStreamingAgentProcess: SIGTERM-ignoring child is force-killed so the promise resolves (no hang)", result !== TIMED_OUT, "did not resolve within 6s");
	if (result !== TIMED_OUT) check("runStreamingAgentProcess: reports killed", result.killed === true, JSON.stringify(result));
}

// F27: settleWithinTimeout must clear its timeout timer so a fast-settling promise (e.g. all
// active runs aborting quickly at session shutdown) cannot keep the event loop alive ~3s.
async function scenarioShutdownTimerNoLeak(url) {
	const mod = await import(`${url}?st=${instance++}`);
	check("shutdown: settleWithinTimeout exported", typeof mod.settleWithinTimeout === "function", typeof mod.settleWithinTimeout);
	if (typeof mod.settleWithinTimeout !== "function") return;
	// Real exit-timing check in a fresh process: with a fast promise vs a 3s timeout, the child
	// must exit promptly. A leaked (uncleared) timer would hold the loop ~3s.
	const childScript = `import(${JSON.stringify(url)}).then(async (m) => { await m.settleWithinTimeout(Promise.resolve("x"), 3000); process.stdout.write("SETTLED"); });`;
	const start = Date.now();
	const r = spawnSync("node", ["--input-type=module", "-e", childScript], { encoding: "utf8", timeout: 10000 });
	const elapsed = Date.now() - start;
	check(
		"shutdown: settleWithinTimeout clears its timer (child exits promptly, no ~3s hang)",
		r.status === 0 && /SETTLED/.test(r.stdout || "") && elapsed < 2000,
		`status=${r.status} elapsed=${elapsed}ms out=${JSON.stringify(r.stdout)} err=${JSON.stringify((r.stderr || "").slice(0, 200))}`,
	);
}

// F42: the per-file append mutex map must not grow unboundedly; entries are purged once no
// writer is using a path, without breaking mutual exclusion for concurrent writers.
async function scenarioAppendMutexPurge(url) {
	const mod = await import(`${url}?am=${instance++}`);
	check("append: appendJsonLine exported", typeof mod.appendJsonLine === "function", typeof mod.appendJsonLine);
	check("append: appendFileMutexCount exported", typeof mod.appendFileMutexCount === "function", typeof mod.appendFileMutexCount);
	if (typeof mod.appendJsonLine !== "function" || typeof mod.appendFileMutexCount !== "function") return;
	const tmp = path.join(os.tmpdir(), `dwf-append-${process.pid}-${instance++}.jsonl`);
	try {
		await mod.appendJsonLine(tmp, { a: 1 });
		check("append: mutex map purged after a single write", mod.appendFileMutexCount() === 0, String(mod.appendFileMutexCount()));
		await Promise.all([mod.appendJsonLine(tmp, { b: 2 }), mod.appendJsonLine(tmp, { c: 3 }), mod.appendJsonLine(tmp, { d: 4 })]);
		check("append: mutex map purged after concurrent writes", mod.appendFileMutexCount() === 0, String(mod.appendFileMutexCount()));
		const lines = (await fs.readFile(tmp, "utf8")).trim().split("\n").filter(Boolean);
		const allValid = lines.length === 4 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
		check("append: concurrent writes stay serialized (4 intact JSON lines)", allValid, `lines=${lines.length}`);
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

// F49: extractUltracodeTask must accept a `:`/`-` separator with or without a following space
// (e.g. `ultracode:do X`), not only a whitespace separator.
async function scenarioUltracodeTaskParsing(url) {
	const mod = await import(`${url}?uc=${instance++}`);
	check("ultracode: extractUltracodeTask exported", typeof mod.extractUltracodeTask === "function", typeof mod.extractUltracodeTask);
	if (typeof mod.extractUltracodeTask !== "function") return;
	const ex = mod.extractUltracodeTask;
	check("ultracode: 'ultracode:do X' parses task without a space", ex("ultracode:do X") === "do X", JSON.stringify(ex("ultracode:do X")));
	check("ultracode: 'ultracode do X' still parses", ex("ultracode do X") === "do X", JSON.stringify(ex("ultracode do X")));
	check("ultracode: 'ultracode: do X' still parses", ex("ultracode: do X") === "do X", JSON.stringify(ex("ultracode: do X")));
	check("ultracode: bare 'ultracode:' yields no task", ex("ultracode:") === undefined, JSON.stringify(ex("ultracode:")));
	check("ultracode: non-command 'ultracoder things' is ignored", ex("ultracoder things") === undefined, JSON.stringify(ex("ultracoder things")));
}

// F43: peak-parallel estimation must not overcount when one agent ends at the exact instant
// another starts (a +1/-1 tie at the same timestamp must process the -1 first).
async function scenarioPeakParallelTieAccuracy(url) {
	const mod = await import(`${url}?pk=${instance++}`);
	check("peak: estimatePeakParallelAgents exported", typeof mod.estimatePeakParallelAgents === "function", typeof mod.estimatePeakParallelAgents);
	if (typeof mod.estimatePeakParallelAgents !== "function") return;
	const est = mod.estimatePeakParallelAgents;
	const backToBack = [
		{ state: "completed", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:10.000Z" },
		{ state: "completed", startedAt: "2026-01-01T00:00:10.000Z", endedAt: "2026-01-01T00:00:20.000Z" },
	];
	check("peak: back-to-back agents (one ends as next starts) count as 1", est(backToBack) === 1, String(est(backToBack)));
	const overlapping = [
		{ state: "completed", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:15.000Z" },
		{ state: "completed", startedAt: "2026-01-01T00:00:10.000Z", endedAt: "2026-01-01T00:00:20.000Z" },
	];
	check("peak: genuinely overlapping agents count as 2", est(overlapping) === 2, String(est(overlapping)));
}

// F14: run resolution must prefer an EXACT id match over a substring match on a different run
// (otherwise `/workflow delete abc` could delete a run "abc123" instead of "abc").
async function scenarioResolveRunExactMatchFirst(url) {
	const mod = await import(`${url}?rk=${instance++}`);
	check("resolve: selectRunByKey is exported", typeof mod.selectRunByKey === "function", typeof mod.selectRunByKey);
	if (typeof mod.selectRunByKey !== "function") return;
	const sel = mod.selectRunByKey;
	const runs = [{ runId: "abc123", workflow: "alpha" }, { runId: "abc", workflow: "beta" }];
	check("resolve: exact id wins over a longer id that contains it", sel(runs, "abc", (r) => r.runId, (r) => r.workflow)?.runId === "abc", JSON.stringify(sel(runs, "abc", (r) => r.runId)));
	check("resolve: falls back to substring when no exact id", sel([{ runId: "abc123", workflow: "x" }], "abc", (r) => r.runId)?.runId === "abc123");
	check("resolve: falls back to workflow alias", sel([{ runId: "z9", workflow: "build" }], "build", (r) => r.runId, (r) => r.workflow)?.runId === "z9");
	check("resolve: no match returns undefined", sel(runs, "zzz", (r) => r.runId) === undefined);
}

// templates.ts is self-contained (zero imports), so it can be bundled on its own.
async function buildTemplates() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-templates-"));
	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "templates.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "templates.mjs");
	const r = spawnSync("npx", ["--yes", "esbuild", src, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`], { cwd: REPO_ROOT, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`esbuild templates failed: ${r.stderr || r.stdout}`);
	return pathToFileURL(out).href;
}

// Find an embedded scaffold by content (robust to pattern-key renames).
async function findScaffold(mod, pred) {
	for (const pattern of mod.WORKFLOW_PATTERN_CATALOG ?? []) {
		let code;
		try { code = await mod.loadWorkflowPatternCode(pattern); } catch { continue; }
		if (pred(code)) return code;
	}
	return undefined;
}

function evalScaffold(code) {
	const m = { exports: {} };
	new Function("module", "exports", code)(m, m.exports);
	return m.exports;
}

// F1: the scout/classify scaffold must not interpolate input.pattern into a shell command.
async function scenarioScoutTemplateInjectionSafe(mod) {
	const scoutCode = await findScaffold(mod, (c) => /git ls-files/.test(c) && /ctx\.pipeline/.test(c));
	check("scout template: scaffold found", typeof scoutCode === "string", String(scoutCode).slice(0, 60));
	if (typeof scoutCode !== "string") return;

	// (a) Structural: never interpolate input into a single-quoted shell grep.
	check("scout template: no shell interpolation of pattern into grep", !/grep -E '\$\{/.test(scoutCode), scoutCode.match(/.{0,30}grep -E.{0,30}/)?.[0]);

	// (b) Behavioral: a malicious pattern must never reach the shell. Eval the scaffold with a
	// mock ctx that records bash commands; the (non-matching) regex must filter to zero files in
	// JS, hitting the early return without the payload ever appearing in a shell command.
	const workflow = evalScaffold(scoutCode);
	check("scout template: scaffold exports a workflow function", typeof workflow === "function", typeof workflow);
	if (typeof workflow !== "function") return;

	const bashCommands = [];
	const ctx = {
		bash: async (command) => { bashCommands.push(command); return { stdout: "a.ts\nb.js\nMakefile\n", stderr: "", code: 0 }; },
		log: async () => {},
		pipeline: async () => [],
		agent: async () => ({ output: "SYNTH", data: undefined }),
		writeArtifact: async () => {},
		compact: () => "",
	};
	const malicious = "x'; touch INJECTED_SENTINEL; echo '";
	let result;
	try { result = await workflow(ctx, { pattern: malicious, maxFiles: 40 }); } catch (e) { result = `THREW: ${e?.message ?? e}`; }

	check("scout template: only 'git ls-files' is shelled (no interpolation)", bashCommands.length > 0 && bashCommands.every((c) => c === "git ls-files"), JSON.stringify(bashCommands));
	check("scout template: injection payload never reaches the shell", !bashCommands.some((c) => /INJECTED_SENTINEL|touch |;/.test(c)), JSON.stringify(bashCommands));
	check("scout template: non-matching pattern is filtered in JS (zero files)", typeof result === "string" && /No files matched/i.test(result), String(result));
}

// F21: non-numeric counts must fall back to defaults, not NaN -> Array.from({length:NaN}) = empty
// jury (every finding silently "survives" unreviewed) or slice(0,NaN) = no findings.
async function scenarioAdversarialInputCoercion(mod) {
	const code = await findScaffold(mod, (c) => /skepticsPerFinding/.test(c) && /Array\.from\(\{ length: skeptics/.test(c));
	check("adversarial template: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	const workflow = evalScaffold(code);
	const ctx = {
		limits: { concurrency: 8, maxAgents: 8 },
		log: async () => {},
		json: (x) => JSON.stringify(x),
		writeArtifact: async () => {},
		// One vote per thunk: jury size is observable, refuted:false keeps findings alive.
		parallel: async (arr) => arr.map(() => ({ refuted: false, why: "ok" })),
		agent: async (_p, opts) =>
			opts?.name === "finder"
				? { data: Array.from({ length: 12 }, (_u, i) => ({ id: `f${i}`, claim: `c${i}`, evidence: "" })), output: "" }
				: { data: [], output: "[]" },
		compact: () => "",
	};
	const res = await workflow(ctx, { findings: [{ id: "a", claim: "x", evidence: "" }], skeptics: "three" });
	check("adversarial template: non-numeric skeptics falls back to default 3 (not NaN/empty jury)", res && res.skepticsPerFinding === 3, JSON.stringify(res?.skepticsPerFinding));
	const res2 = await workflow(ctx, { topic: "t", maxFindings: "lots" });
	check("adversarial template: non-numeric maxFindings falls back to default 8 (not slice(0,NaN)=empty)", res2 && res2.totalFindings === 8, JSON.stringify(typeof res2 === "string" ? res2 : res2?.totalFindings));
}

// F22: a non-numeric maxEscalations made `escalation >= maxEscalations` always false, so the
// while(true) loop only stopped on a 'high' verdict -> unbounded spend. It must bound at the
// default instead.
async function scenarioJudgeEscalateBounded(mod) {
	const code = await findScaffold(mod, (c) => /maxEscalations/.test(c) && /while \(true\)/.test(c));
	check("judge-escalate template: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	const workflow = evalScaffold(code);
	let judgeCalls = 0;
	let totalAgent = 0;
	const ctx = {
		limits: { concurrency: 4, maxAgents: 8 },
		log: async () => {},
		writeArtifact: async () => {},
		compact: () => "",
		parallel: async (arr) => arr.map(() => ({ output: "candidate" })),
		agent: async (_p, opts) => {
			totalAgent += 1;
			if (totalAgent > 25) throw new Error("infinite-loop-guard tripped");
			if (String(opts?.name).startsWith("judge-")) { judgeCalls += 1; return { data: { winner: 1, confidence: "medium", why: "" } }; }
			return { output: "final" }; // synthesis after the loop
		},
	};
	let threw = false;
	try { await workflow(ctx, { question: "q", maxEscalations: "abc" }); } catch { threw = true; }
	check("judge-escalate template: non-numeric maxEscalations terminates at the default bound (no infinite loop)", !threw && judgeCalls === 3, `threw=${threw} judgeCalls=${judgeCalls}`);
}

// F21 sibling: compose-verify-claims `maxClaims` must fall back to the default, not NaN ->
// slice(0,NaN) dropping every discovered claim.
async function scenarioVerifyClaimsMaxClaimsCoercion(mod) {
	const code = await findScaffold(mod, (c) => /claim-finder/.test(c) && /lib\/verify-claims/.test(c));
	check("compose-verify-claims template: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	const workflow = evalScaffold(code);
	let claimsLen = -1;
	const ctx = {
		limits: { concurrency: 8, maxAgents: 8 },
		log: async () => {},
		compact: () => "",
		writeArtifact: async (name, data) => { if (name === "claims.json") claimsLen = data.length; },
		workflow: async () => ({ verified: [], dropped: [], votes: [], coverage: {} }),
		agent: async (_p, opts) =>
			opts?.name === "claim-finder"
				? { output: JSON.stringify(Array.from({ length: 12 }, (_u, i) => ({ id: `c${i}`, claim: `x${i}`, evidence: "" }))) }
				: { output: "synth", data: {} },
	};
	const res = await workflow(ctx, { topic: "t", maxClaims: "lots" });
	check("compose-verify-claims template: non-numeric maxClaims falls back to default 8 (not slice(0,NaN)=empty)", claimsLen === 8, `claimsLen=${claimsLen} res=${String(res).slice(0, 40)}`);
}

// F21 sibling (reachable via lib-verify-claims): non-numeric skeptics must fall back to the
// default, not NaN -> Array.from({length:NaN}) empty jury -> every claim dropped unverified.
async function scenarioVerifyClaimsLibSkepticsCoercion(mod) {
	const code = await findScaffold(mod, (c) => /requestedSkeptics/.test(c) && /Array\.from\(\{ length: skeptics/.test(c));
	check("verify-claims-lib template: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	const workflow = evalScaffold(code);
	let juryLen = -1;
	const ctx = {
		limits: { concurrency: 8, maxAgents: 8 },
		log: async () => {},
		writeArtifact: async () => {},
		agents: async (arr) => { juryLen = arr.length; return arr.map(() => ({ data: { refuted: false, confidence: "high", evidence: "", why: "ok" } })); },
	};
	const res = await workflow(ctx, { claims: [{ id: "c1", claim: "x", evidence: "" }], skeptics: "three" });
	check("verify-claims-lib template: non-numeric skeptics falls back to default 3 (coverage)", res && res.coverage && res.coverage.requestedSkeptics === 3, JSON.stringify(res?.coverage));
	check("verify-claims-lib template: jury runs default 3 skeptics (not NaN/empty)", juryLen === 3, `juryLen=${juryLen}`);
}

// Invariant: every embedded scaffold must be reachable from the catalog (no dead templates).
async function scenarioNoOrphanedTemplates(mod) {
	const orphans = mod.listOrphanedTemplateKeys();
	check("templates: no orphaned/unreachable embedded scaffolds", Array.isArray(orphans) && orphans.length === 0, `orphans=${JSON.stringify(orphans)}`);
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
		await scenarioResolveRunExactMatchFirst(url);
		await scenarioRunProcessSigkillEscalation(url);
		await scenarioStreamingSigkillEscalation(url);
		await scenarioPeakParallelTieAccuracy(url);
		await scenarioUltracodeTaskParsing(url);
		await scenarioAppendMutexPurge(url);
		await scenarioShutdownTimerNoLeak(url);
		const templatesUrl = await buildTemplates();
		const templatesMod = await import(`${templatesUrl}?i=${instance++}`);
		await scenarioScoutTemplateInjectionSafe(templatesMod);
		await scenarioAdversarialInputCoercion(templatesMod);
		await scenarioJudgeEscalateBounded(templatesMod);
		await scenarioVerifyClaimsMaxClaimsCoercion(templatesMod);
		await scenarioVerifyClaimsLibSkepticsCoercion(templatesMod);
		await scenarioNoOrphanedTemplates(templatesMod);
		console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
		if (counts.failed) {
			console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
