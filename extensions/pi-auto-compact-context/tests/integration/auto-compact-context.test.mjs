#!/usr/bin/env node
/**
 * Behavioral integration test for pi-auto-compact-context.
 *
 * Focus: the edge-triggered compaction must fire ONCE on a genuine threshold
 * crossing and must NOT re-fire every turn when a completed compaction failed to
 * bring usage back below the threshold (the re-compaction loop).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function build() {
	const { url } = await buildExtension({
		name: "pi-auto-compact-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-auto-compact-context", "index.ts"),
		outName: "ac.mjs",
		npx: "--no-install",
	});
	return url;
}

async function loadExtension(url) {
	const extension = await loadDefault(url);
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
	};
	extension(pi);
	return { handlers, commands };
}

/**
 * Fake ExtensionContext. `compact` increments a counter and, on completion,
 * applies `reduceTo` (if set) to the reported usage before invoking onComplete,
 * modelling a compaction that may or may not bring usage below the threshold.
 *
 * `setStatus` calls are recorded so footer progress-bar behaviour can be
 * asserted; `theme.fg` is an identity so assertions see the raw bar text.
 */
function makeEnv({ hasUI = true } = {}) {
	const notes = [];
	const statuses = []; // { key, text } in call order; text undefined means cleared
	// Scripted interactive dialogs: tests push responses; calls are recorded.
	const selectCalls = [];
	const inputCalls = [];
	const selectResponses = [];
	const inputResponses = [];
	const state = { percent: 0, compactCount: 0, reduceTo: null };
	const ctx = {
		hasUI,
		ui: {
			notify: (m, l) => notes.push({ m, l }),
			setStatus: (key, text) => statuses.push({ key, text }),
			theme: { fg: (_color, text) => text },
			select: async (title, options) => {
				selectCalls.push({ title, options });
				return selectResponses.shift();
			},
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return inputResponses.shift();
			},
		},
		getContextUsage: () => ({ percent: state.percent }),
		compact: ({ onComplete }) => {
			state.compactCount += 1;
			queueMicrotask(() => {
				if (state.reduceTo !== null) state.percent = state.reduceTo;
				onComplete?.();
			});
		},
	};
	return { ctx, notes, statuses, state, selectCalls, inputCalls, selectResponses, inputResponses };
}

// The most recent footer status text (or undefined when last cleared).
const lastStatus = (env) => (env.statuses.length ? env.statuses[env.statuses.length - 1].text : undefined);

const tick = () => new Promise((r) => setTimeout(r, 0));

async function fireAgentEnd(handlers, ctx) {
	await handlers.get("agent_end")?.(null, ctx);
	await tick(); // let queued compaction onComplete run
}

async function fireTurnEnd(handlers, ctx) {
	await handlers.get("turn_end")?.(null, ctx);
}

async function stuckAboveThresholdDoesNotLoop(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Compaction never reduces usage below the 30% default threshold.
	env.state.percent = 60;
	env.state.reduceTo = 60;

	await fireAgentEnd(handlers, env.ctx); // genuine crossing -> compaction #1
	await fireAgentEnd(handlers, env.ctx); // still 60% -> must NOT re-compact
	await fireAgentEnd(handlers, env.ctx); // still 60% -> must NOT re-compact

	check(
		"loop: compaction fires exactly once while usage stays above threshold",
		env.state.compactCount === 1,
		`compactCount=${env.state.compactCount}`,
	);
}

async function genuineRecrossRetriggers(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Compaction succeeds: brings usage down to 20% (below threshold).
	env.state.percent = 60;
	env.state.reduceTo = 20;

	await fireAgentEnd(handlers, env.ctx); // crossing -> compaction #1, now at 20%
	await fireAgentEnd(handlers, env.ctx); // 20% < 30% -> no compaction
	env.state.percent = 60; // genuine new rise above threshold
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx); // crossing again -> compaction #2

	check(
		"recross: a genuine new threshold crossing re-triggers compaction",
		env.state.compactCount === 2,
		`compactCount=${env.state.compactCount}`,
	);
}

async function belowThresholdNeverCompacts(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 20; // never crosses 30%
	await fireAgentEnd(handlers, env.ctx);
	await fireAgentEnd(handlers, env.ctx);
	check(
		"below: no compaction while under threshold",
		env.state.compactCount === 0,
		`compactCount=${env.state.compactCount}`,
	);
}

// Pure unit-level coverage for parseThreshold (named export). Imports the
// bundled module directly; does not instantiate the extension.
async function parseThresholdEdgeCases(url) {
	const mod = await loadModule(url);
	const parseThreshold = mod.parseThreshold;
	check(
		"parseThreshold: exported as a function",
		typeof parseThreshold === "function",
		`typeof=${typeof parseThreshold}`,
	);
	if (typeof parseThreshold !== "function") return;

	const cases = [
		["50", 50],
		["50%", 50],
		["0", undefined], // <= 0 rejected
		["100", undefined], // >= 100 rejected
		["", undefined],
		[undefined, undefined],
		["abc", undefined], // NaN rejected
		[" 75 ", 75], // trimmed
	];
	for (const [input, expected] of cases) {
		const actual = parseThreshold(input);
		check(
			`parseThreshold(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			actual === expected,
			`got ${JSON.stringify(actual)}`,
		);
	}
}

// Pure coverage for renderContextBar (named export): fill, label, and level.
async function renderContextBarCases(url) {
	const mod = await loadModule(url);
	const renderContextBar = mod.renderContextBar;
	check(
		"renderContextBar: exported as a function",
		typeof renderContextBar === "function",
		`typeof=${typeof renderContextBar}`,
	);
	if (typeof renderContextBar !== "function") return;

	const unknown = renderContextBar({ percent: null, thresholdPercent: 30 });
	check("renderContextBar: null usage renders nothing", unknown === null, `got ${JSON.stringify(unknown)}`);

	const low = renderContextBar({ percent: 6, thresholdPercent: 30, width: 8 });
	check(
		"renderContextBar: low usage is idle and labels usage/threshold",
		low?.level === "idle" && low?.text.includes("6%/30%"),
		`got ${JSON.stringify(low)}`,
	);

	const near = renderContextBar({ percent: 24, thresholdPercent: 30, width: 8 });
	check("renderContextBar: 0.8 of threshold is near", near?.level === "near", `got ${JSON.stringify(near)}`);

	const over = renderContextBar({ percent: 60, thresholdPercent: 30, width: 8 });
	// Fill is clamped at full (8 filled glyphs, 0 empty) and level is over.
	check(
		"renderContextBar: usage above threshold clamps to a full bar and over level",
		over?.level === "over" &&
			over?.text.includes("60%/30%") &&
			(over?.text.match(/\u25B0/g) || []).length === 8 &&
			!over?.text.includes("\u25B1"),
		`got ${JSON.stringify(over)}`,
	);

	const busy = renderContextBar({ percent: 10, thresholdPercent: 30, compacting: true });
	check(
		"renderContextBar: compacting overrides usage",
		busy?.level === "compacting" && busy?.text.includes("compacting"),
		`got ${JSON.stringify(busy)}`,
	);
}

async function parseBarSettingCases(url) {
	const mod = await loadModule(url);
	const parseBarSetting = mod.parseBarSetting;
	check(
		"parseBarSetting: exported as a function",
		typeof parseBarSetting === "function",
		`typeof=${typeof parseBarSetting}`,
	);
	if (typeof parseBarSetting !== "function") return;
	const cases = [
		["on", true],
		["ON", true],
		[" 1 ", true],
		["off", false],
		["0", false],
		["hide", false],
		[undefined, undefined],
		["maybe", undefined],
	];
	for (const [input, expected] of cases) {
		const actual = parseBarSetting(input);
		check(
			`parseBarSetting(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			actual === expected,
			`got ${JSON.stringify(actual)}`,
		);
	}
}

// Integration: the footer bar reflects usage on a normal turn, marks the
// compacting state, and can be turned off/on via the command.
async function barReflectsUsageBelowThreshold(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 15; // half of the 30% default threshold -> near
	await fireTurnEnd(handlers, env.ctx);
	const text = lastStatus(env);
	check(
		"bar: shows usage/threshold label on a normal turn",
		typeof text === "string" && text.includes("15%/30%"),
		`got ${JSON.stringify(text)}`,
	);
	check(
		"bar: renders filled/empty glyphs",
		typeof text === "string" && /[\u25B0\u25B1]/.test(text),
		`got ${JSON.stringify(text)}`,
	);
}

async function barShowsCompactingState(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 60; // crosses threshold -> compaction
	env.state.reduceTo = 20;
	await fireAgentEnd(handlers, env.ctx);
	const sawCompacting = env.statuses.some((s) => typeof s.text === "string" && s.text.includes("compacting"));
	check(
		"bar: surfaces a compacting state while compaction runs",
		sawCompacting,
		`statuses=${JSON.stringify(env.statuses.map((s) => s.text))}`,
	);
}

async function barToggleClearsAndRestores(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const run = (args) => commands.get("auto-compact-context").handler(args, env.ctx);
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx);
	check(
		"bar toggle: visible before turning off",
		typeof lastStatus(env) === "string",
		`got ${JSON.stringify(lastStatus(env))}`,
	);
	await run("bar off");
	check(
		"bar toggle: cleared when turned off",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
	await run("bar on");
	check(
		"bar toggle: restored when turned on",
		typeof lastStatus(env) === "string" && lastStatus(env).includes("15%/30%"),
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

async function barClearedWhenDisabled(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const run = (args) => commands.get("auto-compact-context").handler(args, env.ctx);
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx);
	await run("off");
	check(
		"bar: cleared when auto-compaction is disabled",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

// ---------------------------------------------------------------------------
// Argument autocomplete: typing `/auto-compact-context <prefix>` offers choices.
// ---------------------------------------------------------------------------
async function argumentCompletions(url) {
	const { commands } = await loadExtension(url);
	const cmd = commands.get("auto-compact-context");
	check("autocomplete: getArgumentCompletions is provided", typeof cmd?.getArgumentCompletions === "function");
	if (typeof cmd?.getArgumentCompletions !== "function") return;

	const all = (await cmd.getArgumentCompletions("")) ?? [];
	const values = all.map((i) => i.value);
	check(
		"autocomplete: empty prefix lists the core subcommands",
		["status", "on", "off", "run", "bar"].every((v) => values.includes(v)),
		`got ${JSON.stringify(values)}`,
	);
	check(
		"autocomplete: every item has a string value and label",
		all.every((i) => typeof i.value === "string" && typeof i.label === "string"),
	);
	check(
		"autocomplete: empty prefix offers at least one percent preset",
		all.some((i) => /^\d+$/.test(i.value)),
		`got ${JSON.stringify(values)}`,
	);

	const bar = (await cmd.getArgumentCompletions("bar")) ?? [];
	check(
		"autocomplete: 'bar' prefix surfaces bar on/off",
		bar.some((i) => i.value === "bar on") && bar.some((i) => i.value === "bar off"),
		`got ${JSON.stringify(bar.map((i) => i.value))}`,
	);

	const off = (await cmd.getArgumentCompletions("of")) ?? [];
	check(
		"autocomplete: 'of' prefix filters to off",
		off.length > 0 && off.every((i) => i.value.startsWith("of")) && off.some((i) => i.value === "off"),
		`got ${JSON.stringify(off.map((i) => i.value))}`,
	);

	const none = await cmd.getArgumentCompletions("zzz");
	check(
		"autocomplete: an unknown prefix returns null (no spurious matches)",
		none === null,
		`got ${JSON.stringify(none)}`,
	);
}

// ---------------------------------------------------------------------------
// Interactive menu: a bare `/auto-compact-context` in a UI session opens a
// select to choose a parameter; choices map onto the existing actions.
// ---------------------------------------------------------------------------
async function bareCommandOpensMenuAndDisables(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx); // bar visible
	check("menu: bar visible before opening menu", typeof lastStatus(env) === "string");

	env.selectResponses.push("off — disable auto-compaction");
	await commands.get("auto-compact-context").handler("", env.ctx);
	check(
		"menu: a bare command opens exactly one select",
		env.selectCalls.length === 1,
		`calls=${env.selectCalls.length}`,
	);
	check(
		"menu: choosing Disable turns auto-compaction off (footer bar cleared)",
		lastStatus(env) === undefined,
		`got ${JSON.stringify(lastStatus(env))}`,
	);
}

async function menuThresholdPresetSetsThreshold(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.selectResponses.push("threshold — set the compaction threshold %");
	env.selectResponses.push("50");
	await commands.get("auto-compact-context").handler("", env.ctx);
	check(
		"menu: threshold choice opens a second select for the value",
		env.selectCalls.length === 2,
		`calls=${env.selectCalls.length}`,
	);
	check(
		"menu: a preset threshold is applied (notified)",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("50%")),
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}`,
	);
}

async function menuThresholdCustomUsesInput(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv();
	env.selectResponses.push("threshold — set the compaction threshold %");
	env.selectResponses.push("custom\u2026");
	env.inputResponses.push("35");
	await commands.get("auto-compact-context").handler("", env.ctx);
	check(
		"menu: custom threshold prompts a text input",
		env.inputCalls.length === 1,
		`inputCalls=${env.inputCalls.length}`,
	);
	check(
		"menu: the custom threshold value is applied",
		env.notes.some((n) => typeof n.m === "string" && n.m.includes("35%")),
		`notes=${JSON.stringify(env.notes.map((n) => n.m))}`,
	);
}

async function bareCommandWithoutUiNeverOpensMenu(url) {
	const { commands } = await loadExtension(url);
	const env = makeEnv({ hasUI: false });
	await commands.get("auto-compact-context").handler("", env.ctx);
	check("menu: a non-UI session never opens a menu", env.selectCalls.length === 0, `calls=${env.selectCalls.length}`);
}

async function main() {
	const url = await build();
	await stuckAboveThresholdDoesNotLoop(url);
	await genuineRecrossRetriggers(url);
	await belowThresholdNeverCompacts(url);
	await parseThresholdEdgeCases(url);
	await renderContextBarCases(url);
	await parseBarSettingCases(url);
	await barReflectsUsageBelowThreshold(url);
	await barShowsCompactingState(url);
	await barToggleClearsAndRestores(url);
	await barClearedWhenDisabled(url);
	await argumentCompletions(url);
	await bareCommandOpensMenuAndDisables(url);
	await menuThresholdPresetSetsThreshold(url);
	await menuThresholdCustomUsesInput(url);
	await bareCommandWithoutUiNeverOpensMenu(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
