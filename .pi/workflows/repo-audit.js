// TEMPORAL repo-audit (borrar luego): auditoría de solo lectura de errores e inconsistencias.
// 1) Gate determinista (bash): typecheck + biome + markdownlint como evidencia.
// 2) Fan-out por grupos de extensiones + una rama de docs + una de config/manifest.
// 3) Síntesis como juez (opus): deduplica, descarta lo no sustentado y prioriza por severidad.
// Todos los subagentes trabajan en SOLO LECTURA y deben citar archivo:línea.

export const meta = {
	name: "repo-audit",
	description: "Auditoría de solo lectura del repo para detectar bugs e inconsistencias; informe priorizado y respaldado por evidencia.",
	phases: 3,
};

const READ_ONLY = ["read", "grep", "find", "ls"];

const FINDINGS_SCHEMA = {
	type: "object",
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["severity", "category", "file", "issue"],
				properties: {
					severity: { type: "string", enum: ["high", "medium", "low"] },
					category: { type: "string" },
					file: { type: "string" },
					line: { type: "string" },
					issue: { type: "string" },
					evidence: { type: "string" },
					suggestion: { type: "string" },
				},
			},
		},
		note: { type: "string" },
	},
};

const REVIEW_PREFIX = [
	"Sos un revisor de código meticuloso y ADVERSARIAL que audita un monorepo de extensiones de Pi (la CLI `@earendil-works/pi-coding-agent`) en busca de ERRORES e INCONSISTENCIAS.",
	"Leé, en modo de solo lectura, los archivos de tu área asignada y buscá defectos CONCRETOS:",
	"- Bugs lógicos, manejo incorrecto de casos límite, errores off-by-one, condicionales incorrectos y código inalcanzable o contradictorio.",
	"- Riesgos de concurrencia: condiciones de carrera, promesas sin await, mutación de estado compartido, cancelación o limpieza ausente y fugas de recursos o handles.",
	"- Manejo de errores: errores silenciados, rechazos no manejados, discrepancias entre throw y return y mensajes engañosos.",
	"- Casts sin seguridad de tipos (`as any`, `!` de no nulo sobre valores quizá undefined), JSON.parse sin comprobación y entradas sin validar.",
	"- Seguridad: inyección de shell (spawn con string frente a argv), filtración de secretos o variables de entorno en logs o artifacts y path traversal.",
	"- Inconsistencias: entre extensiones hermanas, entre el código y sus PROPIOS comentarios/JSDoc/README, entre el comportamiento declarado y el real, y defaults obsoletos o incorrectos.",
	"Por CADA hallazgo devolvé: severity (high|medium|low), category, file (ruta relativa al repo), line (número o rango), issue (qué está mal), evidence (el código o cita exactos que lo demuestran) y suggestion (una corrección concreta).",
	"FUNDAMENTÁ cada hallazgo en el código real que leíste. Si no podés citarlo, NO lo informes. Si el área está limpia, devolvé findings: [] con una nota breve sobre lo que revisaste.",
	"NO inventes problemas, NO especules y NO edites nada.",
	"",
	"Tu área asignada:",
].join("\n");

function reviewItem(label, description, model = "anthropic/claude-sonnet-4-6") {
	return {
		label,
		model,
		effort: "high",
		tools: READ_ONLY,
		schema: FINDINGS_SCHEMA,
		prompt: `${REVIEW_PREFIX}\n${description}`,
	};
}

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	await log("inicio de repo-audit", { concurrency: limits.concurrency, maxAgents: limits.maxAgents });

	// 1) Gate determinista: evidencia barata y de alta señal (sin cache; refleja el árbol actual).
	const gate = await bash(
		[
			"echo '===TYPECHECK==='; npm run typecheck --silent 2>&1 | tail -30 || true",
			"echo '===BIOME==='; npx biome check . 2>&1 | tail -40 || true",
			"echo '===MARKDOWNLINT==='; npx markdownlint-cli2 2>&1 | tail -40 || true",
		].join("; "),
		{ cache: false },
	);
	await writeArtifact("gate.txt", gate?.stdout || String(gate || ""));
	await log("gate determinista capturado", {});

	// 2) Fan-out de áreas de revisión.
	const areas = [
		reviewItem(
			"core-runtime",
			"El runtime CORE de Dynamic Workflows. Priorizá los archivos de mayor riesgo: extensions/pandi-dynamic-workflows/index.ts (dispatcher de subagentes, journal/resume, runAsk/runBash/runSubagent, makeApi, handleTool), concurrency-primitives.ts (cancelación de race/agents/parallel/pipeline), process-spawn.ts, agent-env-persona.ts (aislamiento de keys/env, resolución de web_search/context7), worker-source.ts y types.ts. Concentrate en concurrencia, cancelación, corrección de resume/journal y manejo de secretos.",
			"anthropic/claude-opus-4-8",
		),
		reviewItem(
			"loops-goal-plan",
			"Extensiones de loops persistentes: extensions/pandi-loop, extensions/pandi-goal y extensions/pandi-plan. Revisá cada archivo *.ts (omití tests/). Concentrate en la rehidratación de estado, los límites de iteraciones/deadlines, los gates de trust/mode, la aplicación del modo de solo lectura de plan y la lógica de verifier/gate.",
		),
		reviewItem(
			"context-effort",
			"extensions/pandi-effort, extensions/pandi-local-memory, extensions/pandi-auto-compact y extensions/pandi-btw. Revisá cada archivo *.ts (omití tests/). Concentrate en el parseo y los defaults de variables de entorno, la seguridad de la inyección de memoria, la corrección de compaction/snapshot y las garantías de no usar tools.",
		),
		reviewItem(
			"devtools",
			"extensions/pandi-typescript-lsp, extensions/pandi-worktree, extensions/pandi-container y extensions/pandi-bg. Revisá cada archivo *.ts (omití tests/). Concentrate en el spawn mediante argv frente a shell, el manejo de PID/identity, la resolución de tsc, los guards de plataforma de containers y el ciclo de vida de jobs en background y sus escrituras atómicas.",
		),
		reviewItem(
			"ux-aliases",
			"extensions/pandi-mdview, extensions/pandi-rename, extensions/pandi, extensions/pandi-exit, extensions/pandi-clear y extensions/shared. Revisá cada archivo *.ts (omití tests/). Concentrate en la coexistencia de aliases (nunca sobrescribir los nativos), timeouts/fallbacks y helpers compartidos del harness.",
		),
		reviewItem(
			"docs-consistency",
			"Consistencia DOC/CODE. Compará las afirmaciones del README.md raíz y de cada extensions/*/README.md con el código REAL: nombres de slash commands, nombres de tools de modelos, nombres Y defaults de variables de entorno, rutas de archivos y comportamiento documentado. Informá cada divergencia (el README dice X, el código hace Y) con ambas citas. Señalá también las contradicciones internas entre documentos.",
		),
		reviewItem(
			"config-manifest",
			"Consistencia CONFIG/MANIFEST. Comprobá: `pi.extensions` de package.json frente a los directorios reales de extensions/ (faltantes o adicionales); `files` frente a lo que debe distribuirse; corrección de scripts; `pi.skills` frente a los skills en disco; coherencia entre biome.jsonc, .gitignore y tsconfig.json; los scaffolds de Pi (extensions/pandi-dynamic-workflows/scaffolds/*.js) frente a los archivos generados .claude/workflows/*.js (evaluá `node .claude/scripts/generate-claude-workflows.mjs --check` mentalmente o mediante lectura); y .env.example frente al uso real de PI_*. Informá las discrepancias con citas.",
		),
	];

	const requestedConcurrency = Number.isFinite(+input.concurrency) ? Math.max(1, Math.floor(+input.concurrency)) : 4;
	const concurrency = Math.max(1, Math.min(requestedConcurrency, limits.concurrency));
	if (concurrency !== requestedConcurrency) log(`concurrency limitada ${requestedConcurrency} -> ${concurrency} por limits.concurrency=${limits.concurrency}`);
	const recommendedMaxAgents = areas.length + 1;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) log(`ADVERTENCIA: maxAgents puede quedar justo para repo-audit ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, areas: areas.length, synthesis: 1 })}`);
	await log("fan-out de revisión", { areas: areas.length, concurrency, recommendedMaxAgents });
	const reviews = await agents(areas, { concurrency, settle: true });
	const ok = reviews.filter(Boolean);
	const failed = reviews.length - ok.length;
	await log("revisiones completas", { ok: ok.length, failed });

	const allFindings = [];
	ok.forEach((r, i) => {
		const data = r?.data || r?.output || r;
		const arr = Array.isArray(data?.findings) ? data.findings : [];
		for (const f of arr) allFindings.push({ area: areas[i]?.label, ...f });
	});
	await writeArtifact("raw-findings.json", allFindings);
	await log("hallazgos recopilados", { total: allFindings.length });

	// 3) Síntesis como juez.
	const synthPrompt = [
		"Sos el JUEZ DE SÍNTESIS de una auditoría de solo lectura del repo (bugs e inconsistencias) de un monorepo de extensiones de Pi.",
		"Tarea: a partir de los hallazgos sin procesar y de la salida del gate determinista que aparecen abajo, generá un informe sin duplicados y priorizado.",
		"Reglas: DESCARTÁ cualquier hallazgo sin file/evidence concretos. Fusioná duplicados entre áreas. Ordená por severity (high primero) y luego por radio de impacto. Para cada hallazgo conservado indicá: severity, category, file:line, qué está mal, por qué importa y una corrección concreta. Enumerá por separado todo lo que parezca WIP en curso DE OTRA SESIÓN (por ejemplo, el skill open-prose o cambios frecuentes en skills-lock), para que quien lea no lo confunda con defectos reales.",
		"Sé transparente sobre la cobertura: mencioná cuántas ramas de revisión fallaron o quedaron vacías y qué NO se cubrió.",
		"Generá Markdown con estas secciones: `## Resumen` (conteos por severity), `## Hallazgos priorizados` (numerados), `## Gate determinista` (estado de typecheck/biome/markdownlint), `## Posible WIP ajeno` y `## Cobertura y límites`.",
		"",
		"=== SALIDA DEL GATE DETERMINISTA ===",
		compact(gate?.stdout || String(gate || ""), 8000),
		"",
		"=== HALLAZGOS SIN PROCESAR (JSON) ===",
		compact(allFindings, 40000),
		"",
		`Ramas: ${ok.length} ok, ${failed} fallidas de ${reviews.length}. Reiterá: eliminá duplicados y priorizá por severity, descartá lo no sustentado, separá el WIP en curso y explicitá los huecos de cobertura.`,
	].join("\n");

	const report = await agent(synthPrompt, { model: "anthropic/claude-opus-4-8", effort: "high", tools: READ_ONLY });
	await writeArtifact("audit-report.md", typeof report === "string" ? report : compact(report, 40000));
	await log("síntesis terminada", {});
	return { areas: areas.length, reviewsFailed: failed, totalFindings: allFindings.length, report };
}
