// TEMPORAL repo-audit-2 (borrar luego): cubre las 5 áreas que devolvieron una salida vacía en la corrida 1.
// Causa raíz de las fallas de la corrida 1: las áreas pesadas produjeron hallazgos muy verbosos cuya salida JSON
// superó el presupuesto de tokens y quedó TRUNCADA en medio de un string -> falló el parseo con schema estricto -> fallaron los reintentos.
// Correcciones: alcances chicos por extensión o grupo de archivos, SIN schema estricto (parseo tolerante de bloques JSON),
// un límite ESTRICTO de verbosidad (issue/evidence breves + máximo de hallazgos) para que el JSON siempre termine,
// una matriz explícita de model/effort por agente (registrada en el log + guardada como artifact) y una alineación correcta
// entre áreas y labels (se itera CON los null para que las ramas filtradas nunca desplacen los labels).

export const meta = {
	name: "repo-audit-2",
	description: "Reauditoría robusta de las áreas pesadas.",
	phases: [{ title: "revisión fan-out" }, { title: "síntesis" }],
};

const READ_ONLY = ["read", "grep", "find", "ls"];

// Niveles de model/effort entre AMBOS proveedores autenticados (anthropic + openai-codex) para
// obtener diversidad adversarial entre proveedores. Se informan al usuario y se registran para que la corrida se describa a sí misma.
const TIER = {
	opusHigh: { model: "anthropic/claude-opus-4-8", effort: "high" },
	sonnetHigh: { model: "anthropic/claude-sonnet-4-6", effort: "high" },
	sonnetMed: { model: "anthropic/claude-sonnet-4-6", effort: "medium" },
	codexHigh: { model: "openai-codex/gpt-5.6-sol", effort: "high" },
	codexMed: { model: "openai-codex/gpt-5.6-terra", effort: "medium" },
};

const PREFIX = [
	"Sos un revisor de código meticuloso y ADVERSARIAL que audita parte de un monorepo de extensiones de Pi (la CLI `@earendil-works/pi-coding-agent`) en busca de ERRORES e INCONSISTENCIAS.",
	"Leé, en modo de solo lectura, ÚNICAMENTE los archivos de tu alcance asignado y buscá defectos CONCRETOS: bugs lógicos, casos límite incorrectos, riesgos de concurrencia (condiciones de carrera, promesas sin await, cancelación o limpieza ausente), manejo de errores silenciado o incorrecto, casts sin seguridad de tipos, JSON.parse sin comprobación, problemas de seguridad (inyección de shell mediante spawn con string, filtración de secretos o variables de entorno, path traversal) e inconsistencias (entre extensiones hermanas, entre el código y sus PROPIOS comentarios/README, defaults obsoletos).",
	"FUNDAMENTÁ cada hallazgo en código que realmente hayas leído; si no podés citar file+line+el snippet exacto, NO lo informes. No edites nada.",
	"",
	"LÍMITES ESTRICTOS DE SALIDA (crítico: incumplirlos trunca tu respuesta y hace que se DESCARTE):",
	"- Informá COMO MÁXIMO 8 hallazgos. Priorizá los más graves; descartá detalles menores.",
	"- Mantené cada `issue` por debajo de ~350 caracteres y cada `evidence` por debajo de ~250 caracteres. Sé breve; no escribas ensayos.",
	"- Generá ÚNICAMENTE un solo bloque cercado de código ```json con un array JSON y NADA más. CERRÁ el array (`]`) y el bloque.",
	"- Cada elemento: {\"severity\":\"high|medium|low\",\"category\":\"...\",\"file\":\"repo/rel/path\",\"line\":\"N o N-M\",\"issue\":\"...\",\"evidence\":\"...\",\"suggestion\":\"...\"}. Si está limpio, generá [].",
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

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	// Strings de alcance (se reutilizan para que AMBOS proveedores puedan revisar las 3 áreas CORE).
	const S = {
		coreDispatch: "extensions/pandi-dynamic-workflows/index.ts — el dispatcher de subagentes, el cache de journal/resume, runSubagent/runAsk/runBash, los globals de makeApi y handleTool. Concentrate en la cancelación, la corrección de resume/journal y la redacción de secretos.",
		corePrimitives: "extensions/pandi-dynamic-workflows/concurrency-primitives.ts + process-spawn.ts + worker-source.ts. Concentrate en la cancelación y propagación de errores de race()/agents()/parallel()/pipeline(), la conexión de AbortSignal y la seguridad del spawn de procesos hijos (argv frente a shell).",
		coreEnvResume: "extensions/pandi-dynamic-workflows/agent-env-persona.ts + config.ts + run-lifecycle.ts + run-state.ts. Concentrate en el aislamiento y la redacción de keys/env, la resolución de web_search/context7, los límites y las escrituras atómicas de status/result.",
	};
	const items = [
		// CORE (crítico) — revisión dual entre proveedores: anthropic opus + openai-codex gpt-5.6-sol.
		item("core-dispatch", "opusHigh", S.coreDispatch),
		item("core-dispatch", "codexHigh", S.coreDispatch),
		item("core-primitives", "opusHigh", S.corePrimitives),
		item("core-primitives", "codexHigh", S.corePrimitives),
		item("core-env-resume", "opusHigh", S.coreEnvResume),
		item("core-env-resume", "codexHigh", S.coreEnvResume),
		// loops/goal/plan — un solo revisor, alternando proveedores.
		item("pandi-loop", "codexHigh", "extensions/pandi-loop/*.ts (omití tests/). Concentrate en la rehidratación de estado, los límites de delay/iteration/deadline, los gates de tui/rpc, la detención forzada del watchdog, el ciclo de vida de autopilotTurnInFlight frente a activeLoops y el GC del estado terminal."),
		item("pandi-goal", "sonnetHigh", "extensions/pandi-goal/*.ts (omití tests/). Concentrate en la limpieza de activeGoals al ejecutar stop/shutdown, la simetría entre escritura y lectura del sidecar, los gates y límites de independent-verifier y los límites de iteration/wait."),
		item("pandi-plan", "codexHigh", "extensions/pandi-plan/*.ts (omití tests/). Concentrate en la aplicación del gate de mutaciones de solo lectura, las acciones bloqueadas de dynamic_workflow, la allowlist de bash y el manejo no interactivo exclusivo de plan."),
		// devtools + docs/config — un solo revisor, alternando proveedores, con effort medium.
		item("devtools-a", "sonnetMed", "extensions/pandi-typescript-lsp/*.ts + extensions/pandi-bg/*.ts (omití tests/). Concentrate en la resolución de tsc, el alcance de los archivos modificados, el ciclo de vida de jobs en background, la detección de reutilización de PID/identity, las escrituras atómicas y los gates de trust."),
		item("devtools-b", "codexMed", "extensions/pandi-worktree/*.ts + extensions/pandi-container/*.ts (omití tests/). Concentrate en el spawn de git/containers con arrays argv (nunca shell), los guards de plataforma y los defaults que nunca fuerzan el borrado."),
		item("docs-consistency", "codexMed", "Compará las afirmaciones del README.md RAÍZ con el código real: nombres de slash commands, nombres de tools de modelos, nombres Y defaults de variables de entorno PI_* y rutas de archivos. Leé README.md junto con las líneas específicas del código fuente a las que hace referencia. Informá cada divergencia con ambas citas."),
		item("config-manifest", "sonnetMed", "Revisá package.json (`pi.extensions` frente a los directorios de extensions/, `files`, `pi.skills`, scripts), biome.jsonc, tsconfig.json, .gitignore, .env.example frente al uso real de PI_* y los scaffolds de Pi frente a .claude/workflows (paridad). Informá las discrepancias con citas."),
	];

	// Corrida autodescriptiva: registrar + persistir la matriz de model/effort para que aparezca en events.jsonl y en el dashboard.
	const plan = items.map((it) => ({ agent: it.area, model: it.model, effort: it.effort, tier: it.tier }));
	plan.push({ agent: "synthesis-judge", model: TIER.opusHigh.model, effort: TIER.opusHigh.effort, tier: "opusHigh" });
	await log("matriz de model/effort", { plan });
	await writeArtifact("plan.json", plan);

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency limitada ${requestedConcurrency} -> ${concurrency} por limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = items.length + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`ADVERTENCIA: maxAgents puede quedar justo para repo-audit-2 ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, items: items.length, synthesis: 1 })}`);
	await log("fan-out", { items: items.length, concurrency, maxAgents: limits.maxAgents, recommendedMaxAgents });
	const results = await agents(items, { concurrency, settle: true });

	const allFindings = [];
	let failed = 0;
	const coverage = [];
	results.forEach((r, i) => {
		if (!r) { failed++; coverage.push({ area: items[i].area, status: "failed", model: items[i].model, effort: items[i].effort }); return; }
		const found = parseFindings(r?.output ?? r?.text ?? r);
		coverage.push({ area: items[i].area, status: found.length ? "ok" : "empty", findings: found.length, model: items[i].model, effort: items[i].effort });
		for (const f of found) allFindings.push({ area: items[i].area, ...f });
	});
	await log("fan-out completo", { ok: results.length - failed, failed, findings: allFindings.length, coverage });
	await writeArtifact("findings-2.json", allFindings);
	await writeArtifact("coverage-2.json", coverage);

	const synth = [
		"Sos el JUEZ DE SÍNTESIS de la segunda pasada de una auditoría de solo lectura del repo (bugs e inconsistencias).",
		"Eliminá duplicados y priorizá los hallazgos que aparecen abajo. DESCARTÁ todo lo que no tenga file/evidence concretos. Ordená por severity (high primero) y luego por radio de impacto. Para cada hallazgo conservado indicá: severity, category, file:line, qué está mal, por qué importa y una corrección concreta.",
		"Explicitá la cobertura: qué ramas quedaron ok/empty/failed (consultá el JSON de cobertura).",
		"Generá Markdown: `## Resumen` (conteos por severity), `## Hallazgos priorizados` (numerados) y `## Cobertura`.",
		"",
		"=== COBERTURA (JSON) ===",
		compact(coverage, 4000),
		"",
		"=== HALLAZGOS (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Ramas ok: ${results.length - failed}/${results.length}. Reiterá: eliminá duplicados, priorizá por severity, descartá lo no sustentado y explicitá los huecos de cobertura.`,
	].join("\n");
	const report = await agent(synth, { ...TIER.opusHigh, tools: READ_ONLY, phase: "síntesis" });
	await writeArtifact("audit-report-2.md", typeof report === "string" ? report : compact(report, 40000));
	return { areasOk: results.length - failed, areasFailed: failed, totalFindings: allFindings.length, plan, coverage, report };
}
