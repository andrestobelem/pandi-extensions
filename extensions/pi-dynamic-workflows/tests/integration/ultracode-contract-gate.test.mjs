#!/usr/bin/env node
/**
 * Behavioral regression test for the Ultracode Contract Gate.
 *
 * Observable contract:
 *   - /dynamic-workflow prompts include an explicit task-contract review before normal
 *     scout/orchestration guidance.
 *   - Text input starting with `ultracode ...` uses the same transformation.
 *   - The always-on Ultracode router advertises the same lightweight Contract Gate
 *     contract without double-injecting generated /dynamic-workflow prompts.
 *   - /ultracode is registered as a faithful alias of /dynamic-workflow (its behavior is pinned
 *     separately in ultracode-command-alias.test.mjs; here we only assert it exists).
 *   - /ultracode-contract can disable and re-enable the Contract Gate without
 *     disabling Ultracode routing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-ultracode-contract",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		copyDirs: { scaffolds: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "scaffolds") },
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "full" }),
		},
	});
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi({ activeTools = [] } = {}) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const messages = [];
	let active = [...activeTools];
	const pi = {
		events: { on: () => {} },
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: (text, options) => messages.push({ text, options }),
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
		getActiveTools: () => [...active],
		getAllTools: () => [...tools.values()],
		setActiveTools: (names) => {
			active = [...names];
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return {
		pi,
		tools,
		commands,
		handlers,
		messages,
		get activeTools() {
			return active;
		},
	};
}

function makeCtx({ idle = true, statuses = [], notifications = [] } = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: REPO_ROOT,
		isIdle: () => idle,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_color, value) => value },
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: (key, value) => statuses.push({ key, value }),
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

async function fireFirst(handlers, event, payload) {
	for (const handler of handlers.get(event) || []) {
		const result = await handler(payload);
		if (result !== undefined) return result;
	}
	return undefined;
}

function assertContractGate(label, prompt) {
	check(`${label} includes contract gate heading`, prompt.includes("Contract Gate"));
	check(`${label} requires a workflow`, /task-contract review workflow/i.test(prompt));
	check(`${label} preserves trivial gate`, /survive the trivial gate/i.test(prompt));
	check(`${label} names improved task output`, prompt.includes("improvedTask"));
	check(`${label} feeds improved task forward`, /Use the improved task/i.test(prompt));
}

function assertNoContractGate(label, prompt) {
	check(`${label} omits contract gate heading`, !prompt.includes("Contract Gate"), prompt);
	check(
		`${label} omits task-contract review workflow requirement`,
		!/task-contract review workflow/i.test(prompt),
		prompt,
	);
	check(
		`${label} keeps ultracode rules`,
		prompt.includes("Ultracode rules:") || prompt.includes("## Always-on Ultracode Router"),
		prompt,
	);
}

async function scenarioSlashCommand(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const command = harness.commands.get("dynamic-workflow");
	check("/dynamic-workflow command registered", !!command);

	await command.handler("audita este repo", makeCtx());
	const prompt = harness.messages[0]?.text ?? "";
	check(
		"/dynamic-workflow activates dynamic_workflow",
		harness.activeTools.includes("dynamic_workflow"),
		harness.activeTools.join(","),
	);
	check("/dynamic-workflow keeps original task", prompt.includes("Task:\naudita este repo"), prompt);
	assertContractGate("/dynamic-workflow prompt", prompt);
}

async function scenarioDynamicWorkflowCommand(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const dynamicWorkflow = harness.commands.get("dynamic-workflow");
	const ultracode = harness.commands.get("ultracode");
	check("/dynamic-workflow command registered", !!dynamicWorkflow);
	// /ultracode is a registered alias of /dynamic-workflow (full alias behavior lives in
	// ultracode-command-alias.test.mjs); assert only that it is registered.
	check("/ultracode is registered as an alias of /dynamic-workflow", !!ultracode, String(ultracode));

	const notifications = [];
	await dynamicWorkflow.handler("   ", makeCtx({ notifications }));
	check(
		"/dynamic-workflow with no task shows usage",
		notifications.at(-1)?.message === "Usage: /dynamic-workflow <task>",
		JSON.stringify(notifications.at(-1)),
	);
}

async function scenarioInputTransform(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const result = await fireFirst(harness.handlers, "input", {
		source: "user",
		text: "ultracode audita npm",
		images: ["image-1"],
	});
	check("input hook transforms ultracode prefix", result?.action === "transform", JSON.stringify(result));
	check("input transform preserves images", result?.images?.[0] === "image-1", JSON.stringify(result?.images));
	check("input transform strips prefix", result?.text?.includes("Task:\naudita npm"), result?.text);
	assertContractGate("input prompt", result?.text ?? "");
}

async function scenarioAlwaysOn(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const result = await fireFirst(harness.handlers, "before_agent_start", {
		prompt: "audita este repo",
		systemPrompt: "base system",
		systemPromptOptions: { selectedTools: [] },
	});
	check(
		"always-on injects router guidance",
		result?.systemPrompt?.startsWith("base system\n\n## Always-on Ultracode Router"),
		result?.systemPrompt,
	);
	assertContractGate("always-on prompt", result?.systemPrompt ?? "");

	const generated = await fireFirst(harness.handlers, "before_agent_start", {
		prompt: "Use Pi Dynamic Workflows when they are warranted for this task.\n\nTask:\nx\n\nUltracode rules:\n",
		systemPrompt: "base system",
		systemPromptOptions: { selectedTools: ["dynamic_workflow"] },
	});
	check("always-on skips generated ultracode prompts", generated === undefined, JSON.stringify(generated));
}

async function scenarioContractGateToggle(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	const statuses = [];
	const notifications = [];
	const ctx = () => makeCtx({ statuses, notifications });
	extension(harness.pi);
	const contractGate = harness.commands.get("ultracode-contract");
	const dynamicWorkflow = harness.commands.get("dynamic-workflow");
	const deepResearch = harness.commands.get("deep-research");
	check("/ultracode-contract command registered", !!contractGate);
	check("/dynamic-workflow command still registered", !!dynamicWorkflow);
	check("/deep-research command still registered", !!deepResearch);

	await contractGate.handler("status", ctx());
	check(
		"/ultracode-contract status reports on",
		notifications.at(-1)?.message === "Ultracode Contract Gate is enabled.",
		JSON.stringify(notifications.at(-1)),
	);
	check(
		"/ultracode-contract status writes cg:on",
		statuses.at(-1)?.value === "cg:on",
		JSON.stringify(statuses.at(-1)),
	);

	await contractGate.handler("disable", ctx());
	check(
		"/ultracode-contract disable alias writes cg:off",
		statuses.at(-1)?.value === "cg:off",
		JSON.stringify(statuses.at(-1)),
	);
	await dynamicWorkflow.handler("audita sin fase cero", ctx());
	const prompt = harness.messages.at(-1)?.text ?? "";
	check(
		"/dynamic-workflow still routes when the Contract Gate is off",
		prompt.includes("Task:\naudita sin fase cero"),
		prompt,
	);
	assertNoContractGate("/dynamic-workflow prompt after contract gate off", prompt);

	const input = await fireFirst(harness.handlers, "input", {
		source: "user",
		text: "ultracode revisa npm",
		images: [],
	});
	check(
		"input transform still works when the Contract Gate is off",
		input?.action === "transform",
		JSON.stringify(input),
	);
	assertNoContractGate("input prompt after contract gate off", input?.text ?? "");

	const alwaysOn = await fireFirst(harness.handlers, "before_agent_start", {
		prompt: "audita este repo",
		systemPrompt: "base system",
		systemPromptOptions: { selectedTools: [] },
	});
	check(
		"always-on still injects router when the Contract Gate is off",
		alwaysOn?.systemPrompt?.includes("## Always-on Ultracode Router"),
		alwaysOn?.systemPrompt,
	);
	assertNoContractGate("always-on prompt after contract gate off", alwaysOn?.systemPrompt ?? "");

	await deepResearch.handler("investiga sin fase cero", ctx());
	const deepPromptOff = harness.messages.at(-1)?.text ?? "";
	check(
		"/deep-research still routes when the Contract Gate is off",
		deepPromptOff.includes("Task:\ninvestiga sin fase cero"),
		deepPromptOff,
	);
	assertNoContractGate("/deep-research prompt after contract gate off", deepPromptOff);

	await contractGate.handler("enable", ctx());
	check(
		"/ultracode-contract enable alias writes cg:on",
		statuses.at(-1)?.value === "cg:on",
		JSON.stringify(statuses.at(-1)),
	);
	await dynamicWorkflow.handler("audita con fase cero", ctx());
	assertContractGate("/dynamic-workflow prompt after contract gate on", harness.messages.at(-1)?.text ?? "");
	await deepResearch.handler("investiga con fase cero", ctx());
	assertContractGate("/deep-research prompt after contract gate on", harness.messages.at(-1)?.text ?? "");

	await contractGate.handler("wat", ctx());
	check(
		"/ultracode-contract invalid shows usage",
		notifications.at(-1)?.message === "Usage: /ultracode-contract [on|off|status]",
		JSON.stringify(notifications.at(-1)),
	);
}

async function scenarioTemplateCatalog(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const tool = harness.tools.get("dynamic_workflow");
	check("dynamic_workflow tool registered", !!tool);

	const ctx = makeCtx();
	const signal = new AbortController().signal;
	const catalogResult = await tool.execute("catalog", { action: "scaffold" }, signal, () => {}, ctx);
	const catalog = catalogResult.content?.[0]?.text ?? "";
	// The single-interface catalog: keys ARE the scaffold names (meta.name) of the 25 workflows.
	const requiredTopLevel = [
		"contract-gate",
		"guardrails",
		"router",
		"orchestrator-workers",
		"composition-driver",
		"verify-claims-lib",
		"workflow-factory",
		"recursive-compose",
		"fan-out-and-synthesize",
		"scout-fanout",
		"repo-bug-hunt",
		"loop-until-dry",
		"react-scout",
		"complex-research",
		"adversarial-verify",
		"bug-verify",
		"adversarial-plan-review",
		"judge-escalate",
		"tournament",
		"self-consistency",
		"tree-of-thoughts",
		"self-refine",
		"reflexion",
		"large-migration",
		"map-reduce",
	];
	for (const key of requiredTopLevel) check(`catalog exposes ${key}`, catalog.includes(`- ${key} —`), catalog);
	// Old abstract pattern keys retired by the single-interface refactor.
	const retiredKeys = [
		"default",
		"deep-research",
		"classify-and-act",
		"adversarial-verification",
		"generate-and-filter",
		"tournaments",
		"loop-until-done",
		"compose-verify-claims",
		"lib-verify-claims",
		"bug-hunt-repo-audit",
		"plan-review",
		"claim-bug-verification",
	];
	for (const oldKey of retiredKeys) {
		check(`catalog demotes old key ${oldKey}`, !new RegExp(`^- ${oldKey} —`, "m").test(catalog), catalog);
	}
	check("catalog groups primary scaffolds", catalog.includes("## Scaffolds"), catalog);
	check("catalog groups composition scaffolds", catalog.includes("## Compose scaffolds"), catalog);
	check("catalog groups use-case scaffolds", catalog.includes("## Use-case scaffolds"), catalog);
	check(
		"catalog includes research-backed templates",
		catalog.includes("## Research-backed templates") && catalog.includes("**ReAct** -> scout/observe"),
		catalog,
	);

	for (const key of requiredTopLevel) {
		const scaffold = await tool.execute("scaffold", { action: "scaffold", name: key }, signal, () => {}, ctx);
		check(
			`scaffold loads for ${key}`,
			scaffold.details?.pattern?.key === key && /export const meta\s*=/.test(scaffold.content?.[0]?.text ?? ""),
			JSON.stringify(scaffold.details?.pattern),
		);
	}

	for (const oldKey of retiredKeys) {
		let rejected = false;
		try {
			await tool.execute("alias", { action: "scaffold", name: oldKey }, signal, () => {}, ctx);
		} catch (err) {
			rejected = err instanceof Error && err.message.includes("Unknown workflow pattern");
		}
		check(`${oldKey} no longer resolves as a pattern alias`, rejected);
	}
}

async function main() {
	const { outDir, url } = await buildExtension();
	try {
		await scenarioSlashCommand(url);
		await scenarioDynamicWorkflowCommand(url);
		await scenarioInputTransform(url);
		await scenarioAlwaysOn(url);
		await scenarioContractGateToggle(url);
		await scenarioTemplateCatalog(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
