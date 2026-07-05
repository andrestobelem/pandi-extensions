/**
 * Durable behavioral integration test for the model-callable tools registered by
 * extensions/pandi-ask/index.ts: `ask_choice` and `ask_confirm`.
 *
 * Why this exists: the assistant cannot pop an interactive TUI selector from a plain
 * text reply — only a TOOL can. These tools wrap pi's dialog helpers (`ctx.ui.select`
 * / `ctx.ui.confirm`, which work in TUI and RPC) so the model can present a decision
 * point as an interactive picker and read back the choice. This suite pins the contract:
 *   - both tools are registered, with the expected parameters
 *   - ask_choice: with UI, calls ui.select(question, options) and returns JSON
 *     {index (1-based), label}; on cancel returns {cancelled:true}
 *   - ask_confirm: with UI, calls ui.confirm(title, message) and returns {confirmed}
 *   - non-interactive (no hasUI): opens no dialog and returns a plain-text error
 *   - ask_choice with empty options: opens no dialog and returns an error
 *
 * Self-bootstrapping: esbuilds the CURRENT extensions/pandi-ask/index.ts into an OS temp
 * dir at run time (typebox stubbed to identity), so it never tests a stale bundle, then
 * drives the REAL registered tools with a fake ctx whose ui.select/ui.confirm are mocked.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildAsk() {
	return await buildExtension({
		name: "pi-ask-tools",
		src: path.join(REPO_ROOT, "extensions", "pandi-ask", "index.ts"),
		outName: "ask.mjs",
		stubs: { typebox: true },
		npx: "--no-install",
	});
}

function makeCtx({ mode = "tui", selectReturn, confirmReturn } = {}) {
	const selectCalls = [];
	const confirmCalls = [];
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			select: async (title, options) => {
				selectCalls.push({ title, options });
				return selectReturn;
			},
			confirm: async (title, message) => {
				confirmCalls.push({ title, message });
				return confirmReturn;
			},
			notify: () => {},
		},
		_selectCalls: selectCalls,
		_confirmCalls: confirmCalls,
	};
}

function makePi() {
	const tools = new Map();
	return {
		pi: { registerTool: (tool) => tools.set(tool.name, tool), registerCommand: () => {} },
		tools,
	};
}

async function loadTools(url) {
	const extension = await loadDefault(url);
	const { pi, tools } = makePi();
	extension(pi);
	return tools;
}

function parseResult(result) {
	const text = result?.content?.[0]?.text ?? "";
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function scenarioRegistered(tools) {
	const choice = tools.get("ask_choice");
	const confirm = tools.get("ask_confirm");
	check("ask_choice tool registered", !!choice, String(!!choice));
	check("ask_confirm tool registered", !!confirm, String(!!confirm));
	check("ask_choice execute is a function", typeof choice?.execute === "function");
	check("ask_confirm execute is a function", typeof confirm?.execute === "function");
	check(
		"ask_choice has question + options params",
		!!choice?.parameters?.question && "options" in (choice?.parameters ?? {}),
		JSON.stringify(Object.keys(choice?.parameters ?? {})),
	);
	check(
		"ask_confirm has a title param",
		"title" in (confirm?.parameters ?? {}),
		JSON.stringify(Object.keys(confirm?.parameters ?? {})),
	);
	check(
		"ask_choice description mentions options/pick",
		/opci[oó]n|elegir|elija|selector/i.test(choice?.description || ""),
		choice?.description,
	);
}

async function scenarioChoiceSelect(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Beta" });
	const result = await tool.execute(
		"c1",
		{ question: "Pick one:", options: ["Alpha", "Beta", "Gamma"] },
		undefined,
		undefined,
		ctx,
	);
	check("choice: ui.select called exactly once", ctx._selectCalls.length === 1, String(ctx._selectCalls.length));
	check("choice: ui.select got the question", ctx._selectCalls[0]?.title === "Pick one:", ctx._selectCalls[0]?.title);
	check(
		"choice: ui.select got the options",
		JSON.stringify(ctx._selectCalls[0]?.options) === JSON.stringify(["Alpha", "Beta", "Gamma"]),
		JSON.stringify(ctx._selectCalls[0]?.options),
	);
	const parsed = parseResult(result);
	check("choice: returns JSON with 1-based index", parsed?.index === 2, JSON.stringify(parsed));
	check("choice: returns the chosen label", parsed?.label === "Beta", JSON.stringify(parsed));
	check("choice: not cancelled", parsed?.cancelled !== true, JSON.stringify(parsed));
}

async function scenarioChoiceCancel(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: undefined });
	const result = await tool.execute(
		"c2",
		{ question: "Pick one:", options: ["Alpha", "Beta"] },
		undefined,
		undefined,
		ctx,
	);
	check("cancel: ui.select was called", ctx._selectCalls.length === 1, String(ctx._selectCalls.length));
	const parsed = parseResult(result);
	check("cancel: returns cancelled:true", parsed?.cancelled === true, JSON.stringify(parsed));
}

async function scenarioChoiceNoUi(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "print", selectReturn: "Alpha" });
	const result = await tool.execute(
		"c3",
		{ question: "Pick one:", options: ["Alpha", "Beta"] },
		undefined,
		undefined,
		ctx,
	);
	check("no-ui: opens no selector", ctx._selectCalls.length === 0, String(ctx._selectCalls.length));
	check(
		"no-ui: returns an error mentioning non-interactive",
		/no disponible|no interactivo|texto plano/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioChoiceEmpty(tools) {
	const tool = tools.get("ask_choice");
	const ctx = makeCtx({ mode: "tui", selectReturn: "Alpha" });
	const result = await tool.execute("c4", { question: "Pick one:", options: [] }, undefined, undefined, ctx);
	check("empty: opens no selector", ctx._selectCalls.length === 0, String(ctx._selectCalls.length));
	check(
		"empty: returns an error",
		/no options|error/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioConfirmTrue(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "tui", confirmReturn: true });
	const result = await tool.execute("k1", { title: "Proceed?", message: "This is safe." }, undefined, undefined, ctx);
	check("confirm-true: ui.confirm called once", ctx._confirmCalls.length === 1, String(ctx._confirmCalls.length));
	check(
		"confirm-true: ui.confirm got title + message",
		ctx._confirmCalls[0]?.title === "Proceed?" && ctx._confirmCalls[0]?.message === "This is safe.",
		JSON.stringify(ctx._confirmCalls[0]),
	);
	check("confirm-true: returns confirmed:true", parseResult(result)?.confirmed === true, result?.content?.[0]?.text);
}

async function scenarioConfirmFalse(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "tui", confirmReturn: false });
	const result = await tool.execute("k2", { title: "Proceed?" }, undefined, undefined, ctx);
	check(
		"confirm-false: returns confirmed:false",
		parseResult(result)?.confirmed === false,
		result?.content?.[0]?.text,
	);
}

async function scenarioConfirmNoUi(tools) {
	const tool = tools.get("ask_confirm");
	const ctx = makeCtx({ mode: "print", confirmReturn: true });
	const result = await tool.execute("k3", { title: "Proceed?" }, undefined, undefined, ctx);
	check("confirm no-ui: opens no dialog", ctx._confirmCalls.length === 0, String(ctx._confirmCalls.length));
	check(
		"confirm no-ui: returns an error",
		/no disponible|no interactivo|texto plano/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function main() {
	const { outDir, url } = await buildAsk();
	try {
		const tools = await loadTools(url);
		await scenarioRegistered(tools);
		await scenarioChoiceSelect(tools);
		await scenarioChoiceCancel(tools);
		await scenarioChoiceNoUi(tools);
		await scenarioChoiceEmpty(tools);
		await scenarioConfirmTrue(tools);
		await scenarioConfirmFalse(tools);
		await scenarioConfirmNoUi(tools);
	} finally {
		const fs = await import("node:fs/promises");
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
	process.exit(2);
});
