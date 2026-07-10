// TEMPORAL repo-audit-4 (borrar luego): cierre solo con anthropic de las 3 áreas que siguen sin cubrir
// después de las corridas 1-3. Las particiones con salida JSON de Codex devolvieron "empty JSON event stream" de forma persistente, por lo que
// esta corrida usa ÚNICAMENTE anthropic (opus/sonnet), que resultó confiable. core-dispatch-b recibe una revisión dual
// (opus + sonnet) porque es la mitad no probada del dispatcher principal. Reintento ante salida vacía con
// cache:false, límite de verbosidad, parseo tolerante de bloques JSON y maxAgents generoso (>= 2*particiones + 1).

export const meta = {
	name: "repo-audit-4",
	description: "Cierre solo con anthropic de las 3 áreas sin cubrir.",
	phases: [{ title: "revisión fan-out" }, { title: "síntesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
};

const PREFIX = [
	"Sos un revisor de código meticuloso y ADVERSARIAL que audita parte de un monorepo de extensiones de Pi (la CLI `@earendil-works/pi-coding-agent`) en busca de ERRORES e INCONSISTENCIAS.",
	"Buscá defectos CONCRETOS: bugs lógicos, casos límite incorrectos, riesgos de concurrencia (condiciones de carrera, promesas sin await, cancelación o limpieza ausente), manejo de errores silenciado o incorrecto, casts sin seguridad de tipos, JSON.parse sin comprobación, problemas de seguridad (inyección de shell mediante spawn con string, filtración de secretos o variables de entorno, path traversal, carga de código desde un cwd no confiable) e inconsistencias (entre extensiones hermanas, entre el código y sus PROPIOS comentarios/README, defaults obsoletos).",
	"FUNDAMENTÁ cada hallazgo en código que realmente hayas leído; si no podés citar file+line+el snippet exacto, NO lo informes. No edites nada.",
	"",
	"EFICIENCIA (crítico: presupuesto de turno limitado): NO leas archivos grandes completos de principio a fin. Usá grep/find para ubicar las funciones específicas nombradas en tu alcance y después leé ÚNICAMENTE ~60-120 líneas alrededor de cada una. Dedicá el presupuesto al ANÁLISIS. DEBÉS emitir el bloque de hallazgos antes de que termine el turno.",
	"",
	"LÍMITES ESTRICTOS DE SALIDA (incumplirlos trunca tu respuesta y hace que se DESCARTE):",
	"- Informá COMO MÁXIMO 8 hallazgos. Priorizá los más graves; descartá detalles menores.",
	"- Mantené cada `issue` por debajo de ~350 caracteres y cada `evidence` por debajo de ~250 caracteres. Sé breve.",
	"- Generá ÚNICAMENTE un solo bloque cercado de código ```json con un array JSON y NADA más. CERRÁ el array (`]`) y el bloque.",
	'- Cada elemento: {"severity":"high|medium|low","category":"...","file":"repo/rel/path","line":"N o N-M","issue":"...","evidence":"...","suggestion":"..."}. Si realmente está limpio, generá [].',
	"",
	"Tu alcance asignado:",
].join("\n");

function item(area, tier, scope) {
	return { label: area, area, phase: "revisión fan-out", ...TIER[tier], tier, tools: READ_ONLY, prompt: `${PREFIX}\n${scope}` };
}

function parseFindings(text) {
	if (!text) return [];
	const s = typeof text === "string" ? text : (text.output ?? text.text ?? "");
	const block = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [];
	if (block) candidates.push(block[1].trim());
	const a = s.indexOf("["), b = s.lastIndexOf("]");
	if (a >= 0 && b > a) candidates.push(s.slice(a, b + 1));
	for (const c of candidates) {
		try {
			const v = JSON.parse(c);
			if (Array.isArray(v)) return v;
			if (Array.isArray(v?.findings)) return v.findings;
		} catch {}
	}
	return [];
}

const rawOf = (r) => (r ? String(r.output ?? r.text ?? r ?? "") : "");
function isEmpty(r) {
	if (!r) return true;
	const raw = rawOf(r);
	if (raw.trim().length < 200) return true;
	return parseFindings(r).length === 0 && !raw.includes("[]");
}

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const items = [
		// core-dispatch-b: revisión dual (opus + sonnet) — la mitad no probada del dispatcher.
		item("core-dispatch-b", "opusHigh", "extensions/pandi-dynamic-workflows/index.ts — revisá ÚNICAMENTE estas funciones (usá grep para cada una, leé ~80-120 líneas alrededor y NUNCA leas el archivo completo): journalLookup (cache de resume/journal), runSubagent, runBash, runAsk, la factory de globals de makeApi y handleTool. Concentrate en la corrección de resume/journal, la redacción de secretos, los rechazos no manejados y el manejo de errores."),
		item("core-dispatch-b", "sonnetHigh", "extensions/pandi-dynamic-workflows/index.ts — revisá ÚNICAMENTE estas funciones (usá grep para cada una, leé ~80-120 líneas alrededor y NUNCA leas el archivo completo): journalLookup (cache de resume/journal), runSubagent, runBash, runAsk, la factory de globals de makeApi y handleTool. Concentrate en la corrección de resume/journal, la redacción de secretos, los rechazos no manejados y el manejo de errores."),
		item("devtools-a", "sonnetHigh", "extensions/pandi-typescript-lsp/*.ts + extensions/pandi-bg/*.ts (omití tests/). Concentrate en la resolución de tsc, el alcance de los archivos modificados, las condiciones de carrera de spawn-before-abort, el ciclo de vida de jobs en background, la detección de reutilización de PID/identity, las escrituras atómicas de status y los gates de trust."),
		item("docs-consistency", "sonnetHigh", "Compará las afirmaciones del README.md RAÍZ con el código real: nombres de slash commands, nombres de model/tools, nombres Y defaults de variables de entorno PI_* y rutas de archivos. Leé README.md junto con las líneas específicas del código fuente a las que hace referencia. Informá cada divergencia con AMBAS citas (línea del README + línea del código fuente)."),
	];

	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort });
	await log("matriz de model/effort (solo anthropic)", { plan });
	await writeArtifact("plan.json", plan);

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency limitada ${requestedConcurrency} -> ${concurrency} por limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = items.length * 2 + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`ADVERTENCIA: maxAgents puede quedar justo para repo-audit-4 ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, firstPass: items.length, possibleRetries: items.length, synthesis: 1 })}`);
	await log("fan-out (pasada 1)", { items: items.length, concurrency, maxAgents: limits.maxAgents, recommendedMaxAgents });
	let results = await agents(items, { concurrency, settle: true });

	const retryIdx = results.map((r, i) => (isEmpty(r) ? i : -1)).filter((i) => i >= 0);
	if (retryIdx.length) {
		await log("reintento de vacíos (pasada 2, cache:false)", { areas: retryIdx.map((i) => items[i].area) });
		const retryResults = await agents(retryIdx.map((i) => ({ ...items[i], cache: false })), { concurrency, settle: true });
		retryIdx.forEach((origIdx, k) => {
			if (isEmpty(results[origIdx]) && !isEmpty(retryResults[k])) results[origIdx] = retryResults[k];
		});
	}

	const allFindings = [];
	const coverage = [];
	results.forEach((r, i) => {
		const found = isEmpty(r) ? [] : parseFindings(r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	const okCount = coverage.filter((c) => c.status === "ok").length;
	await log("fan-out completo", { ok: okCount, empty: coverage.length - okCount, findings: allFindings.length, coverage });
	await writeArtifact("findings-4.json", allFindings);
	await writeArtifact("coverage-4.json", coverage);

	const synth = [
		"Sos el JUEZ DE SÍNTESIS del cierre solo con anthropic de una auditoría de solo lectura del repo (bugs e inconsistencias).",
		"Eliminá duplicados y priorizá. DESCARTÁ todo lo que no tenga file/evidence concretos. Ordená por severity (high primero) y luego por radio de impacto.",
		"CALIBRÁ severity con honestidad: un string de comando que se muestra pero no se ejecuta es LOW; un spawn-before-abort terminado con SIGTERM en el mismo tick es LOW/MEDIUM.",
		"Explicitá la cobertura: cuáles de las áreas siguen vacías.",
		"Generá Markdown: `## Resumen` (conteos por severity), `## Hallazgos priorizados` (numerados) y `## Cobertura`.",
		"",
		"=== COBERTURA (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== HALLAZGOS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Áreas ok: ${okCount}/${coverage.length}. Reiterá: eliminá duplicados, priorizá, calibrá severity, descartá lo no sustentado y señalá las áreas que siguen vacías.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "síntesis" });
	await writeArtifact("audit-report-4.md", typeof report === "string" ? report : compact(report, 40000));
	return { ok: okCount, empty: coverage.length - okCount, totalFindings: allFindings.length, plan, coverage, report };
}
