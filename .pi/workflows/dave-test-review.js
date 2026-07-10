/**
 * dave-test-review (estable; promovido desde drafts/ después de ejecuciones verificadas): revisión con la perspectiva
 * de Dave Farley de las suites de tests de integración de cada extensión, con una VERIFICACIÓN PREVIA DE CORTE TEMPRANO (issue #5).
 *
 * Modo de falla contra el que se protege: bajo límites de tasa del proveedor, las ramas
 * de la distribución pueden resolver ok:true con salida EMPTY. Entonces el juez de síntesis
 * se niega (correctamente) a inventar, pero se desperdicia todo el presupuesto de la ejecución.
 * Defensa en profundidad:
 *   1. VERIFICACIÓN PREVIA: revisar primero UNA extensión de referencia. Si su salida no es
 *      sustantiva después de un reintento sin caché, lanzar una excepción; nunca ejecutar la distribución.
 *   2. DISTRIBUCIÓN: validar que cada rama sea sustantiva; reintentar una vez las vacías
 *      con cache:false y luego marcarlas de forma visible (nunca contarlas silenciosamente como limpias).
 *   3. SÍNTESIS: el juez recibe la tabla de cobertura y debe NOMBRAR las ramas vacías
 *      o fallidas en lugar de disimularlas.
 *
 * Parámetros (args contiene JSON serializado como string; se parsea defensivamente):
 *   extensions  string[]  opcional. Nombres explícitos de extensiones; omite el relevamiento.
 *   limit       number    valor predeterminado: 32. Máximo de extensiones revisadas; el excedente se registra y descarta.
 *   concurrency number    valor predeterminado: 4 (ajustado a limits.concurrency).
 *   baseline    string    opcional. Extensión usada para la verificación previa (valor predeterminado: la primera ordenada).
 *   forceEmpty  string    PUNTO DE PRUEBA, registrado de forma visible. "baseline": la rama de verificación previa
 *                         produce "" en AMBOS intentos (debe detenerse antes de la distribución).
 *                         "once": el PRIMER intento de cada rama es ""
 *                         (debe recuperarse mediante el reintento sin caché).
 *
 * Los revisores usan la persona `dave-farley` del proyecto (.pi/personas/dave-farley.json):
 * asesor de solo lectura con el skill modern-software-engineering. Los valores explícitos
 * de model/effort indicados abajo sobrescriben los valores predeterminados de la persona en cada llamada.
 */
export const meta = {
	name: "dave-test-review",
	description:
		"Revisión de suites de integración de extensiones con la perspectiva de Dave Farley, verificación previa con corte temprano, reintento ante salida vacía y síntesis honesta sobre ramas vacías",
	phases: [{ title: "Relevar" }, { title: "Verificación previa" }, { title: "Distribuir" }, { title: "Sintetizar" }],
	basedOn: [
		{ name: "fan-out-and-synthesize", role: "patrón base (scatter-gather + síntesis como juez)" },
		{ name: "repo-audit-4", role: "precedente de reintento ante salida vacía (cache:false)" },
	],
};

const MIN_SUBSTANTIVE_CHARS = 200;

const PREFIX = [
	"Actuá como revisor de una SUITE DE TESTS al estilo de Dave Farley (tenés el skill modern-software-engineering; aplicalo).",
	"Estás revisando las suites de tests de integración de UNA extensión del monorepo pandi-extensions.",
	"Evaluá las suites como ARTIFACTS DE INGENIERÍA: ¿optimizan el aprendizaje y gestionan la complejidad?",
	"Evaluá de forma concreta:",
	"- Cobertura de COMPORTAMIENTO: ¿los tests fijan comportamiento observable (salidas, mensajes, estado) o detalles de implementación?",
	"- NO VACUIDAD: ¿un test podría pasar aunque el comportamiento estuviera roto? Nombrá toda aserción que no pueda fallar de manera significativa.",
	"- HERMETICIDAD: dependencias ocultas de red/estado global/temporización; cualquier elemento que pueda producir flakiness bajo paralelismo.",
	"- VELOCIDAD DE FEEDBACK: esperas, fixtures sobredimensionados y trabajo serial que podría ser barato.",
	"- BRECHAS: los comportamientos NO CUBIERTOS más importantes de esta extensión (leé la fuente para saber qué hace).",
	"FUNDAMENTÁ cada afirmación con evidencia de archivo+línea que realmente hayas leído. NO edites nada.",
	"EFICIENCIA: usá grep/find para navegar; leé solo las regiones necesarias. Emití tu informe antes de que termine el turno.",
	"",
	"FORMATO DE SALIDA (Markdown, TODAS las secciones son obligatorias; mantenelo por debajo de ~500 líneas):",
	"## VEREDICTO — uno de: STRONG | ADEQUATE | WEAK, más una justificación de una oración",
	"## FORTALEZAS — lista con viñetas y evidencia",
	"## BRECHAS — priorizadas, las más importantes primero; cada una con el comportamiento faltante + por qué importa",
	"## RIESGOS DE FLAKINESS — o 'no se encontró ninguno'",
	"## RECOMENDACIONES — los próximos pasos seguros más pequeños, con TDD primero",
	"",
	"Extensión asignada:",
].join("\n");

export default async function main() {
	const input = (() => {
		try {
			return typeof args === "string" ? JSON.parse(args) || {} : args || {};
		} catch {
			return {};
		}
	})();

	const compact = (d, n = 60000) => {
		const s = typeof d === "string" ? d : JSON.stringify(d);
		return s.length > n ? `${s.slice(0, n)} …[truncated]` : s;
	};

	const REVIEWER = { agentType: "dave-farley", model: "anthropic/claude-sonnet-4-6", effort: "medium" };
	const JUDGE = { agentType: "dave-farley", model: "anthropic/claude-opus-4-8", effort: "high" };

	// --- Relevamiento: comando constante (sin interpolación), agrupado por extensión. -----
	phase("Relevar");
	const lsOut = await bash("git ls-files 'extensions/*/tests/integration/*.test.mjs'");
	const suites = String(lsOut?.stdout ?? lsOut ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const byExt = new Map();
	for (const suite of suites) {
		const ext = suite.split("/")[1];
		if (!ext) continue;
		const list = byExt.get(ext) ?? [];
		list.push(suite);
		byExt.set(ext, list);
	}
	let extNames = [...byExt.keys()].sort();
	if (Array.isArray(input?.extensions) && input.extensions.length) {
		const requested = input.extensions.filter((e) => byExt.has(e));
		const unknown = input.extensions.filter((e) => !byExt.has(e));
		if (unknown.length) await log("se ignoran extensiones desconocidas", { unknown });
		extNames = requested;
	}
	const limit = Math.max(1, Math.min(256, Math.floor(Number(input?.limit) || 32)));
	if (extNames.length > limit) {
		await log("se aplicó el tope limit; se DESCARTAN extensiones de esta ejecución", {
			reviewed: limit,
			dropped: extNames.slice(limit),
		});
		extNames = extNames.slice(0, limit);
	}
	if (extNames.length === 0) throw new Error("El relevamiento no encontró suites de integración de extensiones para revisar.");
	await log("lista de trabajo", { extensions: extNames.length, suites: suites.length });

	// --- Validación de salida sustantiva + reintento ante salida vacía (núcleo de #5). ----------
	const forceEmpty = input?.forceEmpty === "baseline" || input?.forceEmpty === "once" ? input.forceEmpty : null;
	if (forceEmpty) await log(`PUNTO DE PRUEBA ACTIVO: forceEmpty=${forceEmpty}; se simula una salida de rama vacía`);

	const isSubstantive = (out) => typeof out === "string" && out.trim().length >= MIN_SUBSTANTIVE_CHARS;

	const prompt = (ext) => `${PREFIX}\n${ext} — suites:\n${byExt.get(ext).join("\n")}`;

	// Un intento de revisión. El punto de prueba simula la falla observada (ok:true, salida
	// vacía) SIN consumir una llamada a un agente.
	const reviewOnce = async (ext, { cache = true, attempt, phaseTitle }) => {
		if (forceEmpty === "baseline" && phaseTitle === "Verificación previa") return "";
		if (forceEmpty === "once" && attempt === 1) return "";
		const out = await agent(prompt(ext), {
			...REVIEWER,
			cache,
			label: `review-${ext}${attempt > 1 ? "-retry" : ""}`,
			phase: phaseTitle,
		});
		return typeof out === "string" ? out : (out?.output ?? out?.text ?? "");
	};

	// Intento + un reintento sin caché; devuelve { ext, output|null, empty, retried }.
	const reviewWithRetry = async (ext, phaseTitle) => {
		let out = await reviewOnce(ext, { attempt: 1, phaseTitle });
		let retried = false;
		if (!isSubstantive(out)) {
			await log(`salida de rama EMPTY para ${ext}; se reintenta una vez con cache:false`, {
				chars: String(out ?? "").trim().length,
			});
			retried = true;
			out = await reviewOnce(ext, { cache: false, attempt: 2, phaseTitle });
		}
		if (!isSubstantive(out)) {
			await log(`salida de rama EMPTY para ${ext} DESPUÉS del reintento; se marca como fallida`, {
				chars: String(out ?? "").trim().length,
			});
			return { ext, output: null, empty: true, retried };
		}
		return { ext, output: out, empty: false, retried };
	};

	// --- VERIFICACIÓN PREVIA: una extensión de referencia ANTES de consumir recursos en la distribución. -----------
	phase("Verificación previa");
	const baseline = typeof input?.baseline === "string" && extNames.includes(input.baseline) ? input.baseline : extNames[0];
	await log("referencia de la verificación previa", { baseline });
	const canary = await reviewWithRetry(baseline, "Verificación previa");
	if (canary.empty) {
		await writeArtifact("preflight-failure.json", { baseline, retried: canary.retried, forceEmpty });
		throw new Error(
			`FALLÓ LA VERIFICACIÓN PREVIA: la revisión de referencia de ${baseline} produjo una salida vacía incluso después de un reintento sin caché ` +
				"(probablemente por límites de tasa). Se aborta ANTES de la distribución; no se consumieron más recursos. Volvé a ejecutar más tarde o cambiá de modelo.",
		);
	}
	await writeArtifact(`review-${baseline}.md`, canary.output);
	await log("verificación previa SUPERADA", { baseline, chars: canary.output.length, retried: canary.retried });

	// --- Distribución sobre las extensiones restantes. --------------------------------
	phase("Distribuir");
	const rest = extNames.filter((e) => e !== baseline);
	const concurrency = Math.max(1, Math.min(Number(input?.concurrency) || 4, limits.concurrency));
	await log("distribución", { extensions: rest.length, concurrency, maxAgents: limits.maxAgents });
	const settled = await parallel(
		rest.map((ext) => () => reviewWithRetry(ext, "Distribuir")),
		{ concurrency },
	);
	// parallel con semántica similar a settle: una rama que lanza una excepción queda en null; recuperar su identidad por posición.
	const results = [canary, ...settled.map((r, i) => r ?? { ext: rest[i], output: null, empty: true, retried: false })];

	const coverage = results.map((r) => ({
		ext: r.ext,
		status: r.empty ? "EMPTY" : "ok",
		retried: r.retried,
		chars: r.output ? r.output.length : 0,
	}));
	const empties = coverage.filter((c) => c.status === "EMPTY").map((c) => c.ext);
	for (const r of results) if (r.output && r.ext !== baseline) await writeArtifact(`review-${r.ext}.md`, r.output);
	await writeArtifact("coverage.json", coverage);
	await log("distribución completa", { ok: results.length - empties.length, empty: empties.length, empties });

	// --- Síntesis como juez: las ramas vacías se NOMBRAN, nunca se disimulan. ------
	phase("Sintetizar");
	const reviewed = results.filter((r) => !r.empty);
	const synth = [
		"Sos el JUEZ DE SÍNTESIS de una revisión de suites de tests de extensiones con la perspectiva de Dave Farley (informes abajo).",
		"Tarea + criterios de éxito: producí UN informe priorizado y fundamentado en evidencia. Descartá toda afirmación sin evidencia de archivo/línea. Eliminá temas duplicados entre extensiones.",
		`Cobertura: ${reviewed.length}/${results.length} extensiones revisadas. DEBÉS nombrar las ramas EMPTY/fallidas como no revisadas (nunca infieras nada sobre ellas): ${empties.length ? JSON.stringify(empties) : "ninguna"}.`,
		"Salida Markdown: `## Resumen` (conteos de veredictos y temas sistémicos), `## Hallazgos priorizados` (numerados, los más valiosos primero, con extensión + evidencia), `## Cobertura` (tabla de veredictos por extensión, con las ramas EMPTY marcadas), `## Próximos pasos` (los pasos TDD-first seguros más pequeños).",
		"",
		"=== COVERAGE (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== REVIEWS ===",
		compact(
			reviewed.map((r) => `### ${r.ext}\n${r.output}`).join("\n\n"),
			120000,
		),
		"",
		`Reiteración: priorizá con evidencia, eliminá temas duplicados y nombrá explícitamente las ${empties.length} ramas EMPTY${empties.length ? `: ${JSON.stringify(empties)}` : ""}.`,
	].join("\n");
	const report = await agent(synth, { ...JUDGE, label: "synthesis-judge", phase: "Sintetizar" });
	await writeArtifact("test-review-report.md", typeof report === "string" ? report : compact(report, 80000));

	return {
		baseline,
		reviewed: reviewed.length,
		empty: empties.length,
		empties,
		coverage,
		report,
	};
}
