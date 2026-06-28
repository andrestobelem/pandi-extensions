#!/usr/bin/env node
/**
 * Behavioral regression test for the Ultracode Contract Gate.
 *
 * Observable contract:
 *   - /ultracode prompts include an explicit task-contract review before normal
 *     scout/orchestration guidance.
 *   - Text input starting with `ultracode ...` uses the same transformation.
 *   - The always-on Ultracode router advertises the same lightweight Contract Gate
 *     contract without double-injecting generated /ultracode prompts.
 *   - /ultracode-contract can disable and re-enable the Contract Gate without
 *     disabling Ultracode routing.
 */

import { spawnSync } from "node:child_process";
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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-ultracode-contract-"));

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
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} getText() { return ""; } setText() {} handleInput() {} render() { return []; } invalidate() {} }\n`,
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
	return { pi, tools, commands, handlers, messages, get activeTools() { return active; } };
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
	check(`${label} omits task-contract review workflow requirement`, !/task-contract review workflow/i.test(prompt), prompt);
	check(`${label} keeps ultracode rules`, prompt.includes("Ultracode rules:") || prompt.includes("## Always-on Ultracode Router"), prompt);
}

async function scenarioSlashCommand(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const command = harness.commands.get("ultracode");
	check("/ultracode command registered", !!command);

	await command.handler("audita este repo", makeCtx());
	const prompt = harness.messages[0]?.text ?? "";
	check("/ultracode activates dynamic_workflow", harness.activeTools.includes("dynamic_workflow"), harness.activeTools.join(","));
	check("/ultracode keeps original task", prompt.includes("Task:\naudita este repo"), prompt);
	assertContractGate("/ultracode prompt", prompt);
}

async function scenarioInputTransform(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const result = await fireFirst(harness.handlers, "input", { source: "user", text: "ultracode audita npm", images: ["image-1"] });
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
	check("always-on injects router guidance", result?.systemPrompt?.startsWith("base system\n\n## Always-on Ultracode Router"), result?.systemPrompt);
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
	const ultracode = harness.commands.get("ultracode");
	const deepResearch = harness.commands.get("deep-research");
	check("/ultracode-contract command registered", !!contractGate);
	check("/ultracode command still registered", !!ultracode);
	check("/deep-research command still registered", !!deepResearch);

	await contractGate.handler("status", ctx());
	check("/ultracode-contract status reports on", notifications.at(-1)?.message === "Ultracode Contract Gate is enabled.", JSON.stringify(notifications.at(-1)));
	check("/ultracode-contract status writes cg:on", statuses.at(-1)?.value === "cg:on", JSON.stringify(statuses.at(-1)));

	await contractGate.handler("disable", ctx());
	check("/ultracode-contract disable alias writes cg:off", statuses.at(-1)?.value === "cg:off", JSON.stringify(statuses.at(-1)));
	await ultracode.handler("audita sin fase cero", ctx());
	const prompt = harness.messages.at(-1)?.text ?? "";
	check("/ultracode still routes when the Contract Gate is off", prompt.includes("Task:\naudita sin fase cero"), prompt);
	assertNoContractGate("/ultracode prompt after contract gate off", prompt);

	const input = await fireFirst(harness.handlers, "input", { source: "user", text: "ultracode revisa npm", images: [] });
	check("input transform still works when the Contract Gate is off", input?.action === "transform", JSON.stringify(input));
	assertNoContractGate("input prompt after contract gate off", input?.text ?? "");

	const alwaysOn = await fireFirst(harness.handlers, "before_agent_start", {
		prompt: "audita este repo",
		systemPrompt: "base system",
		systemPromptOptions: { selectedTools: [] },
	});
	check("always-on still injects router when the Contract Gate is off", alwaysOn?.systemPrompt?.includes("## Always-on Ultracode Router"), alwaysOn?.systemPrompt);
	assertNoContractGate("always-on prompt after contract gate off", alwaysOn?.systemPrompt ?? "");

	await deepResearch.handler("investiga sin fase cero", ctx());
	const deepPromptOff = harness.messages.at(-1)?.text ?? "";
	check("/deep-research still routes when the Contract Gate is off", deepPromptOff.includes("Task:\ninvestiga sin fase cero"), deepPromptOff);
	assertNoContractGate("/deep-research prompt after contract gate off", deepPromptOff);

	await contractGate.handler("enable", ctx());
	check("/ultracode-contract enable alias writes cg:on", statuses.at(-1)?.value === "cg:on", JSON.stringify(statuses.at(-1)));
	await ultracode.handler("audita con fase cero", ctx());
	assertContractGate("/ultracode prompt after contract gate on", harness.messages.at(-1)?.text ?? "");
	await deepResearch.handler("investiga con fase cero", ctx());
	assertContractGate("/deep-research prompt after contract gate on", harness.messages.at(-1)?.text ?? "");

	await contractGate.handler("wat", ctx());
	check("/ultracode-contract invalid shows usage", notifications.at(-1)?.message === "Usage: /ultracode-contract [on|off|status]", JSON.stringify(notifications.at(-1)));
}

async function scenarioTemplateCatalog(url) {
	const extension = await freshExtension(url);
	const harness = makePi();
	extension(harness.pi);
	const tool = harness.tools.get("dynamic_workflow");
	check("dynamic_workflow tool registered", !!tool);

	const ctx = makeCtx();
	const signal = new AbortController().signal;
	const catalogResult = await tool.execute("catalog", { action: "template" }, signal, () => {}, ctx);
	const catalog = catalogResult.content?.[0]?.text ?? "";
	const requiredTopLevel = [
		"classify-and-act",
		"fan-out-and-synthesize",
		"adversarial-verification",
		"generate-and-filter",
		"tournaments",
		"loop-until-done",
		"compose-verify-claims",
		"lib-verify-claims",
		"workflow-factory",
		"bug-hunt-repo-audit",
		"large-migration",
		"complex-research",
		"plan-review",
		"claim-bug-verification",
	];
	for (const key of requiredTopLevel) check(`catalog exposes ${key}`, catalog.includes(`- ${key} —`), catalog);
	for (const oldKey of ["default", "scout-fanout", "loop-until-dry", "adversarial-verify", "judge-escalate", "tournament", "repo-bug-hunt", "deep-research", "adversarial-plan-review"]) {
		check(`catalog demotes old key ${oldKey}`, !new RegExp(`^- ${oldKey} —`, "m").test(catalog), catalog);
	}
	check("catalog groups primary templates", catalog.includes("## Templates"), catalog);
	check("catalog groups composition templates", catalog.includes("## Compose templates"), catalog);
	check("catalog groups use-case templates", catalog.includes("## Use-case templates"), catalog);
	check("catalog includes research-backed templates", catalog.includes("## Research-backed templates") && catalog.includes("**ReAct** -> scout/observe"), catalog);

	for (const key of requiredTopLevel) {
		const scaffold = await tool.execute("scaffold", { action: "template", name: key }, signal, () => {}, ctx);
		check(`scaffold loads for ${key}`, scaffold.details?.pattern?.key === key && /module\.exports\s*=\s*async function workflow/.test(scaffold.content?.[0]?.text ?? ""), JSON.stringify(scaffold.details?.pattern));
	}

	for (const oldKey of ["default", "scout-fanout", "loop-until-dry", "adversarial-verify", "judge-escalate", "tournament", "repo-bug-hunt", "deep-research", "adversarial-plan-review", "composition-driver", "verify-claims-lib"]) {
		let rejected = false;
		try {
			await tool.execute("alias", { action: "template", name: oldKey }, signal, () => {}, ctx);
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
		await scenarioInputTransform(url);
		await scenarioAlwaysOn(url);
		await scenarioContractGateToggle(url);
		await scenarioTemplateCatalog(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) {
		console.log("Failures:");
		for (const failure of failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
