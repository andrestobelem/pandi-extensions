/**
 * Durable CHARACTERIZATION suite for extensions/pandi-plan/dashboard.ts.
 *
 * dashboard.ts is the PURE render kernel of `/plan dashboard` plus the TUI scroll
 * overlay. The existing plan-approval suite only touches the dashboard THROUGH the
 * command (it prints the Markdown once). This suite pins the dashboard's own
 * exported surface directly:
 *
 *   - buildPlanDashboardMarkdown([])      → the empty-session message + no History table.
 *   - buildPlanDashboardMarkdown(plans)   → header session totals (plans/active/submitted/rejected).
 *   - the "Active" detail section + the <details> "Last submitted plan" block (present iff lastPlan).
 *   - stable oldest-first sort by startedAt, and that the INPUT array is not mutated.
 *   - renderPlanDashboardOverlay scroll/page/g/G/quit key handling + viewport clamping,
 *     driven through a fake `ctx.ui.custom` that captures the overlay component.
 *   - renderPlanDashboardOverlay degrades a `ctx.ui.custom` failure to a `warning` notify
 *     (and never rejects).
 *
 * dashboard.ts imports only `import type` from the SDK plus the pure `notify` helper,
 * so it bundles with NO stubs. We import the NAMED exports (loadModule) and call them
 * directly — never a copy of internals — so the suite tracks the source.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/dashboard-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Build dashboard.ts directly (named exports). It only `import type`s the SDK and
// pulls in the pure notify helper, so it needs NO stubs.
// ---------------------------------------------------------------------------
async function buildDashboard() {
	return await buildExtension({
		name: "pi-plan-dashboard-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "dashboard.ts"),
		outName: "dashboard.mjs",
		stubs: {},
	});
}

// A full PlanSnapshot with sane defaults; override per case.
function snap(overrides = {}) {
	return {
		planId: "p",
		task: "some task",
		active: false,
		status: "planning",
		submissions: 0,
		rejections: 0,
		startedAt: 1,
		updatedAt: "1970-01-01T00:00:01.000Z",
		...overrides,
	};
}

// ===========================================================================
// 1. Empty plans → the "nothing yet" message, title, and NO History table.
// ===========================================================================
function emptyPlans(mod) {
	const out = mod.buildPlanDashboardMarkdown([]);
	check("empty: contains the dashboard title", /# Tablero de Modo Plan/.test(out));
	check(
		"empty: contains the 'no hay planes registrados' message",
		out.includes("Todavía no hay planes registrados en esta sesión"),
	);
	check("empty: does NOT render a History section", !out.includes("## History"));
	check("empty: does NOT render a session-totals line", !/\*\*Plans:\*\*/.test(out));
}

// ===========================================================================
// 2. Header session totals: plans / active / submitted / rejected.
// ===========================================================================
function headerTotals(mod) {
	const out = mod.buildPlanDashboardMarkdown([
		snap({ planId: "a", submissions: 2, rejections: 1, active: true }),
		snap({ planId: "b", submissions: 3, rejections: 0, active: false }),
	]);
	check("totals: Plans count = 2", out.includes("**Plans:** 2"));
	check("totals: active count = 1", out.includes("**active:** 1"));
	check("totals: submitted total = 5", out.includes("**submitted:** 5"));
	check("totals: rejected total = 1", out.includes("**rejected:** 1"));
}

// ===========================================================================
// 3. Active detail section + the <details> "Last submitted plan" block.
// ===========================================================================
function activeSection(mod) {
	const withPlan = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "step1" }),
	]);
	check(
		"active: renders the 'gate de solo lectura ARMADO' header",
		withPlan.includes("(gate de solo lectura ARMADO)"),
	);
	check(
		"active: opens a <details> 'Último plan enviado' block",
		withPlan.includes("<details><summary>Último plan enviado</summary>"),
	);
	check("active: includes the lastPlan text verbatim", withPlan.includes("step1"));
	check("active: closes the <details> block", withPlan.includes("</details>"));

	const noPlan = mod.buildPlanDashboardMarkdown([snap({ planId: "act", active: true, status: "planned" })]);
	check("active(no lastPlan): still renders the ARMED header", noPlan.includes("(gate de solo lectura ARMADO)"));
	check(
		"active(no lastPlan): omits the <details> block",
		!noPlan.includes("<details><summary>Último plan enviado</summary>"),
	);
}

// ===========================================================================
// 4. Stable oldest-first sort by startedAt; the INPUT array is not mutated.
// ===========================================================================
function stableSort(mod) {
	const input = [snap({ planId: "late", startedAt: 200 }), snap({ planId: "early", startedAt: 100 })];
	const out = mod.buildPlanDashboardMarkdown(input);
	const earlyIdx = out.indexOf("| early |");
	const lateIdx = out.indexOf("| late |");
	check("sort: both plan rows are present in History", earlyIdx !== -1 && lateIdx !== -1);
	check("sort: the earlier (startedAt=100) row precedes the later (startedAt=200) row", earlyIdx < lateIdx);
	check(
		"sort: the input array order is unchanged after the call",
		input[0].planId === "late" && input[1].planId === "early",
	);
}

// ===========================================================================
// 4b. extractPlanChecklist: GFM task-list state is respected; otherwise steps are
//     derived (ordered list -> bullet list -> ## / ### headings); else [].
// ===========================================================================
function checklistExtraction(mod) {
	// GFM task list: checked state honored, surrounding prose ignored.
	const gfm = mod.extractPlanChecklist("intro\n- [x] done one\n- [ ] todo two\n- [X] done three\noutro");
	check("checklist(gfm): three items", gfm.length === 3, JSON.stringify(gfm));
	check(
		"checklist(gfm): first checked",
		gfm[0].checked === true && gfm[0].text === "done one",
		JSON.stringify(gfm[0]),
	);
	check(
		"checklist(gfm): second unchecked",
		gfm[1].checked === false && gfm[1].text === "todo two",
		JSON.stringify(gfm[1]),
	);
	check("checklist(gfm): uppercase X counts as checked", gfm[2].checked === true, JSON.stringify(gfm[2]));

	// Ordered list fallback (no task-list markers) -> all unchecked, in order.
	const ordered = mod.extractPlanChecklist("# Plan\n1. first step\n2. second step\n3. third step");
	check(
		"checklist(ordered): three unchecked steps",
		ordered.length === 3 && ordered.every((s) => s.checked === false),
		JSON.stringify(ordered),
	);
	check(
		"checklist(ordered): preserves order + text",
		ordered[0].text === "first step" && ordered[2].text === "third step",
		JSON.stringify(ordered),
	);

	// Bullet list fallback.
	const bullets = mod.extractPlanChecklist("- alpha\n- beta");
	check(
		"checklist(bullets): two unchecked steps",
		bullets.length === 2 && bullets[0].text === "alpha",
		JSON.stringify(bullets),
	);

	// Heading fallback when there are no list items at all.
	const headings = mod.extractPlanChecklist("# Title\n## Phase 1\nprose\n### Phase 1a\n## Phase 2");
	check(
		"checklist(headings): derives steps from ##/### headings",
		headings.length === 3 && headings[0].text === "Phase 1",
		JSON.stringify(headings),
	);
	check(
		"checklist(headings): all unchecked",
		headings.every((s) => s.checked === false),
		JSON.stringify(headings),
	);

	// Nothing parseable -> empty.
	const none = mod.extractPlanChecklist("just a paragraph of prose with no structure");
	check("checklist(none): empty array", Array.isArray(none) && none.length === 0, JSON.stringify(none));
	check("checklist(empty input): empty array", mod.extractPlanChecklist("").length === 0);
}

// ===========================================================================
// 4c. Active section renders a Claude-style checklist from the active plan's
//     lastPlan: a "Checklist (n/m done)" header + GFM `- [ ]`/`- [x]` lines.
// ===========================================================================
function checklistRendering(mod) {
	const withSteps = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "1. write code\n2. run tests\n3. ship" }),
	]);
	check(
		"render-checklist: shows a Checklist header with a done count",
		/Checklist \(0\/3 listos\)/.test(withSteps),
		withSteps,
	);
	check("render-checklist: renders unchecked GFM items", withSteps.includes("- [ ] write code"), withSteps);

	const withProgress = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "- [x] done\n- [ ] pending" }),
	]);
	check("render-checklist: counts completed items", /Checklist \(1\/2 listos\)/.test(withProgress), withProgress);
	check("render-checklist: keeps the checked box", withProgress.includes("- [x] done"), withProgress);
	check("render-checklist: keeps the unchecked box", withProgress.includes("- [ ] pending"), withProgress);

	// Active plan with a lastPlan but no parseable steps -> a note, not a broken header.
	const noSteps = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "just prose, no steps" }),
	]);
	check("render-checklist(no steps): no done-count header", !/Checklist \(\d+\/\d+ listos\)/.test(noSteps), noSteps);
	check("render-checklist(no steps): shows a no-steps note", /No se pudo extraer ningún paso/i.test(noSteps), noSteps);
}

// ---------------------------------------------------------------------------
// Overlay harness: a fake ctx whose ui.custom captures the overlay component so we
// can drive its render()/handleInput() directly. `custom` resolves immediately.
// ---------------------------------------------------------------------------
function makeOverlayCtx({ rows = 10, customThrows = null } = {}) {
	const state = { component: undefined, done: { called: false, arg: "__unset__" }, renderRequests: 0, notes: [] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (msg, type) => state.notes.push({ msg, type }),
			custom: async (factory) => {
				if (customThrows) throw customThrows;
				const fakeTui = {
					terminal: { rows },
					requestRender: () => {
						state.renderRequests += 1;
					},
				};
				const done = (arg) => {
					state.done.called = true;
					state.done.arg = arg;
				};
				state.component = factory(fakeTui, {}, {}, done);
				return undefined;
			},
		},
	};
	return { ctx, state };
}

// ===========================================================================
// 5. Overlay: scroll/page/g/G/quit key handling + viewport clamping.
// ===========================================================================
async function overlayScrolling(mod) {
	const md = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n"); // 50 lines
	const { ctx, state } = makeOverlayCtx({ rows: 10 });
	await mod.renderPlanDashboardOverlay(ctx, md);
	const c = state.component;
	check(
		"overlay: ctx.ui.custom yielded a component",
		!!c && typeof c.render === "function" && typeof c.handleInput === "function",
	);

	// rows=10, FIXED=5 → bodyHeight=5. Initial render shows the first 5 lines.
	const initial = c.render(100);
	check(
		"overlay: initial footer shows 1-5/50",
		initial.some((l) => l.includes("1-5/50")),
	);
	check(
		"overlay: initial body shows the first line (line-0)",
		initial.some((l) => l.includes("line-0")),
	);

	// 'G' → jump to bottom; render clamps to the last bodyHeight lines (46-50/50).
	c.handleInput("G");
	const bottom = c.render(100);
	check(
		"overlay: G footer shows the last page 46-50/50",
		bottom.some((l) => l.includes("46-50/50")),
	);
	check(
		"overlay: G shows the last line (line-49)",
		bottom.some((l) => l.includes("line-49")),
	);
	check("overlay: G does NOT show the first line (line-0)", !bottom.some((l) => l.includes("line-0")));

	// 'g' → back to top.
	c.handleInput("g");
	const top = c.render(100);
	check(
		"overlay: g returns to the top (1-5/50)",
		top.some((l) => l.includes("1-5/50")),
	);

	// space → page down by (bodyHeight-1)=4 → start at line-4 (footer 5-9/50).
	c.handleInput(" ");
	const paged = c.render(100);
	check(
		"overlay: space pages down to 5-9/50",
		paged.some((l) => l.includes("5-9/50")),
	);

	// 'k' from a low scroll clamps at the top (cannot go above 0).
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	const clampedTop = c.render(100);
	check(
		"overlay: scrolling up past the top clamps at 1-5/50",
		clampedTop.some((l) => l.includes("1-5/50")),
	);

	// An unrecognized key is ignored: it must NOT trigger a render request.
	const before = state.renderRequests;
	c.handleInput("z");
	check("overlay: an unknown key does not request a render", state.renderRequests === before);

	// A recognized scroll key DOES request a render.
	c.handleInput("j");
	check("overlay: a recognized key requests a render", state.renderRequests === before + 1);

	// render always emits FIXED(5 chrome) + bodyHeight(5) = 10 rows.
	check("overlay: render emits the chrome + body rows (10)", c.render(100).length === 10);

	// invalidate() is a no-op that must not throw.
	let invalidateThrew = false;
	try {
		c.invalidate();
	} catch {
		invalidateThrew = true;
	}
	check("overlay: invalidate() is a safe no-op", !invalidateThrew);

	// 'q' closes via done(undefined).
	c.handleInput("q");
	check("overlay: q calls done(undefined)", state.done.called === true && state.done.arg === undefined);
}

async function overlayEscQuits(mod) {
	const md = Array.from({ length: 10 }, (_, i) => `row-${i}`).join("\n");
	const { ctx, state } = makeOverlayCtx({ rows: 24 });
	await mod.renderPlanDashboardOverlay(ctx, md);
	state.component.handleInput("\u001b"); // Esc
	check("overlay: Esc calls done(undefined)", state.done.called === true && state.done.arg === undefined);
}

// ===========================================================================
// 6. Overlay: a ctx.ui.custom failure degrades to a single 'warning' notify and
//    the promise resolves (no throw).
// ===========================================================================
async function overlayDegradesOnFailure(mod) {
	const { ctx, state } = makeOverlayCtx({ customThrows: new Error("boom") });
	let threw = false;
	try {
		await mod.renderPlanDashboardOverlay(ctx, "irrelevant");
	} catch {
		threw = true;
	}
	check("overlay-fail: renderPlanDashboardOverlay resolves (does not reject)", !threw);
	check("overlay-fail: notify invoked exactly once", state.notes.length === 1);
	check(
		"overlay-fail: notify message includes 'No se pudo abrir el tablero de plan: boom'",
		state.notes[0]?.msg?.includes("No se pudo abrir el tablero de plan: boom"),
	);
	check("overlay-fail: notify level is 'warning'", state.notes[0]?.type === "warning");
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildDashboard();
	try {
		const mod = await loadModule(url);
		emptyPlans(mod);
		headerTotals(mod);
		activeSection(mod);
		stableSort(mod);
		checklistExtraction(mod);
		checklistRendering(mod);
		await overlayScrolling(mod);
		await overlayEscQuits(mod);
		await overlayDegradesOnFailure(mod);
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
