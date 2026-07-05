/**
 * Durable behavioral integration test for the MARKDOWN APPROVAL OVERLAY of plan.ts.
 *
 * Why this file exists (and why it is NOT a duplicate of plan-approval)
 * --------------------------------------------------------------------
 * `plan-approval.test.mjs` pins the approval HANDSHAKE + LIFECYCLE (gate lift/persist/wake)
 * by driving the confirm() fallback: its mocked ctx has no `ctx.ui.custom`, so submit_plan
 * degrades to `ctx.ui.confirm`. That proves the state machine, but it does NOT cover the NEW
 * presentation surface: when the session CAN show a custom component, submit_plan must present
 * the plan through an mdview-style scrollable Markdown OVERLAY (rendered headings/lists/code +
 * scroll) that ALSO collects the approve/reject decision — instead of the plain-text confirm.
 *
 * The consequential, invisible-to-tsc behavior this pins:
 *   1. When ctx.ui.custom exists, submit_plan uses the OVERLAY (custom is called) and does NOT
 *      fall back to confirm.
 *   2. The DECISION KEYS map safely: y / Y / Enter => APPROVE; n / N / Esc / q => REJECT. The
 *      dangerous direction — Esc/q (dismiss) accidentally APPROVING — must never happen; a
 *      dismiss is a reject (stay in plan mode), never an implicit approval.
 *   3. The overlay RENDERS the plan (its text is visible) and shows both scroll and decision hints.
 *   4. Back-compat: when ctx.ui.custom is ABSENT, submit_plan still uses confirm (unchanged).
 *
 * Same self-bootstrapping pattern as the sibling suites: esbuild the CURRENT
 * extensions/pandi-plan/index.ts to a tempdir ESM (aliasing typebox + the SDK + pi-tui to local
 * stubs), import it, and drive the REAL submit_plan tool against a mocked pi/ctx whose
 * ctx.ui.custom drives the REAL overlay component (calls the factory, captures render(), fires a
 * key, reads the done() value) — exactly like the pandi-mdview suite exercises its viewer.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/plan-approval-view.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildPlan() {
	// Same as plan-approval, plus the pi-tui stub: the approval overlay imports Markdown +
	// key helpers from @earendil-works/pi-tui (like pandi-mdview), so the bundle must resolve it.
	return await buildExtension({
		name: "pi-plan-approval-view-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "index.ts"),
		outName: "plan.mjs",
		stubs: { typebox: true, tui: true, sdk: (dir) => sdkStub(dir) },
	});
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const execCalls = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async (command, args, options) => {
			execCalls.push({ command, args, options });
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};
	return { pi, tools, commands, handlers, entries, sentMessages, execCalls };
}

function makeTheme() {
	const id = (_color, text) => text;
	return {
		fg: id,
		bg: id,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		inverse: (text) => text,
		strikethrough: (text) => text,
	};
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function findFiles(dir, predicate) {
	const found = [];
	async function walk(current) {
		let entries;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (predicate(full)) found.push(full);
		}
	}
	await walk(dir);
	return found;
}

// makeCtx variants:
//   - withCustom=true  → ctx.ui.custom drives the REAL overlay component and presses `decisionKey`.
//   - withCustom=false → no ctx.ui.custom (exercises the confirm fallback / back-compat).
// A confirm() is always present so a scenario can assert it was NOT consulted when the overlay is used.
function makeCtx({
	mode = "tui",
	hasUI = true,
	cwd = REPO_ROOT,
	withCustom = true,
	decisionKey = "y",
	rows = 20,
	width = 80,
} = {}) {
	const notes = [];
	const customCalls = [];
	const theme = makeTheme();
	const tui = {
		terminal: { columns: width, rows },
		requestRender() {},
	};
	const ui = {
		theme,
		notify: (msg, type) => notes.push({ msg, type }),
		setStatus: () => {},
		confirm: async () => {
			ctx._confirmCalls += 1;
			const r = ctx._confirmResult;
			return typeof r === "function" ? r() : r;
		},
		select: async () => undefined,
	};
	if (withCustom) {
		ui.custom = async (factory) => {
			const call = { closed: false, value: undefined, firstRender: undefined };
			customCalls.push(call);
			const component = await factory(tui, theme, {}, (value) => {
				call.closed = true;
				call.value = value;
			});
			call.firstRender = component.render(width);
			component.handleInput?.(decisionKey);
			if (!call.closed) throw new Error(`approval overlay did not close on key: ${decisionKey}`);
			return call.value;
		};
	}
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui,
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	ctx._customCalls = customCalls;
	ctx._confirmCalls = 0;
	ctx._confirmResult = true;
	return ctx;
}

function toolCallEvent(toolName, input = {}) {
	return { type: "tool_call", toolCallId: `tc-${Math.random().toString(16).slice(2)}`, toolName, input };
}
async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res?.block) return res;
	}
	return undefined;
}
async function writeBlocked(handlers, ctx) {
	const r = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
	return !!r && r.block === true;
}

// ===========================================================================
// SCENARIO A: the overlay is used (not confirm), RENDERS the plan, and shows hints.
// ===========================================================================
async function overlayPresentsAndRenders(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, tools, handlers, sentMessages, execCalls } = makePi();
	planExtension(pi);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "plan-html-"));
	const ctx = makeCtx({ decisionKey: "y", cwd });

	await commands.get("plan").handler("design a feature", ctx);
	check("overlay: write BLOCKED while planning", await writeBlocked(handlers, ctx));

	const planText = "# My Plan\n\n1. Do the thing\n2. Verify it";
	const beforeSubmit = sentMessages.length;
	const res = await tools.get("submit_plan").execute("tc1", { plan: planText }, undefined, undefined, ctx);

	check("overlay: ctx.ui.custom was used to present the plan", ctx._customCalls.length === 1);
	check("overlay: confirm was NOT consulted when the overlay is available", ctx._confirmCalls === 0);

	const htmlFiles = await findFiles(path.join(cwd, ".pi", "plan-artifacts"), (file) => file.endsWith(".html"));
	check("html: writes one plan preview artifact", htmlFiles.length === 1, `got ${JSON.stringify(htmlFiles)}`);
	const html = htmlFiles[0] ? await fs.readFile(htmlFiles[0], "utf8") : "";
	check("html: rendered artifact contains the plan body", /Do the thing/.test(html), html.slice(0, 200));
	check("html: rendered artifact uses the Pandi plan kicker", /Pandi plan/.test(html), html.slice(0, 200));
	check("html: opens the rendered artifact in a browser", execCalls.length === 1, JSON.stringify(execCalls));
	check(
		"html: browser open points at the artifact",
		execCalls[0]?.args?.includes(htmlFiles[0]),
		JSON.stringify(execCalls[0]),
	);

	const rendered = stripAnsi((ctx._customCalls[0].firstRender || []).join("\n"));
	check("overlay: renders the plan body text", /Do the thing/.test(rendered), rendered);
	check("overlay: shows a scroll hint", /desplazar/i.test(rendered), rendered);
	check("overlay: shows approve + reject hints", /aprobar/i.test(rendered) && /rechazar/i.test(rendered), rendered);

	// 'y' approved → gate lifts, status approved, implement re-injected.
	check("overlay: write ALLOWED after 'y' approval", !(await writeBlocked(handlers, ctx)));
	check("overlay: tool result status=approved", res?.details && res.details.status === "approved");
	const wake = sentMessages[sentMessages.length - 1];
	check("overlay: implement message re-injected after approval", sentMessages.length === beforeSubmit + 1);
	check("overlay: implement message carries the plan text", wake?.content.includes(planText));
}

// ===========================================================================
// SCENARIO B: decision keys map safely. y / Enter => APPROVE; n / Esc / q => REJECT.
// The dangerous direction (Esc/q accidentally approving) must never happen.
// ===========================================================================
async function decisionKeysMapSafely(url) {
	async function decide(decisionKey) {
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, handlers } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ decisionKey });
		await commands.get("plan").handler("design a feature", ctx);
		const res = await tools.get("submit_plan").execute("tc1", { plan: "# P\n1. step" }, undefined, undefined, ctx);
		const gateLifted = !(await writeBlocked(handlers, ctx));
		return { status: res?.details?.status, gateLifted, confirmCalls: ctx._confirmCalls };
	}

	for (const key of ["y", "Y", "enter"]) {
		const r = await decide(key);
		check(`decision: '${key}' APPROVES (status=approved, gate lifted)`, r.status === "approved" && r.gateLifted);
		check(`decision: '${key}' did not touch confirm`, r.confirmCalls === 0);
	}
	for (const key of ["n", "N", "escape", "q"]) {
		const r = await decide(key);
		check(`decision: '${key}' REJECTS (status=rejected, gate STILL armed)`, r.status === "rejected" && !r.gateLifted);
		check(`decision: '${key}' did not touch confirm`, r.confirmCalls === 0);
	}
}

// ===========================================================================
// SCENARIO C: back-compat — with NO ctx.ui.custom, submit_plan still uses confirm.
// ===========================================================================
async function fallsBackToConfirmWithoutCustom(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, tools, handlers } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ withCustom: false });
	ctx._confirmResult = true;

	await commands.get("plan").handler("design a feature", ctx);
	const res = await tools.get("submit_plan").execute("tc1", { plan: "# P\n1. step" }, undefined, undefined, ctx);

	check("fallback: no overlay attempted (custom absent)", ctx._customCalls.length === 0);
	check("fallback: confirm WAS consulted", ctx._confirmCalls === 1);
	check("fallback: approval via confirm still lifts the gate", !(await writeBlocked(handlers, ctx)));
	check("fallback: tool result status=approved", res?.details && res.details.status === "approved");
}

async function main() {
	const { outDir, url } = await buildPlan();
	try {
		await overlayPresentsAndRenders(url);
		await decisionKeysMapSafely(url);
		await fallsBackToConfirmWithoutCustom(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
