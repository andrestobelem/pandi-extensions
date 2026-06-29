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
import { readSources } from "../../../../scripts/gen-scaffolds.mjs";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

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
	const file = path.join(
		project,
		".pi",
		"workflows",
		relativeName.endsWith(".js") ? relativeName : `${relativeName}.js`,
	);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, code, "utf8");
	return file;
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
}

async function scenarioComposition(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent",
		`
module.exports = async function workflow(ctx, input) {
  await ctx.log("parent before child");
  const parent = { runId: ctx.runId, runDir: ctx.runDir, maxAgents: ctx.limits.maxAgents, input: ctx.input };
  const child = await ctx.workflow("lib/child", { value: input.value, parentRunId: ctx.runId, parentRunDir: ctx.runDir, maxAgents: ctx.limits.maxAgents });
  await ctx.writeArtifact("parent-after.json", { childRunId: child.runId });
  return { parent, child };
};
`,
	);
	await writeWorkflow(
		project,
		"lib/child",
		`
module.exports = async function workflow(ctx, input) {
  await ctx.log("child running", input);
  await ctx.writeArtifact("child-output.json", { runId: ctx.runId, runDir: ctx.runDir, input: ctx.input });
  return { runId: ctx.runId, runDir: ctx.runDir, input: ctx.input, maxAgents: ctx.limits.maxAgents };
};
`,
	);

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
	check(
		"composition: child receives input",
		result.output.child.input.value === "from-parent",
		JSON.stringify(result.output),
	);
	check(
		"composition: child shares runId",
		result.output.parent.runId === result.output.child.runId,
		JSON.stringify(result.output),
	);
	check(
		"composition: child shares runDir",
		result.runDir === result.output.child.runDir,
		JSON.stringify(result.output),
	);
	check(
		"composition: child sees parent limits",
		result.output.child.maxAgents === 7,
		JSON.stringify(result.output.child),
	);

	const childArtifact = await readJson(path.join(result.runDir, "child-output.json"));
	check(
		"composition: child artifact lands in parent runDir",
		childArtifact.runDir === result.runDir,
		JSON.stringify(childArtifact),
	);
	const events = await readEvents(result.runDir);
	check(
		"composition: emits workflow start event",
		events.some((e) => e.type === "workflow" && e.phase === "start" && e.name === "lib/child"),
	);
	check(
		"composition: emits workflow end event",
		events.some((e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/child" && e.ok === true),
	);
}

async function scenarioDepthLimit(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent-depth",
		`
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/nesting-child", {});
};
`,
	);
	await writeWorkflow(
		project,
		"lib/nesting-child",
		`
module.exports = async function workflow(ctx) {
  return await ctx.workflow("lib/grandchild", {});
};
`,
	);
	await writeWorkflow(project, "lib/grandchild", "module.exports = async () => 'should-not-run';\n");

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	let message = "";
	try {
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "parent-depth",
			timeoutMs: 30_000,
		});
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	check(
		"composition: nested ctx.workflow is rejected",
		/depth limit is 1|sub-workflows cannot call/i.test(message),
		message,
	);
}

async function scenarioSharedAgentBudget(url, outDir) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent-agent-limit",
		`
module.exports = async function workflow(ctx) {
  const child = await ctx.workflow("lib/agent-child", {});
  const parent = await ctx.agent("parent after child", { name: "parent-agent", cache: false, includeSkills: false, includeExtensions: false });
  return { child, parent: parent.output };
};
`,
	);
	await writeWorkflow(
		project,
		"lib/agent-child",
		`
module.exports = async function workflow(ctx) {
  const child = await ctx.agent("child one", { name: "child-agent", cache: false, includeSkills: false, includeExtensions: false });
  return { output: child.output };
};
`,
	);
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
			await runTool(tools.get("dynamic_workflow"), ctx, {
				action: "run",
				name: "parent-agent-limit",
				maxAgents: 1,
				concurrency: 1,
				timeoutMs: 30_000,
			});
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
	await fs.writeFile(
		path.join(webSearchPackage, "package.json"),
		JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }),
		"utf8",
	);
	await fs.writeFile(webSearchExt, "export default function webSearchExtension() {}\n", "utf8");

	const context7Skill = path.join(project, ".agents", "skills", "context7-cli");
	await fs.mkdir(context7Skill, { recursive: true });
	await fs.writeFile(
		path.join(context7Skill, "SKILL.md"),
		"---\nname: context7-cli\ndescription: Test Context7 skill.\n---\n",
		"utf8",
	);

	await writeWorkflow(
		project,
		"agent-access",
		`
module.exports = async function workflow(ctx) {
  await ctx.agent("default explicit tools", { name: "default-access", tools: ["read", "grep"], cache: false });
  await ctx.agent("explicit skill", { name: "explicit-skill", tools: ["read"], skills: ["./local-skill"], cache: false });
  await ctx.agent("opt out", { name: "opt-out", tools: ["read"], includeExtensions: false, includeSkills: false, cache: false });
  return "ok";
};
`,
	);

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
		const response = await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "agent-access",
			maxAgents: 5,
			concurrency: 1,
			timeoutMs: 30_000,
		});
		check("agent access: workflow succeeds", response.details.result.ok === true, response.details.result.error);
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
	const toolsFor = (args) => (valuesFor(args, "--tools")[0] || "").split(",").filter(Boolean);
	const defaultCall = calls[0];
	const explicitSkillCall = calls[1];
	const optOutCall = calls[2];
	const expectedWebSearchExt = await fs.realpath(webSearchExt);
	const expectedContext7Skill = await fs.realpath(context7Skill);

	check(
		"agent access: default explicit tool allowlist gains web_search",
		toolsFor(defaultCall).includes("web_search"),
		JSON.stringify(defaultCall),
	);
	check(
		"agent access: default web_search extension is loaded explicitly",
		valuesFor(defaultCall, "--extension").includes(expectedWebSearchExt),
		JSON.stringify(defaultCall),
	);
	check(
		"agent access: default skill discovery stays enabled",
		!defaultCall.includes("--no-skills"),
		JSON.stringify(defaultCall),
	);
	check(
		"agent access: explicit skills also get context7",
		valuesFor(explicitSkillCall, "--skill").includes(expectedContext7Skill),
		JSON.stringify(explicitSkillCall),
	);
	check(
		"agent access: explicit skills keep explicit-only semantics",
		explicitSkillCall.includes("--no-skills"),
		JSON.stringify(explicitSkillCall),
	);
	check(
		"agent access: includeExtensions false opts out of web_search default",
		!toolsFor(optOutCall).includes("web_search") && valuesFor(optOutCall, "--extension").length === 0,
		JSON.stringify(optOutCall),
	);
	check(
		"agent access: includeSkills false opts out of skill defaults",
		optOutCall.includes("--no-skills") && valuesFor(optOutCall, "--skill").length === 0,
		JSON.stringify(optOutCall),
	);
}

async function scenarioAgentStructuredOutputSurvivesTruncatedJsonEventStream(url, outDir) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"agent-truncated-json",
		`
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
`,
	);

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
		const response = await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "agent-truncated-json",
			maxAgents: 1,
			concurrency: 1,
			timeoutMs: 30_000,
		});
		const result = response.details.result;
		check("agent JSON: workflow succeeds with truncated event stream", result.ok === true, result.error);
		check(
			"agent JSON: parsed output is final assistant text",
			result.output.output === JSON.stringify(expected),
			JSON.stringify(result.output),
		);
		check(
			"agent JSON: structured data comes from assistant text",
			result.output.schemaOk === true && result.output.data?.ok === true && result.output.data?.value === "kept",
			JSON.stringify(result.output),
		);
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
	const code =
		"module.exports = async function workflow(ctx, input) { await ctx.writeArtifact('draft.json', input); return { ok: true, input }; };\n";
	const write = await runTool(tools.get("dynamic_workflow"), ctx, {
		action: "write",
		name: "location-check",
		code,
	});
	const workflow = write.details.workflow;
	const expected = path.join(project, ".pi", "workflows", "drafts", "location-check.js");
	const oldGeneratedPath = path.join(project, ".pi", "workflows", "generated", "location-check.js");
	check("workflow drafts: written next to workflows/runs", workflow.path === expected, JSON.stringify(workflow));
	check("workflow drafts: file exists in workflows/drafts", existsSync(expected), expected);
	check("workflow drafts: old workflows/generated path is not used", !existsSync(oldGeneratedPath), oldGeneratedPath);

	const run = (
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "location-check",
			input: { value: 42 },
			timeoutMs: 30_000,
		})
	).details.result;
	check(
		"workflow drafts: run resolves from workflows/drafts",
		run.ok === true && run.output.input.value === 42,
		JSON.stringify(run.output),
	);

	const globalDraftDir = path.join(outDir, "agentdir", "workflows", "drafts");
	await fs.mkdir(globalDraftDir, { recursive: true });
	await fs.writeFile(
		path.join(globalDraftDir, "global-location.js"),
		"module.exports = async () => ({ global: true });\n",
		"utf8",
	);
	const globalDraftRun = (
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "global-location",
			timeoutMs: 30_000,
		})
	).details.result;
	check(
		"workflow drafts: global .pi fallback resolves drafts",
		globalDraftRun.ok === true && globalDraftRun.output.global === true,
		JSON.stringify(globalDraftRun.output),
	);

	const globalRunId = "2000-01-01T00-00-00-000Z-global-fallback-00000000";
	const projectHash = crypto.createHash("sha1").update(project).digest("hex").slice(0, 12);
	const globalRunDir = path.join(outDir, "agentdir", "workflows", "runs", projectHash, globalRunId);
	await fs.mkdir(globalRunDir, { recursive: true });
	await fs.writeFile(
		path.join(globalRunDir, "result.json"),
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
		"utf8",
	);
	const runs = (await runTool(tools.get("dynamic_workflow"), ctx, { action: "runs" })).details.runs;
	check(
		"workflow runs: global .pi fallback lists runs",
		runs.some((entry) => entry.runId === globalRunId),
		runs.map((entry) => entry.runId).join(","),
	);

	let generatedPrefixMessage = "";
	try {
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "generated/location-check",
			timeoutMs: 30_000,
		});
	} catch (err) {
		generatedPrefixMessage = err instanceof Error ? err.message : String(err);
	}
	check(
		"workflow drafts: generated/<name> prefix is rejected",
		/Workflow not found: generated\/location-check/.test(generatedPrefixMessage),
		generatedPrefixMessage,
	);
}

async function scenarioChildCodeHashNamespacesResumeCache(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent-cache",
		`
module.exports = async function workflow(ctx) {
  const parent = await ctx.bash("printf shared-cache", { cache: true });
  const child = await ctx.workflow("lib/cache-child", {});
  return { parent: parent.stdout, child };
};
`,
	);
	await writeWorkflow(
		project,
		"lib/cache-child",
		`
module.exports = async function workflow(ctx) {
  const child = await ctx.bash("printf shared-cache", { cache: true });
  return { version: "v1", stdout: child.stdout };
};
`,
	);

	let execCount = 0;
	const ext = await freshExtension(url);
	const { pi, tools } = makePi(async (_cmd, args) => {
		execCount += 1;
		return { code: 0, killed: false, stdout: `exec-${execCount}:${args[1]}`, stderr: "" };
	});
	ext(pi);
	const ctx = makeCtx(project);
	const first = (
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "parent-cache",
			timeoutMs: 30_000,
		})
	).details.result;
	check("composition cache: first run executes parent + child bash", execCount === 2, `execCount=${execCount}`);
	check(
		"composition cache: first child version is v1",
		first.output.child.version === "v1",
		JSON.stringify(first.output),
	);

	await writeWorkflow(
		project,
		"lib/cache-child",
		`
module.exports = async function workflow(ctx) {
  const child = await ctx.bash("printf shared-cache", { cache: true });
  return { version: "v2", stdout: child.stdout };
};
`,
	);
	const resumed = (
		await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "resume",
			name: first.runId,
			force: true,
		})
	).details.result;
	check(
		"composition cache: unchanged parent bash is cached on resume",
		resumed.output.parent === first.output.parent,
		JSON.stringify(resumed.output),
	);
	check(
		"composition cache: changed child code re-executes child bash",
		execCount === 3,
		`execCount=${execCount}, output=${JSON.stringify(resumed.output)}`,
	);
	check(
		"composition cache: resumed child uses new code",
		resumed.output.child.version === "v2",
		JSON.stringify(resumed.output),
	);
	check(
		"composition cache: reports cached parent call",
		resumed.cachedCalls === 1,
		`cachedCalls=${resumed.cachedCalls}`,
	);
}

// F4: a child that ignores SIGTERM must be escalated to SIGKILL so the process runners can't
// hang forever (and, for the streaming runner, never release the agent semaphore).
const SIGTERM_IGNORING_CHILD =
	"process.on('SIGTERM', () => {}); const t = setInterval(() => {}, 1e9); setTimeout(() => { clearInterval(t); process.exit(0); }, 30000);";

async function scenarioRunProcessSigkillEscalation(url) {
	const mod = await import(`${url}?p=${instance++}`);
	check("runProcess: exported", typeof mod.runProcess === "function", typeof mod.runProcess);
	if (typeof mod.runProcess !== "function") return;
	const TIMED_OUT = Symbol("guard");
	const guard = new Promise((res) => setTimeout(() => res(TIMED_OUT), 6000));
	const run = mod.runProcess("node", ["-e", SIGTERM_IGNORING_CHILD], {
		cwd: REPO_ROOT,
		timeoutMs: 200,
		killGraceMs: 200,
	});
	const result = await Promise.race([run, guard]);
	check(
		"runProcess: SIGTERM-ignoring child is force-killed so the promise resolves (no hang)",
		result !== TIMED_OUT,
		"did not resolve within 6s",
	);
	if (result !== TIMED_OUT) check("runProcess: reports timedOut", result.timedOut === true, JSON.stringify(result));
}

async function scenarioStreamingSigkillEscalation(url) {
	const mod = await import(`${url}?s=${instance++}`);
	check(
		"runStreamingAgentProcess: exported",
		typeof mod.runStreamingAgentProcess === "function",
		typeof mod.runStreamingAgentProcess,
	);
	if (typeof mod.runStreamingAgentProcess !== "function") return;
	const TIMED_OUT = Symbol("guard");
	const guard = new Promise((res) => setTimeout(() => res(TIMED_OUT), 6000));
	const run = mod.runStreamingAgentProcess("node", ["-e", SIGTERM_IGNORING_CHILD], {
		cwd: REPO_ROOT,
		timeoutMs: 200,
		killGraceMs: 200,
		signal: new AbortController().signal,
	});
	const result = await Promise.race([run, guard]);
	check(
		"runStreamingAgentProcess: SIGTERM-ignoring child is force-killed so the promise resolves (no hang)",
		result !== TIMED_OUT,
		"did not resolve within 6s",
	);
	if (result !== TIMED_OUT)
		check("runStreamingAgentProcess: reports killed", result.killed === true, JSON.stringify(result));
}

// F27: settleWithinTimeout must clear its timeout timer so a fast-settling promise (e.g. all
// active runs aborting quickly at session shutdown) cannot keep the event loop alive ~3s.
async function scenarioShutdownTimerNoLeak(url) {
	const mod = await import(`${url}?st=${instance++}`);
	check(
		"shutdown: settleWithinTimeout exported",
		typeof mod.settleWithinTimeout === "function",
		typeof mod.settleWithinTimeout,
	);
	if (typeof mod.settleWithinTimeout !== "function") return;
	// Real exit-timing check in a fresh process: with a fast promise vs a 3s timeout, the child
	// must exit promptly. A leaked (uncleared) timer would hold the loop ~3s.
	const childScript = `import(${JSON.stringify(url)}).then(async (m) => { await m.settleWithinTimeout(Promise.resolve("x"), 3000); process.stdout.write("SETTLED"); });`;
	const start = Date.now();
	const r = spawnSync("node", ["--input-type=module", "-e", childScript], {
		encoding: "utf8",
		timeout: 10000,
	});
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
	check(
		"append: appendFileMutexCount exported",
		typeof mod.appendFileMutexCount === "function",
		typeof mod.appendFileMutexCount,
	);
	if (typeof mod.appendJsonLine !== "function" || typeof mod.appendFileMutexCount !== "function") return;
	const tmp = path.join(os.tmpdir(), `dwf-append-${process.pid}-${instance++}.jsonl`);
	try {
		await mod.appendJsonLine(tmp, { a: 1 });
		check(
			"append: mutex map purged after a single write",
			mod.appendFileMutexCount() === 0,
			String(mod.appendFileMutexCount()),
		);
		await Promise.all([
			mod.appendJsonLine(tmp, { b: 2 }),
			mod.appendJsonLine(tmp, { c: 3 }),
			mod.appendJsonLine(tmp, { d: 4 }),
		]);
		check(
			"append: mutex map purged after concurrent writes",
			mod.appendFileMutexCount() === 0,
			String(mod.appendFileMutexCount()),
		);
		const lines = (await fs.readFile(tmp, "utf8")).trim().split("\n").filter(Boolean);
		const allValid =
			lines.length === 4 &&
			lines.every((l) => {
				try {
					JSON.parse(l);
					return true;
				} catch {
					return false;
				}
			});
		check("append: concurrent writes stay serialized (4 intact JSON lines)", allValid, `lines=${lines.length}`);
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

// F49: extractUltracodeTask must accept a `:`/`-` separator with or without a following space
// (e.g. `ultracode:do X`), not only a whitespace separator.
async function scenarioUltracodeTaskParsing(url) {
	const mod = await import(`${url}?uc=${instance++}`);
	check(
		"ultracode: extractUltracodeTask exported",
		typeof mod.extractUltracodeTask === "function",
		typeof mod.extractUltracodeTask,
	);
	if (typeof mod.extractUltracodeTask !== "function") return;
	const ex = mod.extractUltracodeTask;
	check(
		"ultracode: 'ultracode:do X' parses task without a space",
		ex("ultracode:do X") === "do X",
		JSON.stringify(ex("ultracode:do X")),
	);
	check(
		"ultracode: 'ultracode do X' still parses",
		ex("ultracode do X") === "do X",
		JSON.stringify(ex("ultracode do X")),
	);
	check(
		"ultracode: 'ultracode: do X' still parses",
		ex("ultracode: do X") === "do X",
		JSON.stringify(ex("ultracode: do X")),
	);
	check(
		"ultracode: bare 'ultracode:' yields no task",
		ex("ultracode:") === undefined,
		JSON.stringify(ex("ultracode:")),
	);
	check(
		"ultracode: non-command 'ultracoder things' is ignored",
		ex("ultracoder things") === undefined,
		JSON.stringify(ex("ultracoder things")),
	);
}

// F43: peak-parallel estimation must not overcount when one agent ends at the exact instant
// another starts (a +1/-1 tie at the same timestamp must process the -1 first).
async function scenarioPeakParallelTieAccuracy(url) {
	const mod = await import(`${url}?pk=${instance++}`);
	check(
		"peak: estimatePeakParallelAgents exported",
		typeof mod.estimatePeakParallelAgents === "function",
		typeof mod.estimatePeakParallelAgents,
	);
	if (typeof mod.estimatePeakParallelAgents !== "function") return;
	const est = mod.estimatePeakParallelAgents;
	const backToBack = [
		{
			state: "completed",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:10.000Z",
		},
		{
			state: "completed",
			startedAt: "2026-01-01T00:00:10.000Z",
			endedAt: "2026-01-01T00:00:20.000Z",
		},
	];
	check(
		"peak: back-to-back agents (one ends as next starts) count as 1",
		est(backToBack) === 1,
		String(est(backToBack)),
	);
	const overlapping = [
		{
			state: "completed",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:15.000Z",
		},
		{
			state: "completed",
			startedAt: "2026-01-01T00:00:10.000Z",
			endedAt: "2026-01-01T00:00:20.000Z",
		},
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
	const runs = [
		{ runId: "abc123", workflow: "alpha" },
		{ runId: "abc", workflow: "beta" },
	];
	check(
		"resolve: exact id wins over a longer id that contains it",
		sel(
			runs,
			"abc",
			(r) => r.runId,
			(r) => r.workflow,
		)?.runId === "abc",
		JSON.stringify(sel(runs, "abc", (r) => r.runId)),
	);
	check(
		"resolve: falls back to substring when no exact id",
		sel([{ runId: "abc123", workflow: "x" }], "abc", (r) => r.runId)?.runId === "abc123",
	);
	check(
		"resolve: falls back to workflow alias",
		sel(
			[{ runId: "z9", workflow: "build" }],
			"build",
			(r) => r.runId,
			(r) => r.workflow,
		)?.runId === "z9",
	);
	check("resolve: no match returns undefined", sel(runs, "zzz", (r) => r.runId) === undefined);
}

// pattern-scaffolds.ts imports its catalog/pattern-format siblings, so esbuild --bundle
// pulls the whole pattern module graph into one bundle we can import in-process.
async function buildScaffolds() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-scaffolds-"));
	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "pattern-scaffolds.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "pattern-scaffolds.mjs");
	const r = spawnSync(
		"npx",
		["--yes", "esbuild", src, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild pattern-scaffolds failed: ${r.stderr || r.stdout}`);
	return pathToFileURL(out).href;
}

// Find an embedded scaffold by content (robust to pattern-key renames).
async function findScaffold(mod, pred) {
	for (const pattern of mod.WORKFLOW_PATTERN_CATALOG ?? []) {
		let code;
		try {
			code = await mod.loadWorkflowPatternCode(pattern);
		} catch {
			continue;
		}
		if (pred(code)) return code;
	}
	return undefined;
}

// The REAL transformWorkflowCode (from the index.ts bundle), set in main(). Scaffolds are the
// single-interface form (`export const meta` + injected globals + `export default async function
// workflow()`), so we MUST compile them through the runtime transform (which lifts meta and
// rewrites the export) rather than a hand-rolled regex.
let __transform;

// Compile a scaffold to its workflow function. No globals are needed at LOAD time — the body only
// DEFINES the fn; globals are consumed when it RUNS (see runScaffold).
function evalScaffold(code) {
	const cjs = __transform(code);
	const m = { exports: {} };
	new Function("module", "exports", cjs)(m, m.exports);
	return m.exports;
}

// Run a scaffold with a bag of injected globals (the single-interface surface). The workflow fn
// closes over them because we pass them as Function params; `args` carries the input (the script
// parses it defensively). parallel/pipeline default to real thunk-runners so the agent mock fully
// drives behavior; scenarios override any global as needed.
async function runScaffold(code, globals = {}) {
	const cjs = __transform(code);
	const bag = {
		log: async () => {},
		phase: () => {},
		writeArtifact: async () => {},
		appendArtifact: async () => {},
		compact: (x) => (typeof x === "string" ? x : JSON.stringify(x)),
		json: (x) => JSON.stringify(x),
		parallel: async (thunks) => Promise.all(thunks.map((t) => (typeof t === "function" ? t() : t))),
		pipeline: async (items, ...stages) => {
			const out = [];
			for (const item of items) {
				let v = item;
				for (const stage of stages) v = await stage(v, item, out.length);
				out.push(v);
			}
			return out;
		},
		...globals,
	};
	const names = Object.keys(bag);
	const vals = names.map((n) => bag[n]);
	const m = { exports: {} };
	new Function(...names, "module", "exports", cjs)(...vals, m, m.exports);
	return await m.exports();
}

// The scout-fanout scaffold must never let input.pattern reach a shell. Under the single-interface
// contract it FENCES the pattern into an agent's discovery prompt (a content-hash delimiter) and
// runs the work-list through pipeline(...) — there is no shell interpolation at all. Assert that
// statically (the old eval-and-run path can't observe a shell that no longer exists).
async function scenarioScoutScaffoldInjectionSafe(mod) {
	const scoutCode = await findScaffold(
		mod,
		(c) => /pipeline\(/.test(c) && /fence\(/.test(c) && /input\?\.pattern/.test(c),
	);
	check("scout scaffold: scaffold found", typeof scoutCode === "string", String(scoutCode).slice(0, 60));
	if (typeof scoutCode !== "string") return;
	check(
		"scout scaffold: input.pattern is fenced into the prompt (untrusted-data delimiter), not interpolated",
		/fence\([^)]*pattern\)/.test(scoutCode),
		"no fence(..., pattern)",
	);
	check(
		"scout scaffold: input is never interpolated into a bash() command",
		!/bash\([^)]*\$\{/.test(scoutCode),
		scoutCode.match(/bash\([^)]{0,40}/)?.[0] ?? "no bash()",
	);
}

// F21: non-numeric counts must fall back to defaults, not NaN -> Array.from({length:NaN}) = empty
// jury (every finding silently "survives" unreviewed) or slice(0,NaN) = no findings.
async function scenarioAdversarialInputCoercion(mod) {
	const code = await findScaffold(mod, (c) => /skepticsPerFinding/.test(c) && /majorityToKill/.test(c));
	check("adversarial scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	// Single-interface: the global agent() returns the PARSED object for schema calls. node() sets
	// `label`, so branch on it. parallel (runScaffold default) runs the jury thunks, which call the
	// skeptic agent and collect its votes.
	const agent = async (_p, opts) => {
		const label = opts?.label ?? opts?.name;
		if (label === "finder")
			return { findings: Array.from({ length: 12 }, (_u, i) => ({ id: `f${i}`, claim: `c${i}`, evidence: "" })) };
		return { refuted: false, why: "ok" }; // skeptic VOTE
	};
	const res = await runScaffold(code, {
		agent,
		args: { findings: [{ id: "a", claim: "x", evidence: "" }], skeptics: "three" },
	});
	check(
		"adversarial scaffold: non-numeric skeptics falls back to default 3 (not NaN/empty jury)",
		res && res.skepticsPerFinding === 3,
		JSON.stringify(typeof res === "string" ? res : res?.skepticsPerFinding),
	);
	const res2 = await runScaffold(code, { agent, args: { topic: "t", maxFindings: "lots" } });
	check(
		"adversarial scaffold: non-numeric maxFindings falls back to default 8 (not slice(0,NaN)=empty)",
		res2 && res2.totalFindings === 8,
		JSON.stringify(typeof res2 === "string" ? res2 : res2?.totalFindings),
	);
}

// F22: a non-numeric maxEscalations made `escalation >= maxEscalations` always false, so the
// while(true) loop only stopped on a 'high' verdict -> unbounded spend. It must bound at the
// default instead.
async function scenarioJudgeEscalateBounded(mod) {
	const code = await findScaffold(mod, (c) => /maxEscalations/.test(c) && /while \(true\)/.test(c));
	check("judge-escalate scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	let judgeCalls = 0;
	let totalAgent = 0;
	// Global agent(): schema judge -> parsed verdict; candidates/synthesis -> text. node() sets label.
	const agent = async (_p, opts) => {
		const label = String(opts?.label ?? opts?.name ?? "");
		totalAgent += 1;
		if (totalAgent > 40) throw new Error("infinite-loop-guard tripped");
		if (label.startsWith("judge-")) {
			judgeCalls += 1;
			return { winner: 1, confidence: "medium", why: "" };
		}
		return "candidate"; // candidates + final synthesis are non-schema -> text
	};
	let threw = false;
	try {
		await runScaffold(code, { agent, args: { question: "q", maxEscalations: "abc" } });
	} catch {
		threw = true;
	}
	check(
		"judge-escalate scaffold: non-numeric maxEscalations terminates at the default bound (no infinite loop)",
		!threw && judgeCalls === 3,
		`threw=${threw} judgeCalls=${judgeCalls}`,
	);
}

// F21 sibling (reachable via lib-verify-claims): non-numeric skeptics must fall back to the
// default, not NaN -> Array.from({length:NaN}) empty jury -> every claim dropped unverified.
async function scenarioVerifyClaimsLibSkepticsCoercion(mod) {
	const code = await findScaffold(
		mod,
		(c) => /coverage: \{ claims/.test(c) && /Array\.from\(\s*\{ length: skeptics/.test(c),
	);
	check("verify-claims-lib scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	let juryLen = -1;
	// Each jury thunk calls the skeptic agent (schema VERDICT -> parsed vote) then wraps {name,data}.
	const agent = async () => ({ refuted: false, confidence: "high", evidence: "x", why: "ok" });
	const parallel = async (thunks) => {
		juryLen = thunks.length;
		return Promise.all(thunks.map((t) => t()));
	};
	const res = await runScaffold(code, {
		agent,
		parallel,
		args: { claims: [{ id: "c1", claim: "x", evidence: "" }], skeptics: "three" },
	});
	check(
		"verify-claims-lib scaffold: non-numeric skeptics falls back to default 3 (coverage)",
		res?.coverage && res.coverage.skeptics === 3,
		JSON.stringify(res?.coverage),
	);
	check(
		"verify-claims-lib scaffold: jury runs default 3 skeptics (not NaN/empty)",
		juryLen === 3,
		`juryLen=${juryLen}`,
	);
}

// Invariant: every embedded scaffold must be reachable from the catalog (no dead scaffolds).
async function scenarioNoOrphanedScaffolds(mod) {
	const orphans = mod.listOrphanedScaffoldKeys();
	check(
		"scaffolds: no orphaned/unreachable embedded scaffolds",
		Array.isArray(orphans) && orphans.length === 0,
		`orphans=${JSON.stringify(orphans)}`,
	);
}

// Parse-coverage FLOOR: every embedded scaffold reachable from the catalog (plus the
// WORKFLOW_SCAFFOLD default) must `new Function`-parse and export a workflow function.
// The targeted scenarios above only exercise ~5 scaffolds along specific runtime paths,
// so a syntax error in any of the others (e.g. loop-until-dry, tournament, repo-bug-hunt)
// would ship silently. This raises the floor to syntax coverage for ALL of them, keyed by
// the catalog so newly added pattern keys are eval'd automatically.
async function scenarioAllScaffoldsParse(mod) {
	const catalog = mod.WORKFLOW_PATTERN_CATALOG ?? [];
	check(
		"all scaffolds: catalog is non-empty",
		Array.isArray(catalog) && catalog.length > 0,
		`length=${catalog.length}`,
	);

	let evaled = 0;
	for (const pattern of catalog) {
		let ok = false;
		let detail = "";
		try {
			const code = await mod.loadWorkflowPatternCode(pattern);
			ok = typeof evalScaffold(code) === "function";
			detail = ok ? "function" : `exports=${typeof evalScaffold(code)}`;
			evaled++;
		} catch (err) {
			detail = err instanceof Error ? err.message : String(err);
		}
		check(`all scaffolds: ${pattern.key} parses and exports a workflow function`, ok, detail);
	}
	check(
		"all scaffolds: every catalog key resolved to a parseable scaffold",
		evaled === catalog.length,
		`evaled=${evaled}/${catalog.length}`,
	);

	// Belt-and-suspenders: the default WORKFLOW_SCAFFOLD is served when no pattern is given,
	// so eval it explicitly even though fan-out-and-synthesize aliases onto it.
	let defaultOk = false;
	let defaultDetail = "";
	try {
		defaultOk = typeof evalScaffold(mod.WORKFLOW_SCAFFOLD) === "function";
		defaultDetail = defaultOk ? "function" : typeof evalScaffold(mod.WORKFLOW_SCAFFOLD);
	} catch (err) {
		defaultDetail = err instanceof Error ? err.message : String(err);
	}
	check("all scaffolds: WORKFLOW_SCAFFOLD default parses and exports a workflow function", defaultOk, defaultDetail);
}

// Orphan/parse gate over the FULL embedded set (every scaffolds/*.js inlined into
// EMBEDDED_SCAFFOLD_SOURCES), not just the catalog-reachable ones scenarioAllScaffoldsParse
// covers. readSources() is the exact set the generator inlines (the sync test pins it to the
// committed map); buildScaffolds() gives the public runtime resolution. This closes the
// review's M1/M2: a scaffolds/foo.js added without a pattern-scaffolds.ts alias is globbed into the
// shipped map but is otherwise unlinted/untyped/unparsed/unreachable -- dead or broken code
// that ships with zero failing gates. Each source must (a) parse + export a workflow function
// and (b) be reachable from the public catalog (or be the default), so an orphan fails here.
async function scenarioNoOrphanScaffold(mod) {
	const sources = readSources();
	const keys = Object.keys(sources);
	check("orphan guard: embedded scaffold sources discovered", keys.length > 0, `count=${keys.length}`);

	// Every string the public catalog can serve, plus the no-pattern default scaffold.
	const reachable = new Set();
	for (const pattern of mod.WORKFLOW_PATTERN_CATALOG ?? []) {
		try {
			reachable.add(await mod.loadWorkflowPatternCode(pattern));
		} catch {
			/* parse/resolution failures are asserted by scenarioAllScaffoldsParse */
		}
	}
	reachable.add(mod.WORKFLOW_SCAFFOLD);

	for (const key of keys) {
		const code = sources[key];
		// (a) M2: every embedded source parses and exports a workflow function.
		let parses = false;
		let detail = "";
		try {
			parses = typeof evalScaffold(code) === "function";
			detail = parses ? "function" : `exports=${typeof evalScaffold(code)}`;
		} catch (err) {
			detail = err instanceof Error ? err.message : String(err);
		}
		check(`orphan guard: scaffold ${key} parses and exports a workflow function`, parses, detail);
		// (b) M1: every embedded source is reachable from the catalog (no orphan/dead file).
		check(
			`orphan guard: scaffold ${key} is reachable from the catalog (not orphaned)`,
			reachable.has(code),
			"no catalog key (or the default) serves this scaffold file",
		);
	}
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
		const scaffoldsUrl = await buildScaffolds();
		const scaffoldsMod = await import(`${scaffoldsUrl}?i=${instance++}`);
		// Compile scaffolds through the REAL runtime transform (lifts `export const meta`, rewrites
		// the export); it lives in the index.ts bundle, not pattern-scaffolds.ts.
		__transform = (await import(`${url}?i=${instance++}`)).transformWorkflowCode;
		await scenarioScoutScaffoldInjectionSafe(scaffoldsMod);
		await scenarioAdversarialInputCoercion(scaffoldsMod);
		await scenarioJudgeEscalateBounded(scaffoldsMod);
		await scenarioVerifyClaimsLibSkepticsCoercion(scaffoldsMod);
		await scenarioNoOrphanedScaffolds(scaffoldsMod);
		await scenarioAllScaffoldsParse(scaffoldsMod);
		await scenarioNoOrphanScaffold(scaffoldsMod);
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
