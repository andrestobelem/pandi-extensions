#!/usr/bin/env node
/**
 * Behavioral integration test for pi-auto-compact.
 *
 * Focus: the edge-triggered compaction must fire ONCE on a genuine threshold
 * crossing and must NOT re-fire every turn when a completed compaction failed to
 * bring usage back below the threshold (the re-compaction loop).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function build() {
	const { url } = await buildExtension({
		name: "pi-auto-compact-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-auto-compact", "index.ts"),
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

// Build a tool-result message with a text block of the given size (plus optional extras).
function toolResult(id, size, { isError = false, toolName = "read", extra = [] } = {}) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		isError,
		timestamp: 1,
		content: [{ type: "text", text: "X".repeat(size) }, ...extra],
	};
}

/**
 * Fake ExtensionContext. `compact` increments a counter and, on completion,
 * applies `reduceTo` (if set) to the reported usage before invoking onComplete,
 * modelling a compaction that may or may not bring usage below the threshold.
 *
 * `setStatus` calls are recorded so footer progress-bar behaviour can be
 * asserted; `theme.fg` is an identity so assertions see the raw bar text.
 */
function makeEnv({ hasUI = true, sessionId = "s1", cwd } = {}) {
	const notes = [];
	const statuses = []; // { key, text } in call order; text undefined means cleared
	// Scripted interactive dialogs: tests push responses; calls are recorded.
	const selectCalls = [];
	const inputCalls = [];
	const selectResponses = [];
	const inputResponses = [];
	const state = { percent: 0, compactCount: 0, reduceTo: null, failCompaction: false };
	// Per-env temp workspace + session manager so the snapshot path is isolated.
	const workdir = cwd ?? mkdtempSync(path.join(os.tmpdir(), "ac-snap-"));
	const ctx = {
		hasUI,
		cwd: workdir,
		sessionManager: { getSessionId: () => sessionId },
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
		compact: ({ onComplete, onError }) => {
			state.compactCount += 1;
			queueMicrotask(() => {
				// A failing compaction (LLM/network error) invokes onError WITHOUT
				// reducing usage, modelling a transient failure that leaves the
				// context untouched and still above threshold.
				if (state.failCompaction) {
					onError?.(new Error("compaction boom"));
					return;
				}
				if (state.reduceTo !== null) state.percent = state.reduceTo;
				onComplete?.();
			});
		},
	};
	return { ctx, notes, statuses, state, selectCalls, inputCalls, selectResponses, inputResponses, workdir };
}

// Recoverable-compaction snapshot helpers ----------------------------------
// The session_before_compact / session_compact events drive snapshot writing.
async function fireBeforeCompact(handlers, ctx, { branchEntries = [], reason = "threshold", willRetry = false } = {}) {
	return handlers.get("session_before_compact")?.({ branchEntries, reason, willRetry }, ctx);
}

async function fireSessionCompact(handlers, ctx, { summary = "" } = {}) {
	return handlers.get("session_compact")?.({ compactionEntry: { summary } }, ctx);
}

// The per-session snapshot directory this extension writes to.
function snapDir(env, sessionId = "s1") {
	return path.join(env.workdir, ".pi", "compaction-snapshots", sessionId);
}
function snapFiles(env, sessionId = "s1") {
	const dir = snapDir(env, sessionId);
	return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
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

// A FAILED compaction (onError) must re-arm the edge-trigger so a subsequent
// above-threshold turn retries — otherwise a single transient failure silently
// disables auto-compaction for the rest of the session (the "onError never
// re-arms" bug). Distinct from stuckAboveThresholdDoesNotLoop, where compaction
// SUCCEEDS but cannot reduce usage (there we must NOT loop).
async function failedCompactionReArmsAndRetriggers(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 60; // above the 30% default threshold
	env.state.failCompaction = true;

	await fireAgentEnd(handlers, env.ctx); // crossing -> compaction #1 attempted, fails
	await fireAgentEnd(handlers, env.ctx); // still 60% after failure -> MUST retry
	check(
		"failure: a failed compaction re-arms so the next above-threshold turn retries",
		env.state.compactCount === 2,
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
	const run = (args) => commands.get("auto-compact").handler(args, env.ctx);
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
	const run = (args) => commands.get("auto-compact").handler(args, env.ctx);
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
// Argument autocomplete: typing `/auto-compact <prefix>` offers choices.
// ---------------------------------------------------------------------------
async function argumentCompletions(url) {
	const { commands } = await loadExtension(url);
	const cmd = commands.get("auto-compact");
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
// Interactive menu: a bare `/auto-compact` in a UI session opens a
// select to choose a parameter; choices map onto the existing actions.
// ---------------------------------------------------------------------------
async function bareCommandOpensMenuAndDisables(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	env.state.percent = 15;
	await fireTurnEnd(handlers, env.ctx); // bar visible
	check("menu: bar visible before opening menu", typeof lastStatus(env) === "string");

	env.selectResponses.push("off — disable auto-compaction");
	await commands.get("auto-compact").handler("", env.ctx);
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
	await commands.get("auto-compact").handler("", env.ctx);
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
	await commands.get("auto-compact").handler("", env.ctx);
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
	await commands.get("auto-compact").handler("", env.ctx);
	check("menu: a non-UI session never opens a menu", env.selectCalls.length === 0, `calls=${env.selectCalls.length}`);
}

// ---------------------------------------------------------------------------
// Recoverable compaction: snapshots preserve the raw entries BEFORE the lossy
// summary replaces them, so compaction is recoverable rather than destructive.
// ---------------------------------------------------------------------------
async function snapshotWritesRawEntries(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	const entries = [
		{ type: "message", id: "a", message: { role: "user", content: "hello raw" } },
		{ type: "message", id: "b", message: { role: "assistant", content: "world raw" } },
	];
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: entries, reason: "threshold" });
	const files = snapFiles(env);
	check("snapshot: a JSON snapshot is written on session_before_compact", files.length === 1, `files=${files.length}`);
	if (files.length !== 1) return;
	const snap = JSON.parse(readFileSync(path.join(snapDir(env), files[0]), "utf8"));
	check(
		"snapshot: preserves every raw entry + metadata",
		snap.entryCount === 2 &&
			Array.isArray(snap.entries) &&
			snap.entries.length === 2 &&
			snap.entries[0].id === "a" &&
			snap.reason === "threshold" &&
			snap.version === 1,
		`snap=${JSON.stringify(snap).slice(0, 160)}`,
	);
	check(
		"snapshot: raw is captured before any summary exists",
		snap.summary === undefined,
		`summary=${JSON.stringify(snap.summary)}`,
	);
}

async function snapshotPatchesSummary(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ type: "message", id: "x" }] });
	await fireSessionCompact(handlers, env.ctx, { summary: "a lossy summary of x" });
	const files = snapFiles(env);
	if (files.length !== 1) {
		check("snapshot: single file to patch", false, `files=${files.length}`);
		return;
	}
	const snap = JSON.parse(readFileSync(path.join(snapDir(env), files[0]), "utf8"));
	check(
		"snapshot: session_compact patches in the produced summary (raw + summary pair)",
		snap.summary === "a lossy summary of x" && snap.entries[0].id === "x",
		`snap=${JSON.stringify(snap).slice(0, 160)}`,
	);
}

async function snapshotDisabledWritesNothing(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	await commands.get("auto-compact").handler("snapshot off", env.ctx);
	await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ type: "message", id: "z" }] });
	check("snapshot: disabled -> no file written", snapFiles(env).length === 0, `files=${snapFiles(env).length}`);
}

async function snapshotIsFailSafe(url) {
	const { handlers } = await loadExtension(url);
	const env = makeEnv();
	// Make session id resolution throw so the whole write path errors out.
	env.ctx.sessionManager = {
		getSessionId: () => {
			throw new Error("boom");
		},
	};
	let threw = false;
	let result;
	try {
		result = await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ id: "q" }] });
	} catch {
		threw = true;
	}
	check("snapshot: a write failure never throws out of the hook", !threw);
	check(
		"snapshot: the hook never cancels compaction (returns falsy)",
		result?.cancel !== true,
		`result=${JSON.stringify(result)}`,
	);
	check(
		"snapshot: a failure surfaces a warning",
		env.notes.some((n) => n.l === "warning" && /snapshot/i.test(n.m)),
		`notes=${JSON.stringify(env.notes)}`,
	);
}

async function snapshotRetentionPrunes(url) {
	const prev = process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP;
	process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP = "2";
	try {
		const { handlers } = await loadExtension(url);
		const env = makeEnv();
		for (let i = 0; i < 4; i++) {
			await fireBeforeCompact(handlers, env.ctx, { branchEntries: [{ id: `e${i}` }] });
			await new Promise((r) => setTimeout(r, 3)); // distinct ISO ms -> distinct file names
		}
		check(
			"snapshot: retention prunes to the newest keep=2",
			snapFiles(env).length === 2,
			`files=${snapFiles(env).length}`,
		);
	} finally {
		if (prev === undefined) delete process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP;
		else process.env.PI_AUTO_COMPACT_SNAPSHOT_KEEP = prev;
	}
}

// Pure-unit coverage for the exported snapshot helpers.
async function snapshotPureHelpers(url) {
	const mod = await loadModule(url);
	check(
		"parseSnapshotSetting: shares the on/off grammar",
		mod.parseSnapshotSetting("on") === true &&
			mod.parseSnapshotSetting("off") === false &&
			mod.parseSnapshotSetting("maybe") === undefined,
	);
	const keepCases = [
		["20", 20],
		["1", 1],
		["0", undefined],
		["-5", undefined],
		["1.5", undefined],
		["", undefined],
		[undefined, undefined],
	];
	for (const [input, expected] of keepCases) {
		check(
			`parseSnapshotKeep(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
			mod.parseSnapshotKeep(input) === expected,
		);
	}
	const base = path.join("/tmp/proj", ".pi", "compaction-snapshots");
	const dir = mod.snapshotDirFor("/tmp/proj", "sess/../bad id");
	const seg = path.basename(dir);
	check(
		"snapshotDirFor: collapses path separators/spaces into one safe segment under .pi",
		dir.startsWith(base) && !seg.includes("/") && !seg.includes(" ") && seg !== ".." && seg !== ".",
		`dir=${dir}`,
	);
	check(
		"snapshotDirFor: an all-dots session id (traversal) falls back to a safe segment",
		path.basename(mod.snapshotDirFor("/tmp/proj", "..")) === "session" &&
			path.basename(mod.snapshotDirFor("/tmp/proj", ".")) === "session",
		`dotdot=${mod.snapshotDirFor("/tmp/proj", "..")}`,
	);
	const name = mod.snapshotFileName("2026-06-28T10:04:04.932Z", "threshold");
	check(
		"snapshotFileName: timestamp-prefixed, safe, .json",
		name.endsWith("-threshold.json") && !name.includes(":"),
		`name=${name}`,
	);
	const snap = mod.buildSnapshot({
		sessionId: "s",
		createdAt: "t",
		reason: "manual",
		willRetry: false,
		entries: [{ id: 1 }, { id: 2 }],
	});
	check(
		"buildSnapshot: version 1, entryCount matches, summary absent",
		snap.version === 1 && snap.entryCount === 2 && snap.summary === undefined,
		`snap=${JSON.stringify(snap)}`,
	);
	// Names sort chronologically; keep=2 prunes the 3 oldest of 5.
	const names = ["5.json", "1.json", "3.json", "2.json", "4.json", "notes.txt"];
	const pruned = mod.selectSnapshotsToPrune(names, 2);
	check(
		"selectSnapshotsToPrune: returns the oldest beyond keep, ignores non-json",
		JSON.stringify(pruned) === JSON.stringify(["1.json", "2.json", "3.json"]),
		`pruned=${JSON.stringify(pruned)}`,
	);
	check("selectSnapshotsToPrune: keep=0 prunes all json", mod.selectSnapshotsToPrune(names, 0).length === 5);
}

// ---------------------------------------------------------------------------
// Tool-result clearing (research §3b): a cheaper, EPHEMERAL, non-destructive lever
// than compaction. clearOldToolResults must elide OLD large tool-result text while
// keeping recent + error results, never mutate inputs, and be idempotent.
// ---------------------------------------------------------------------------
async function clearElidesOldLargeResults(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 1, minChars: 500, headChars: 50, tailChars: 50 };
	const messages = [
		{ role: "user", content: "go" },
		toolResult("a", 5000),
		{ role: "assistant", content: [{ type: "text", text: "thinking" }] },
		toolResult("b", 300), // recent (kept by keepRecent:1)
	];
	const out = clear(messages, opts);
	check("clear: returns a new array when an old large result is elided", Array.isArray(out) && out !== messages);
	if (!Array.isArray(out)) return;
	const clearedText = out[1].content[0].text;
	check(
		"clear: old large result text is elided to head+marker+tail (much smaller)",
		clearedText.length < 400 && clearedText.length < 5000 / 4 && clearedText.includes(mod.CLEARED_SENTINEL),
		`len=${clearedText.length}`,
	);
	check(
		"clear: preserves toolCallId/toolName/isError on the elided message",
		out[1].toolCallId === "a" && out[1].toolName === "read" && out[1].isError === false,
	);
	check("clear: keeps the most recent result intact (keepRecent)", out[3].content[0].text.length === 300);
	check(
		"clear: leaves non-toolResult messages untouched (identity)",
		out[0] === messages[0] && out[2] === messages[2],
	);
}

async function clearSkipsRecentShortAndErrors(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 2, minChars: 500, headChars: 50, tailChars: 50 };
	const short = toolResult("s", 100); // below minChars
	const err = toolResult("e", 5000, { isError: true }); // error -> keep fully
	const recent1 = toolResult("r1", 5000);
	const recent2 = toolResult("r2", 5000);
	const messages = [short, err, recent1, recent2];
	const out = clear(messages, opts);
	// short stays (too small), err stays (error), recent1+recent2 stay (keepRecent:2).
	check("clear: nothing to elide here returns null (short+error+recent only)", out === null, `out=${out && "array"}`);
}

async function clearPreservesImagesAndDoesNotMutate(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 500, headChars: 50, tailChars: 50 };
	const img = { type: "image", data: "base64", mimeType: "image/png" };
	const original = toolResult("a", 5000, { extra: [img] });
	const snapshotBefore = JSON.stringify(original);
	const messages = [original];
	const out = clear(messages, opts);
	check(
		"clear: image block is preserved alongside elided text",
		!!out && out[0].content.some((b) => b.type === "image"),
	);
	check("clear: does NOT mutate the input message (originals unchanged)", JSON.stringify(original) === snapshotBefore);
	check("clear: input array is not mutated", messages[0] === original);
}

async function clearIsIdempotent(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 500, headChars: 50, tailChars: 50 };
	const messages = [toolResult("a", 5000)];
	const once = clear(messages, opts);
	check("clear: first pass elides", !!once && once[0].content[0].text.includes(mod.CLEARED_SENTINEL));
	const twice = clear(once, opts);
	check("clear: second pass is a no-op (idempotent -> null)", twice === null, `twice=${twice && "array"}`);
}

async function clearFailSafeOnMalformed(url) {
	const mod = await loadModule(url);
	const clear = mod.clearOldToolResults;
	const opts = { keepRecent: 0, minChars: 10, headChars: 50, tailChars: 50 };
	check("clear: non-array input returns null", clear(null, opts) === null && clear(undefined, opts) === null);
	check("clear: empty array returns null", clear([], opts) === null);
	check("clear: no tool results returns null", clear([{ role: "user", content: "hi" }], opts) === null);
}

// Integration: the `context` hook returns modified messages only when clearing is
// enabled (default OFF), and never throws.
async function contextHookGatedByToggle(url) {
	const { handlers, commands } = await loadExtension(url);
	const env = makeEnv();
	const ctxHandler = handlers.get("context");
	check("context: handler is registered", typeof ctxHandler === "function");
	if (typeof ctxHandler !== "function") return;
	// Default keepRecent is 3, so we need >3 tool results for the oldest to be clearable.
	const event = {
		type: "context",
		messages: [toolResult("a", 5000), toolResult("b", 5000), toolResult("c", 5000), toolResult("d", 5000)],
	};

	const whenOff = await ctxHandler(event, env.ctx);
	check(
		"context: disabled by default -> no modification",
		whenOff === undefined || whenOff == null,
		`got ${JSON.stringify(whenOff)}`,
	);

	await commands.get("auto-compact").handler("clear-tools on", env.ctx);
	const whenOn = await ctxHandler(event, env.ctx);
	check(
		"context: enabled -> returns { messages } with the old result elided",
		!!whenOn && Array.isArray(whenOn.messages) && /cleared/.test(whenOn.messages[0].content[0].text),
		`got ${whenOn && typeof whenOn}`,
	);
}

// Pinea el mapeo nivel → token de tema del footer bar (BAR_LEVEL_COLOR, named export).
// El estado urgente (over/compacting) debe usar `error` para leerse como alerta, no `accent`
// (que se comparte con selección/logo y no comunica peligro).
async function barLevelColorCases(url) {
	const mod = await loadModule(url);
	const map = mod.BAR_LEVEL_COLOR;
	check("BAR_LEVEL_COLOR: exported", map && typeof map === "object", `typeof=${typeof map}`);
	if (!map) return;
	check("BAR_LEVEL_COLOR: idle → muted", map.idle === "muted", `got ${map.idle}`);
	check("BAR_LEVEL_COLOR: near → warning", map.near === "warning", `got ${map.near}`);
	check("BAR_LEVEL_COLOR: over → error (urgent)", map.over === "error", `got ${map.over}`);
	check("BAR_LEVEL_COLOR: compacting → error (urgent)", map.compacting === "error", `got ${map.compacting}`);
}

async function main() {
	const url = await build();
	await stuckAboveThresholdDoesNotLoop(url);
	await failedCompactionReArmsAndRetriggers(url);
	await genuineRecrossRetriggers(url);
	await belowThresholdNeverCompacts(url);
	await parseThresholdEdgeCases(url);
	await renderContextBarCases(url);
	await barLevelColorCases(url);
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
	await snapshotWritesRawEntries(url);
	await snapshotPatchesSummary(url);
	await snapshotDisabledWritesNothing(url);
	await snapshotIsFailSafe(url);
	await snapshotRetentionPrunes(url);
	await snapshotPureHelpers(url);
	await clearElidesOldLargeResults(url);
	await clearSkipsRecentShortAndErrors(url);
	await clearPreservesImagesAndDoesNotMutate(url);
	await clearIsIdempotent(url);
	await clearFailSafeOnMalformed(url);
	await contextHookGatedByToggle(url);

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
