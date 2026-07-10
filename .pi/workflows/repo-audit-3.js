// TEMPORAL repo-audit-3 (borrar luego): reaudita las 6 áreas que salieron vacías en la corrida 2.
// Causa raíz: "empty JSON event stream". El subagente consume el turno leyendo archivos grandes
// (sobre todo core-dispatch: index.ts ~1700 líneas) y no llega a emitir hallazgos.
// Mitigaciones:
//   1. core-dispatch se divide en dos particiones por función que DEBEN usar grep + lecturas acotadas.
//   2. Reintento ante salida vacía: una partición vacía o casi vacía se reintenta UNA vez con cache:false.
//   3. Todas las particiones usan effort high; docs/devtools suben desde medium.
// Conserva el parseo tolerante de bloques JSON, el límite de verbosidad y la alineación de labels de repo-audit-2.

export const meta = {
	name: "repo-audit-3",
	description: "Reauditoría dirigida de las 6 áreas vacías.",
	phases: [{ title: "revisión fan-out" }, { title: "síntesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
	codexHigh: { model: "openai-codex/gpt-5.6-sol", effort: "high" },
	codexMedPlus: { model: "openai-codex/gpt-5.6-terra", effort: "high" },
};

const PREFIX = [
	"Sos un revisor de código meticuloso y ADVERSARIAL que audita parte de un monorepo de extensiones de Pi (la CLI `@earendil-works/pi-coding-agent`) en busca de ERRORES e INCONSISTENCIAS.",
	"Buscá defectos CONCRETOS: bugs lógicos, casos límite incorrectos, riesgos de concurrencia (condiciones de carrera, promesas sin await, cancelación o limpieza ausente), manejo de errores silenciado o incorrecto, casts sin seguridad de tipos, JSON.parse sin comprobación, problemas de seguridad (inyección de shell mediante spawn con string, filtración de secretos o variables de entorno, path traversal, carga de código desde un cwd no confiable) e inconsistencias (entre extensiones hermanas, entre el código y sus PROPIOS comentarios/README, defaults obsoletos).",
	"FUNDAMENTÁ cada hallazgo en código que realmente hayas leído; si no podés citar file+line+el snippet exacto, NO lo informes. No edites nada.",
	"",
	"EFICIENCIA (crítico: tenés un presupuesto de turno limitado): NO leas archivos grandes completos de principio a fin. Usá grep/find para ubicar las funciones específicas nombradas en tu alcance y después leé ÚNICAMENTE ~60-120 líneas alrededor de cada una. Dedicá tu presupuesto al ANÁLISIS, no a recorrer archivos. DEBÉS emitir el bloque de hallazgos antes de que termine el turno.",
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
// "empty" = rama fallida, salida casi vacía, o parse 0 sin un [] explícito.
function isEmpty(r) {
	if (!r) return true;
	const raw = rawOf(r);
	if (raw.trim().length < 200) return true;
	return parseFindings(r).length === 0 && !raw.includes("[]");
}

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const items = [
		// core-dispatch se divide en dos particiones por función; nunca leer el archivo completo.
		item("core-dispatch-a", "opusHigh", "extensions/pandi-dynamic-workflows/index.ts — revisá ÚNICAMENTE estas funciones (usá grep para cada una, leé ~80-120 líneas alrededor y NO leas el archivo completo): el ALS de callSignal AbortSignal, callControllers, el dispatcher, el wrapper de llamadas agent()/ask() y runWorkflow. Concentrate en la conexión de la cancelación, el ciclo de vida de AbortSignal y el aislamiento por llamada."),
		item("core-dispatch-b", "codexHigh", "extensions/pandi-dynamic-workflows/index.ts — revisá ÚNICAMENTE estas funciones (usá grep para cada una, leé ~80-120 líneas alrededor y NO leas el archivo completo): journalLookup (cache de resume/journal), runSubagent, runBash, runAsk, la factory de globals de makeApi y handleTool. Concentrate en la corrección de resume/journal, la redacción de secretos y el manejo de errores."),
		// pandi-loop: la corrida anterior encontró un bug real (evasión del gate de autopilotTurnInFlight).
		item("pandi-loop", "codexHigh", "extensions/pandi-loop/*.ts (omití tests/). Concentrate especialmente en: stopLoop frente al flag de módulo autopilotTurnInFlight e inFlightOwnerAlive(), los guards de drainWakeQueue, el reset de loop.autopilot en agent_end, la rehidratación de estado, los límites de delay/iteration/deadline, los gates de tui/rpc, la detención forzada del watchdog y el GC del estado terminal."),
		// pandi-goal: sonnet devolvió vacío la vez anterior; se ejecuta con effort high y un segundo revisor.
		item("pandi-goal", "sonnetHigh", "extensions/pandi-goal/*.ts (omití tests/). Concentrate en la limpieza de activeGoals al ejecutar stop/shutdown (simetría de delete/clear frente a pandi-loop), la simetría entre escritura y lectura del sidecar, los gates y límites de independent-verifier, el uso posterior a shutdown de verifiers en curso y los límites de iteration/wait."),
		item("pandi-goal", "codexHigh", "extensions/pandi-goal/*.ts (omití tests/). Concentrate en la limpieza de activeGoals al ejecutar stop/shutdown (simetría de delete/clear frente a pandi-loop), la simetría entre escritura y lectura del sidecar, los gates y límites de independent-verifier, el uso posterior a shutdown de verifiers en curso y los límites de iteration/wait."),
		// devtools-a sube a effort high; su par devtools-b encontró 8 hallazgos.
		item("devtools-a", "sonnetHigh", "extensions/pandi-typescript-lsp/*.ts + extensions/pandi-bg/*.ts (omití tests/). Concentrate en la resolución de tsc, el alcance de los archivos modificados, las condiciones de carrera de spawn-before-abort, el ciclo de vida de jobs en background, la detección de reutilización de PID/identity, las escrituras atómicas de status y los gates de trust."),
		// docs + config suben a effort high.
		item("docs-consistency", "codexMedPlus", "Compará las afirmaciones del README.md RAÍZ con el código real: nombres de slash commands, nombres de model/tools, nombres Y defaults de variables de entorno PI_* y rutas de archivos. Leé README.md junto con las líneas específicas del código fuente a las que hace referencia. Informá cada divergencia con AMBAS citas (línea del README + línea del código fuente)."),
		item("config-manifest", "sonnetHigh", "Revisá package.json (`pi.extensions` frente a los directorios de extensions/, `files`, `pi.skills`, scripts), biome.jsonc, tsconfig.json, .gitignore, .env.example frente al uso real de PI_* en el código y los scaffolds de Pi frente a .claude/workflows (paridad). Informá las discrepancias con citas."),
	];

	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort });
	await log("matriz de model/effort", { plan });
	await writeArtifact("plan.json", plan);

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency limitada ${requestedConcurrency} -> ${concurrency} por limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = items.length * 2 + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`ADVERTENCIA: maxAgents puede quedar justo para repo-audit-3 ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, firstPass: items.length, possibleRetries: items.length, synthesis: 1 })}`);
	await log("fan-out (pasada 1)", { items: items.length, concurrency, maxAgents: limits.maxAgents, recommendedMaxAgents });
	let results = await agents(items, { concurrency, settle: true });

	// Reintentar una salida vacía UNA vez con cache:false; una nueva corrida cacheada repetiría el stream vacío.
	const retryIdx = results.map((r, i) => (isEmpty(r) ? i : -1)).filter((i) => i >= 0);
	if (retryIdx.length) {
		await log("reintento de vacíos (pasada 2, cache:false)", { areas: retryIdx.map((i) => items[i].area) });
		const retryItems = retryIdx.map((i) => ({ ...items[i], cache: false }));
		const retryResults = await agents(retryItems, { concurrency, settle: true });
		retryIdx.forEach((origIdx, k) => {
			// conservar el intento que sí produjo hallazgos
			if (isEmpty(results[origIdx]) && !isEmpty(retryResults[k])) results[origIdx] = retryResults[k];
		});
	}

	const allFindings = [];
	const coverage = [];
	results.forEach((r, i) => {
		const found = isEmpty(r) ? [] : parseFindings(r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model, effort: items[i].effort });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	const okCount = coverage.filter((c) => c.status === "ok").length;
	await log("fan-out completo", { ok: okCount, empty: coverage.length - okCount, findings: allFindings.length, coverage });
	await writeArtifact("findings-3.json", allFindings);
	await writeArtifact("coverage-3.json", coverage);

	const synth = [
		"Sos el JUEZ DE SÍNTESIS de una reauditoría DIRIGIDA (bugs e inconsistencias) de áreas que antes no produjeron salida.",
		"Eliminá duplicados y priorizá. DESCARTÁ todo lo que no tenga file/evidence concretos. Ordená por severity (high primero) y luego por radio de impacto. Para cada hallazgo conservado indicá: severity, category, file:line, qué está mal, por qué importa y una corrección concreta.",
		"CALIBRÁ severity con honestidad: un STRING de comando sugerido que solo se muestra (no se ejecuta) es LOW, no high; un spawn-before-abort terminado con SIGTERM en el mismo tick es LOW/MEDIUM.",
		"Explicitá la cobertura: qué áreas siguen vacías después del reintento (consultá el JSON de cobertura).",
		"Generá Markdown: `## Resumen` (conteos por severity), `## Hallazgos priorizados` (numerados) y `## Cobertura`.",
		"",
		"=== COBERTURA (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== HALLAZGOS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Áreas ok: ${okCount}/${coverage.length}. Reiterá: eliminá duplicados, priorizá por severity, calibrá severity, descartá lo no sustentado y explicitá las áreas que siguen vacías.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "síntesis" });
	await writeArtifact("audit-report-3.md", typeof report === "string" ? report : compact(report, 40000));
	return { ok: okCount, empty: coverage.length - okCount, totalFindings: allFindings.length, plan, coverage, report };
}
