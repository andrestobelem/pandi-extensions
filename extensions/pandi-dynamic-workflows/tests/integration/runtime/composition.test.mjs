/**
 * Test de integración conductual durable para composición ctx.workflow() en extensions/pandi-dynamic-workflows/index.ts.
 *
 * Esto pinea el contrato runtime observable para sub-workflows:
 *   - ctx.workflow(name, input) devuelve el output del child workflow dentro del mismo run.
 *   - El child comparte runId/runDir/limits y emite eventos workflow start/end.
 *   - Depth está capado en 1 (un sub-workflow no puede llamar otro sub-workflow).
 *   - El budget de agentes se comparte entre parent + child.
 *   - Las keys de resume cache tienen namespace por código de sub-workflow, así cambiar el código del child
 *     reejecuta llamadas cacheadas del child sin re-correr llamadas sin cambios del parent.
 *
 * Ejecutalo:
 *   node extensions/pandi-dynamic-workflows/tests/integration/dynamic-workflow-composition.test.mjs
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, makeBuildDir } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension, EXT_DIR, REPO_ROOT, SCAFFOLDS_DIR } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Leé el set completo de fuentes de scaffolds directo desde disco: el set exacto que pattern-scaffolds.ts
// sirve en runtime (reemplaza el readSources() del gen-scaffolds.mjs eliminado).
function readSources() {
	const map = {};
	for (const file of readdirSync(SCAFFOLDS_DIR)) {
		if (file.endsWith(".js")) map[file.slice(0, -3)] = readFileSync(path.join(SCAFFOLDS_DIR, file), "utf8");
	}
	return map;
}

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dwf-integration" });
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

// F4: un child que ignora SIGTERM debe escalarse a SIGKILL para que los process runners no puedan
// colgarse para siempre (y, en el runner streaming, nunca liberar el semáforo de agentes).
const SIGTERM_IGNORING_CHILD =
	"process.on('SIGTERM', () => {}); const t = setInterval(() => {}, 1e9); setTimeout(() => { clearInterval(t); process.exit(0); }, 30000);";

async function scenarioRunProcessSigkillEscalation(url) {
	const mod = await import(`${url}?p=${instance++}`);
	check("runProcess: exported", typeof mod.runProcess === "function", typeof mod.runProcess);
	if (typeof mod.runProcess !== "function") return;
	const TIMED_OUT = Symbol("guard");
	const guard = new Promise((res) => setTimeout(() => res(TIMED_OUT), 6000));
	const run = mod.runProcess(process.execPath, ["-e", SIGTERM_IGNORING_CHILD], {
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
	const run = mod.runStreamingAgentProcess(process.execPath, ["-e", SIGTERM_IGNORING_CHILD], {
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

// F27: settleWithinTimeout debe limpiar su timer de timeout para que una promise que settlea rápido (p. ej. todos los
// runs activos abortando rápido al shutdown de sesión) no pueda mantener vivo el event loop ~3s.
async function scenarioShutdownTimerNoLeak(url) {
	const mod = await import(`${url}?st=${instance++}`);
	check(
		"shutdown: settleWithinTimeout exported",
		typeof mod.settleWithinTimeout === "function",
		typeof mod.settleWithinTimeout,
	);
	if (typeof mod.settleWithinTimeout !== "function") return;
	// Check real de exit-timing en un proceso fresco: con una promise rápida vs un timeout de 3s, el child
	// debe salir pronto. Un timer filtrado (sin limpiar) retendría el loop ~3s.
	const childScript = `import(${JSON.stringify(url)}).then(async (m) => { await m.settleWithinTimeout(Promise.resolve("x"), 3000); process.stdout.write("SETTLED"); });`;
	const start = Date.now();
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
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

// F42: el map de mutex de append por archivo no debe crecer sin límite; las entradas se purgan cuando ningún
// writer usa un path, sin romper exclusión mutua para writers concurrentes.
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

// F49: extractUltracodeTask debe aceptar un separador `:`/`-` con o sin espacio posterior
// (p. ej. `ultracode:do X`), no solo un separador de whitespace.
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

// F43: la estimación peak-parallel no debe sobrecontar cuando un agente termina en el instante exacto
// en que otro empieza (un empate +1/-1 en el mismo timestamp debe procesar primero el -1).
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

// F14: la resolución de run debe preferir un match EXACTO de id sobre un match de substring en otro run
// (si no, `/workflow delete abc` podría borrar un run "abc123" en vez de "abc").
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

// pattern-scaffolds.ts importa sus siblings catalog/pattern-format, así que esbuild --bundle
// arrastra todo el graph de módulos de pattern a un bundle que podemos importar in-process.
async function buildScaffolds() {
	const { outDir, aliases } = await makeBuildDir("pi-dwf-scaffolds", {});
	const src = path.join(EXT_DIR, "surface", "pattern-scaffolds.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const url = await bundle({
		src,
		outDir,
		outName: "pattern-scaffolds.mjs",
		aliases,
		npx: "--yes",
	});
	// El módulo bundleado lee scaffolds/*.js relativo a su propio import.meta.url (= outDir),
	// así que copiá las fuentes junto al bundle. Producción (sin bundle) las lee in place.
	await fs.cp(SCAFFOLDS_DIR, path.join(outDir, "scaffolds"), { recursive: true });
	return url;
}

// Encontrá un scaffold embebido por contenido (robusto ante renombres de pattern-key).
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

// El transformWorkflowCode REAL (desde el bundle index.ts), seteado en main(). Los scaffolds son la
// forma single-interface (`export const meta` + globals inyectados + `export default async function
// workflow()`), así que DEBEMOS compilarlos con el transform runtime (que levanta meta y
// reescribe el export) en vez de una regex artesanal.
let __transform;

// Compilá un scaffold a su función workflow. No hacen falta globals en LOAD time: el cuerpo solo
// DEFINE la fn; los globals se consumen cuando CORRE (ver runScaffold).
function evalScaffold(code) {
	const cjs = __transform(code);
	const m = { exports: {} };
	new Function("module", "exports", cjs)(m, m.exports);
	return m.exports;
}

// Corré un scaffold con una bolsa de globals inyectados (la superficie single-interface). La fn workflow
// los cierra porque los pasamos como params de Function; `args` lleva el input (el script
// lo parsea defensivamente). parallel/pipeline default a thunk-runners reales para que el mock de agente maneje
// completamente el comportamiento; los escenarios overridean cualquier global según haga falta.
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

async function scenarioRecursiveComposeStopsAtDepthBoundary(mod) {
	const code = await findScaffold(mod, (source) => /name:\s*"recursive-compose"/.test(source));
	check("recursive-compose boundary: scaffold found", typeof code === "string");
	if (!code) return;

	const workflowCalls = [];
	const result = await runScaffold(code, {
		args: { task: "Audit the parser", args: { maxFiles: 12 } },
		workflow: async (name, input) => {
			workflowCalls.push({ name, input });
			if (name === "contract-gate") {
				return {
					status: "PROCEED",
					rewrittenPrompt: "Audit the parser with evidence",
					routing: { shape: "dynamic-workflow", pattern: "map-reduce" },
					contract: { improvedTask: "Audit the parser with evidence" },
					resourcePlan: {
						models: { mapper: "haiku" },
						efforts: { mapper: "low" },
					},
				};
			}
			if (name === "router") {
				return {
					selected: "map-reduce",
					why: "independent files",
					dispatched: false,
					suggestedArgs: { task: "Audit the parser with evidence", maxFiles: 99 },
				};
			}
			throw new Error(`unexpected workflow call: ${name}`);
		},
	});

	const routerCall = workflowCalls.find((call) => call.name === "router");
	check(
		"recursive-compose boundary: router is recommendation-only",
		routerCall?.input?.runSelected === false,
		JSON.stringify(routerCall),
	);
	check(
		"recursive-compose boundary: unsupported nested dispatch is explicit",
		result?.status === "DEPTH_BLOCKED" && result?.stage === "dispatch",
		JSON.stringify(result),
	);
	check(
		"recursive-compose boundary: preserves the selected top-level recommendation",
		result?.recommendation?.selected === "map-reduce" && result?.recommendation?.dispatched === false,
		JSON.stringify(result),
	);
	check(
		"recursive-compose boundary: continuation merges suggested input, explicit overrides, and gate budget",
		result?.dispatchArgs?.task === "Audit the parser with evidence" &&
			result?.dispatchArgs?.maxFiles === 12 &&
			result?.dispatchArgs?.models?.mapper === "haiku" &&
			result?.dispatchArgs?.efforts?.mapper === "low",
		JSON.stringify(result?.dispatchArgs),
	);
}

// El scaffold scout-fanout nunca debe dejar que input.pattern llegue a un shell. Bajo el contrato
// single-interface, FENCEA el pattern dentro del prompt de discovery de un agente (un delimitador content-hash) y
// corre la work-list por pipeline(...): no hay interpolación shell en absoluto. Asertá eso
// estáticamente (la vieja ruta eval-and-run no puede observar un shell que ya no existe).
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

// F21: los counts no numéricos deben caer a defaults, no NaN -> Array.from({length:NaN}) = jury
// vacío (cada finding "sobrevive" silenciosamente sin review) o slice(0,NaN) = sin findings.
async function scenarioAdversarialInputCoercion(mod) {
	const code = await findScaffold(mod, (c) => /skepticsPerFinding/.test(c) && /majorityToKill/.test(c));
	check("adversarial scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	// Single-interface: el global agent() devuelve el objeto PARSEADO para llamadas schema. node() setea
	// `label`, así que branch sobre eso. parallel (default de runScaffold) corre los thunks de jury, que llaman al
	// agente skeptic y recolectan sus votos.
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

// F22: un maxEscalations no numérico hacía que `escalation >= maxEscalations` siempre fuera false, así que el
// loop while(true) solo frenaba con un veredicto 'high' -> gasto sin límite. Debe acotarse al
// default en su lugar.
async function scenarioJudgeEscalateBounded(mod) {
	const code = await findScaffold(mod, (c) => /maxEscalations/.test(c) && /while \(true\)/.test(c));
	check("judge-escalate scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	let judgeCalls = 0;
	let totalAgent = 0;
	// agent() global: schema judge -> veredicto parseado; candidates/synthesis -> texto. node() setea label.
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

// Sibling de F21 (alcanzable vía lib-verify-claims): skeptics no numérico debe caer al
// default, no NaN -> Array.from({length:NaN}) jury vacío -> cada claim cae sin verificar.
async function scenarioVerifyClaimsLibSkepticsCoercion(mod) {
	const code = await findScaffold(
		mod,
		(c) => /coverage: \{ claims/.test(c) && /Array\.from\(\s*\{ length: skeptics/.test(c),
	);
	check("verify-claims-lib scaffold: scaffold found", typeof code === "string", String(code).slice(0, 60));
	if (typeof code !== "string") return;
	let juryLen = -1;
	// Cada thunk de jury llama al agente skeptic (schema VERDICT -> voto parseado) y luego envuelve {name,data}.
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

// Invariante: cada scaffold embebido debe ser alcanzable desde el catálogo (sin scaffolds muertos).
async function scenarioNoOrphanedScaffolds(mod) {
	const orphans = mod.listOrphanedScaffoldKeys();
	check(
		"scaffolds: no orphaned/unreachable embedded scaffolds",
		Array.isArray(orphans) && orphans.length === 0,
		`orphans=${JSON.stringify(orphans)}`,
	);
}

// PISO de cobertura de parse: cada scaffold embebido alcanzable desde el catálogo (más el
// default WORKFLOW_SCAFFOLD) debe parsear con `new Function` y exportar una función workflow.
// Los escenarios targeted de arriba solo ejercitan ~5 scaffolds por rutas runtime específicas,
// así que un error de sintaxis en cualquiera de los otros (p. ej. loop-until-dry, tournament, repo-bug-hunt)
// se shipearía silenciosamente. Esto sube el piso a cobertura de sintaxis para TODOS, keyeado por
// el catálogo para que pattern keys nuevas se evalúen automáticamente.
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

	// Belt-and-suspenders: el default WORKFLOW_SCAFFOLD se sirve cuando no se pasa pattern,
	// así que evalualo explícitamente aunque fan-out-and-synthesize aliasee hacia él.
	let defaultOk = false;
	let defaultDetail = "";
	try {
		defaultOk = typeof evalScaffold(mod.getDefaultScaffold()) === "function";
		defaultDetail = defaultOk ? "function" : typeof evalScaffold(mod.getDefaultScaffold());
	} catch (err) {
		defaultDetail = err instanceof Error ? err.message : String(err);
	}
	check("all scaffolds: WORKFLOW_SCAFFOLD default parses and exports a workflow function", defaultOk, defaultDetail);
}

// Gate de orphan/parse sobre el set COMPLETO de scaffolds (cada scaffolds/*.js shipeado en el paquete),
// no solo los alcanzables desde el catálogo que cubre scenarioAllScaffoldsParse. readSources() lee las
// fuentes directo desde disco (el set exacto que pattern-scaffolds.ts sirve en runtime);
// buildScaffolds() da la resolución runtime pública. Esto cierra M1/M2 de la review: un
// scaffolds/foo.js agregado sin entrada de catálogo igual shipea pero queda sin parsear/inalcanzable:
// código muerto o roto que se shipea con cero gates fallidos. Cada fuente debe (a) parsear + exportar una
// función workflow y (b) ser alcanzable desde el catálogo público (o ser el default), así un orphan
// falla acá.
async function scenarioNoOrphanScaffold(mod) {
	const sources = readSources();
	const keys = Object.keys(sources);
	check("orphan guard: scaffold sources discovered", keys.length > 0, `count=${keys.length}`);

	// Invariante de packaging: las fuentes .js deben shippear (ya no hay copia codegen).
	const extPkg = JSON.parse(
		readFileSync(path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "package.json"), "utf8"),
	);
	check(
		"packaging: files[] ships the scaffolds/ dir",
		(extPkg.files ?? []).includes("scaffolds"),
		JSON.stringify(extPkg.files),
	);
	check(
		"packaging: files[] no longer ships scaffolds.generated.ts",
		!(extPkg.files ?? []).includes("scaffolds.generated.ts"),
		JSON.stringify(extPkg.files),
	);

	// Cada string que el catálogo público puede servir, más el scaffold default sin pattern.
	const reachable = new Set();
	for (const pattern of mod.WORKFLOW_PATTERN_CATALOG ?? []) {
		try {
			reachable.add(await mod.loadWorkflowPatternCode(pattern));
		} catch {
			/* los failures de parse/resolution los aserta scenarioAllScaffoldsParse */
		}
	}
	reachable.add(mod.getDefaultScaffold());

	for (const key of keys) {
		const code = sources[key];
		// (a) M2: cada fuente embebida parsea y exporta una función workflow.
		let parses = false;
		let detail = "";
		try {
			parses = typeof evalScaffold(code) === "function";
			detail = parses ? "function" : `exports=${typeof evalScaffold(code)}`;
		} catch (err) {
			detail = err instanceof Error ? err.message : String(err);
		}
		check(`orphan guard: scaffold ${key} parses and exports a workflow function`, parses, detail);
		// (b) M1: cada fuente embebida es alcanzable desde el catálogo (sin archivo orphan/dead).
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
		// Compilá scaffolds con el transform runtime REAL (levanta `export const meta`, reescribe
		// el export); vive en el bundle index.ts, no en pattern-scaffolds.ts.
		__transform = (await import(`${url}?i=${instance++}`)).transformWorkflowCode;
		await scenarioRecursiveComposeStopsAtDepthBoundary(scaffoldsMod);
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
