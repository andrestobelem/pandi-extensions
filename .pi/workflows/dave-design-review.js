/**
 * dave-design-review (estable; hermano de dave-test-review): revisión de DISEÑO
 * de la fuente de cada extensión con la perspectiva de Dave Farley y el mismo mecanismo
 * de verificación previa con corte temprano validado en dave-test-review (issue #5): canario de referencia
 * antes de consumir recursos en la distribución, validación de salida sustantiva con un reintento
 * sin caché por rama y un juez de síntesis que debe NOMBRAR las ramas vacías/fallidas.
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
	name: "dave-design-review",
	description:
		"Revisión de diseño de la fuente de extensiones con la perspectiva de Dave Farley, verificación previa con corte temprano, reintento ante salida vacía y síntesis honesta sobre ramas vacías",
	phases: [{ title: "Relevar" }, { title: "Verificación previa" }, { title: "Distribuir" }, { title: "Sintetizar" }],
	basedOn: [
		{ name: "dave-test-review", role: "esqueleto compartido (verificación previa + reintento ante salida vacía, validado en ejecuciones del issue #5)" },
		{ name: "fan-out-and-synthesize", role: "patrón base (scatter-gather + síntesis como juez)" },
	],
};

const MIN_SUBSTANTIVE_CHARS = 200;

const PREFIX = [
	"Actuá como revisor de DISEÑO al estilo de Dave Farley (tenés el skill modern-software-engineering; aplicalo).",
	"Estás revisando la FUENTE de UNA extensión del monorepo pandi-extensions (omití su directorio tests/; leelo solo para evaluar la testabilidad).",
	"Evaluá el diseño según las dos competencias importantes: ¿optimiza el APRENDIZAJE y gestiona la COMPLEJIDAD?",
	"Evaluá de forma concreta:",
	"- COMPLEJIDAD: modularidad, cohesión, separación de responsabilidades, ocultamiento de información, calidad de las abstracciones y acoplamiento (incluida la superficie del SDK de pi).",
	"- TESTABILIDAD como propiedad del diseño: seams, lógica pura separada de I/O y límites de spawn/UI aislados.",
	"- HONESTIDAD ANTE ERRORES: ¿las fallas se exponen con veracidad, sin errores silenciados ni afirmaciones de estado 'limpio' sin verificar?",
	"- CONSISTENCIA: con las convenciones de extensiones hermanas y con el README/los comentarios de la PROPIA extensión.",
	"TENÉ EN CUENTA esta regla del monorepo: la duplicación por extensión de helpers pequeños (notify.ts, time.ts y parsers de flags) es INTENCIONAL; las extensiones se cargan de forma autocontenida. NO recomiendes aplicar DRY entre extensiones.",
	"FUNDAMENTÁ cada afirmación con evidencia de archivo+línea que realmente hayas leído. NO edites nada.",
	"EFICIENCIA: usá grep/find para navegar; leé solo las regiones necesarias. Emití tu informe antes de que termine el turno.",
	"",
	"FORMATO DE SALIDA (Markdown, TODAS las secciones son obligatorias; mantenelo por debajo de ~500 líneas):",
	"## VEREDICTO — uno de: STRONG | ADEQUATE | WEAK, más una justificación de una oración",
	"## FORTALEZAS — lista con viñetas y evidencia",
	"## PREOCUPACIONES DE DISEÑO — priorizadas, las más importantes primero; cada una con evidencia + costo en complejidad/testabilidad",
	"## RECOMENDACIONES — los pasos reversibles seguros más pequeños, cada uno formulado como hipótesis comprobable",
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
	const lsOut = await bash("git ls-files 'extensions/*/*.ts' 'extensions/*/README.md'");
	const files = String(lsOut?.stdout ?? lsOut ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const byExt = new Map();
	for (const file of files) {
		const ext = file.split("/")[1];
		if (!ext) continue;
		const list = byExt.get(ext) ?? [];
		list.push(file);
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
	if (extNames.length === 0) throw new Error("El relevamiento no encontró fuentes de extensiones para revisar.");
	await log("lista de trabajo", { extensions: extNames.length, files: files.length });

	// --- Validación de salida sustantiva + reintento ante salida vacía (verificado en #5). -------
	const forceEmpty = input?.forceEmpty === "baseline" || input?.forceEmpty === "once" ? input.forceEmpty : null;
	if (forceEmpty) await log(`PUNTO DE PRUEBA ACTIVO: forceEmpty=${forceEmpty}; se simula una salida de rama vacía`);

	const isSubstantive = (out) => typeof out === "string" && out.trim().length >= MIN_SUBSTANTIVE_CHARS;

	const prompt = (ext) => `${PREFIX}\n${ext} — archivos fuente:\n${byExt.get(ext).join("\n")}`;

	const reviewOnce = async (ext, { cache = true, attempt, phaseTitle }) => {
		if (forceEmpty === "baseline" && phaseTitle === "Verificación previa") return "";
		if (forceEmpty === "once" && attempt === 1) return "";
		const out = await agent(prompt(ext), {
			...REVIEWER,
			cache,
			label: `design-${ext}${attempt > 1 ? "-retry" : ""}`,
			phase: phaseTitle,
		});
		return typeof out === "string" ? out : (out?.output ?? out?.text ?? "");
	};

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
	await writeArtifact(`design-${baseline}.md`, canary.output);
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
	const results = [canary, ...settled.map((r, i) => r ?? { ext: rest[i], output: null, empty: true, retried: false })];

	const coverage = results.map((r) => ({
		ext: r.ext,
		status: r.empty ? "EMPTY" : "ok",
		retried: r.retried,
		chars: r.output ? r.output.length : 0,
	}));
	const empties = coverage.filter((c) => c.status === "EMPTY").map((c) => c.ext);
	for (const r of results) if (r.output && r.ext !== baseline) await writeArtifact(`design-${r.ext}.md`, r.output);
	await writeArtifact("coverage.json", coverage);
	await log("distribución completa", { ok: results.length - empties.length, empty: empties.length, empties });

	// --- Síntesis como juez: las ramas vacías se NOMBRAN, nunca se disimulan. ------
	phase("Sintetizar");
	const reviewed = results.filter((r) => !r.empty);
	const synth = [
		"Sos el JUEZ DE SÍNTESIS de una revisión de DISEÑO de extensiones de pi con la perspectiva de Dave Farley (informes abajo).",
		"Tarea + criterios de éxito: producí UN informe priorizado y fundamentado en evidencia. Descartá toda afirmación sin evidencia de archivo/línea. Eliminá temas duplicados entre extensiones. Respetá la regla del monorepo según la cual la duplicación por extensión de helpers pequeños es intencional.",
		`Cobertura: ${reviewed.length}/${results.length} extensiones revisadas. DEBÉS nombrar las ramas EMPTY/fallidas como no revisadas (nunca infieras nada sobre ellas): ${empties.length ? JSON.stringify(empties) : "ninguna"}.`,
		"Salida Markdown: `## Resumen` (conteos de veredictos y temas sistémicos), `## Hallazgos priorizados` (numerados, los más valiosos primero, con extensión + evidencia), `## Cobertura` (tabla de veredictos por extensión, con las ramas EMPTY marcadas), `## Próximos pasos` (los pasos reversibles seguros más pequeños).",
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
	await writeArtifact("design-review-report.md", typeof report === "string" ? report : compact(report, 80000));

	return {
		baseline,
		reviewed: reviewed.length,
		empty: empties.length,
		empties,
		coverage,
		report,
	};
}
