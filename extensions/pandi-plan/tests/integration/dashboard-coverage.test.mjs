/**
 * Suite de CARACTERIZACIÓN durable para extensions/pandi-plan/dashboard.ts.
 *
 * dashboard.ts es el kernel PURO de render de `/plan dashboard` más el overlay de
 * scroll para la TUI. La suite existente de aprobación de planes solo toca el
 * dashboard A TRAVÉS del comando (imprime el Markdown una vez). Esta suite pinnea
 * directamente la superficie exportada propia del dashboard:
 *
 *   - buildPlanDashboardMarkdown([])      → el mensaje de sesión vacía + sin tabla History.
 *   - buildPlanDashboardMarkdown(plans)   → totales del encabezado de sesión (planes/activos/enviados/rechazados).
 *   - la sección de detalle "Active" + el bloque <details> "Last submitted plan" (presente solo si hay lastPlan).
 *   - orden estable del más viejo al más nuevo por startedAt, y que el array de ENTRADA no se muta.
 *   - renderPlanDashboardOverlay scroll/page/g/G/quit key handling + clamp del viewport,
 *     manejado vía un `ctx.ui.custom` fake que captura el componente del overlay.
 *   - renderPlanDashboardOverlay degrada una falla de `ctx.ui.custom` a un notify
 *     `warning` (y nunca rechaza).
 *
 * dashboard.ts importa solo `import type` del SDK más el helper puro `notify`, así
 * que bundlea SIN stubs. Importamos los exports NOMBRADOS (`loadModule`) y los
 * llamamos directo — nunca una copia de internos — para que la suite siga a la fuente.
 *
 * Ejecutar:    node extensions/pandi-plan/tests/integration/dashboard-coverage.test.mjs
 * Código de salida: 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = se cayó el harness.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-plan/tests/integration/ -> la raíz del repo queda cuatro niveles arriba.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Construye dashboard.ts directo (exports nombrados). Solo hace `import type` del
// SDK y trae el helper puro notify, así que NO necesita stubs.
// ---------------------------------------------------------------------------
async function buildDashboard() {
	return await buildExtension({
		name: "pi-plan-dashboard-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "dashboard.ts"),
		outName: "dashboard.mjs",
		stubs: {},
	});
}

// Un PlanSnapshot completo con defaults razonables; cada caso pisa lo necesario.
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
// 1. Planes vacíos → mensaje de “todavía nada”, título y SIN tabla History.
// ===========================================================================
function emptyPlans(mod) {
	const out = mod.buildPlanDashboardMarkdown([]);
	check("empty: contiene el título del tablero", /# Tablero de Modo Plan/.test(out));
	check(
		"empty: contiene el mensaje 'no hay planes registrados'",
		out.includes("Todavía no hay planes registrados en esta sesión"),
	);
	check("empty: NO renderiza una sección History", !out.includes("## History"));
	check("empty: NO renderiza una línea de totales de sesión", !/\*\*Plans:\*\*/.test(out));
}

// ===========================================================================
// 2. Totales del encabezado de sesión: planes / activos / enviados / rechazados.
// ===========================================================================
function headerTotals(mod) {
	const out = mod.buildPlanDashboardMarkdown([
		snap({ planId: "a", submissions: 2, rejections: 1, active: true }),
		snap({ planId: "b", submissions: 3, rejections: 0, active: false }),
	]);
	check("totals: cantidad de planes = 2", out.includes("**Planes:** 2"));
	check("totals: cantidad de activos = 1", out.includes("**activos:** 1"));
	check("totals: total enviados = 5", out.includes("**enviados:** 5"));
	check("totals: total rechazados = 1", out.includes("**rechazados:** 1"));
}

// ===========================================================================
// 3. Sección de detalle activa + bloque <details> de "Último plan enviado".
// ===========================================================================
function activeSection(mod) {
	const withPlan = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "step1" }),
	]);
	check(
		"active: renderiza el encabezado 'gate de solo lectura ARMADO'",
		withPlan.includes("(gate de solo lectura ARMADO)"),
	);
	check(
		"active: abre un bloque <details> de 'Último plan enviado'",
		withPlan.includes("<details><summary>Último plan enviado</summary>"),
	);
	check("active: incluye el texto de lastPlan literal", withPlan.includes("step1"));
	check("active: cierra el bloque <details>", withPlan.includes("</details>"));

	const noPlan = mod.buildPlanDashboardMarkdown([snap({ planId: "act", active: true, status: "planned" })]);
	check("active(no lastPlan): igual renderiza el encabezado ARMADO", noPlan.includes("(gate de solo lectura ARMADO)"));
	check(
		"active(no lastPlan): omite el bloque <details>",
		!noPlan.includes("<details><summary>Último plan enviado</summary>"),
	);
}

// ===========================================================================
// 4. Orden estable del más viejo al más nuevo por startedAt; no se muta el array de entrada.
// ===========================================================================
function stableSort(mod) {
	const input = [snap({ planId: "late", startedAt: 200 }), snap({ planId: "early", startedAt: 100 })];
	const out = mod.buildPlanDashboardMarkdown(input);
	const earlyIdx = out.indexOf("| early |");
	const lateIdx = out.indexOf("| late |");
	check("sort: ambas filas de planes están presentes en History", earlyIdx !== -1 && lateIdx !== -1);
	check("sort: la fila anterior (startedAt=100) aparece antes que la posterior (startedAt=200)", earlyIdx < lateIdx);
	check(
		"sort: el orden del array de entrada no cambia después de la llamada",
		input[0].planId === "late" && input[1].planId === "early",
	);
}

// ===========================================================================
// 4b. extractPlanChecklist: respeta el estado de la task-list GFM; si no,
//     deriva pasos (lista ordenada -> bullet list -> headings ## / ###); si no, [].
// ===========================================================================
function checklistExtraction(mod) {
	// Task list GFM: respeta el estado checked e ignora la prosa alrededor.
	const gfm = mod.extractPlanChecklist("intro\n- [x] done one\n- [ ] todo two\n- [X] done three\noutro");
	check("checklist(gfm): tres items", gfm.length === 3, JSON.stringify(gfm));
	check(
		"checklist(gfm): el primero está checked",
		gfm[0].checked === true && gfm[0].text === "done one",
		JSON.stringify(gfm[0]),
	);
	check(
		"checklist(gfm): el segundo está unchecked",
		gfm[1].checked === false && gfm[1].text === "todo two",
		JSON.stringify(gfm[1]),
	);
	check("checklist(gfm): X mayúscula cuenta como checked", gfm[2].checked === true, JSON.stringify(gfm[2]));

	// Fallback de lista ordenada (sin task-list markers) -> todos unchecked, en orden.
	const ordered = mod.extractPlanChecklist("# Plan\n1. first step\n2. second step\n3. third step");
	check(
		"checklist(ordered): tres pasos unchecked",
		ordered.length === 3 && ordered.every((s) => s.checked === false),
		JSON.stringify(ordered),
	);
	check(
		"checklist(ordered): preserva orden + texto",
		ordered[0].text === "first step" && ordered[2].text === "third step",
		JSON.stringify(ordered),
	);

	// Fallback de bullet list.
	const bullets = mod.extractPlanChecklist("- alpha\n- beta");
	check(
		"checklist(bullets): dos pasos unchecked",
		bullets.length === 2 && bullets[0].text === "alpha",
		JSON.stringify(bullets),
	);

	// Fallback de headings cuando no hay items de lista.
	const headings = mod.extractPlanChecklist("# Title\n## Phase 1\nprose\n### Phase 1a\n## Phase 2");
	check(
		"checklist(headings): deriva pasos desde headings ##/###",
		headings.length === 3 && headings[0].text === "Phase 1",
		JSON.stringify(headings),
	);
	check(
		"checklist(headings): todos unchecked",
		headings.every((s) => s.checked === false),
		JSON.stringify(headings),
	);

	// Nada parseable -> vacío.
	const none = mod.extractPlanChecklist("just a paragraph of prose with no structure");
	check("checklist(none): array vacío", Array.isArray(none) && none.length === 0, JSON.stringify(none));
	check("checklist(empty input): array vacío", mod.extractPlanChecklist("").length === 0);
}

// ===========================================================================
// 4c. La sección activa renderiza un checklist estilo Claude desde el lastPlan
//     activo: encabezado "Checklist (n/m done)" + líneas GFM `- [ ]`/`- [x]`.
// ===========================================================================
function checklistRendering(mod) {
	const withSteps = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "1. write code\n2. run tests\n3. ship" }),
	]);
	check(
		"render-checklist: muestra un encabezado Checklist con contador de listos",
		/Checklist \(0\/3 listos\)/.test(withSteps),
		withSteps,
	);
	check("render-checklist: renderiza items GFM unchecked", withSteps.includes("- [ ] write code"), withSteps);

	const withProgress = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "- [x] done\n- [ ] pending" }),
	]);
	check("render-checklist: cuenta items completados", /Checklist \(1\/2 listos\)/.test(withProgress), withProgress);
	check("render-checklist: conserva la caja checked", withProgress.includes("- [x] done"), withProgress);
	check("render-checklist: conserva la caja unchecked", withProgress.includes("- [ ] pending"), withProgress);

	// Plan activo con lastPlan pero sin pasos parseables -> nota, no encabezado roto.
	const noSteps = mod.buildPlanDashboardMarkdown([
		snap({ planId: "act", active: true, status: "planned", lastPlan: "just prose, no steps" }),
	]);
	check(
		"render-checklist(no steps): no muestra encabezado con contador",
		!/Checklist \(\d+\/\d+ listos\)/.test(noSteps),
		noSteps,
	);
	check(
		"render-checklist(no steps): muestra una nota de ausencia de pasos",
		/No se pudo extraer ningún paso/i.test(noSteps),
		noSteps,
	);
}

// ---------------------------------------------------------------------------
// Harness del overlay: un ctx fake cuyo ui.custom captura el componente para poder
// manejar su render()/handleInput() directo. `custom` resuelve enseguida.
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
// 5. Overlay: manejo de teclas scroll/page/g/G/quit + clamp del viewport.
// ===========================================================================
async function overlayScrolling(mod) {
	const md = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n"); // 50 líneas
	const { ctx, state } = makeOverlayCtx({ rows: 10 });
	await mod.renderPlanDashboardOverlay(ctx, md);
	const c = state.component;
	check(
		"overlay: ctx.ui.custom entregó un componente",
		!!c && typeof c.render === "function" && typeof c.handleInput === "function",
	);

	// rows=10, FIXED=5 → bodyHeight=5. El render inicial muestra las primeras 5 líneas.
	const initial = c.render(100);
	check(
		"overlay: el footer inicial muestra 1-5/50",
		initial.some((l) => l.includes("1-5/50")),
	);
	check(
		"overlay: el cuerpo inicial muestra la primera línea (line-0)",
		initial.some((l) => l.includes("line-0")),
	);

	// 'G' → salta al fondo; el render clampa a las últimas bodyHeight líneas (46-50/50).
	c.handleInput("G");
	const bottom = c.render(100);
	check(
		"overlay: el footer de G muestra la última página 46-50/50",
		bottom.some((l) => l.includes("46-50/50")),
	);
	check(
		"overlay: G muestra la última línea (line-49)",
		bottom.some((l) => l.includes("line-49")),
	);
	check("overlay: G NO muestra la primera línea (line-0)", !bottom.some((l) => l.includes("line-0")));

	// 'g' → vuelve arriba.
	c.handleInput("g");
	const top = c.render(100);
	check(
		"overlay: g vuelve arriba (1-5/50)",
		top.some((l) => l.includes("1-5/50")),
	);

	// espacio → page down de (bodyHeight-1)=4 → arranca en line-4 (footer 5-9/50).
	c.handleInput(" ");
	const paged = c.render(100);
	check(
		"overlay: espacio pagina hacia abajo hasta 5-9/50",
		paged.some((l) => l.includes("5-9/50")),
	);

	// 'k' desde un scroll bajo clampa arriba (no puede subir de 0).
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	const clampedTop = c.render(100);
	check(
		"overlay: al scrollear por arriba del tope clampa en 1-5/50",
		clampedTop.some((l) => l.includes("1-5/50")),
	);

	// Una tecla no reconocida se ignora: NO debe pedir render.
	const before = state.renderRequests;
	c.handleInput("z");
	check("overlay: una tecla desconocida no pide render", state.renderRequests === before);

	// Una tecla de scroll reconocida SÍ pide render.
	c.handleInput("j");
	check("overlay: una tecla reconocida pide render", state.renderRequests === before + 1);

	// render siempre emite FIXED(5 chrome) + bodyHeight(5) = 10 filas.
	check("overlay: render emite el chrome + filas del cuerpo (10)", c.render(100).length === 10);

	// invalidate() es no-op y no debe tirar.
	let invalidateThrew = false;
	try {
		c.invalidate();
	} catch {
		invalidateThrew = true;
	}
	check("overlay: invalidate() es un no-op seguro", !invalidateThrew);

	// 'q' cierra vía done(undefined).
	c.handleInput("q");
	check("overlay: q llama done(undefined)", state.done.called === true && state.done.arg === undefined);
}

async function overlayEscQuits(mod) {
	const md = Array.from({ length: 10 }, (_, i) => `row-${i}`).join("\n");
	const { ctx, state } = makeOverlayCtx({ rows: 24 });
	await mod.renderPlanDashboardOverlay(ctx, md);
	state.component.handleInput("\u001b"); // Esc
	check("overlay: Esc llama done(undefined)", state.done.called === true && state.done.arg === undefined);
}

// ===========================================================================
// 6. Overlay: una falla de ctx.ui.custom degrada a un único notify 'warning' y
//    la promesa resuelve (sin throw).
// ===========================================================================
async function overlayDegradesOnFailure(mod) {
	const { ctx, state } = makeOverlayCtx({ customThrows: new Error("boom") });
	let threw = false;
	try {
		await mod.renderPlanDashboardOverlay(ctx, "irrelevant");
	} catch {
		threw = true;
	}
	check("overlay-fail: renderPlanDashboardOverlay resuelve (no rechaza)", !threw);
	check("overlay-fail: notify se invoca exactamente una vez", state.notes.length === 1);
	check(
		"overlay-fail: el mensaje notify incluye 'No se pudo abrir el tablero de plan: boom'",
		state.notes[0]?.msg?.includes("No se pudo abrir el tablero de plan: boom"),
	);
	check("overlay-fail: el nivel de notify es 'warning'", state.notes[0]?.type === "warning");
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
