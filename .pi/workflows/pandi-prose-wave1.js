// pandi-prose-wave1 — Fase 2 ola 1 del restyle "personalidad de Pandi como condimento":
// aplica la fila docs/skills de la matriz superficie×dosis (.pi/skills/pandi-prose-style) a
// README.md, AGENTS.md, docs top-level, handbooks y skills. Un editor por archivo (diff mínimo,
// dosis de tono leve, 🐼 ≤ 1 y cero está bien) → panel adversarial (accuracy + dosis) → fixes →
// verify (markdownlint + diffstat como artifact). EXCLUYE docs/scaffolds (regenerables),
// docs/research (archival), docs/html y docs/conversaciones. Los sync-mirrors, npm test y los
// commits los hace el orquestador DESPUÉS de inspeccionar. Input: { concurrency?, skipReview? }
export const meta = {
	name: "pandi-prose-wave1",
	description: "Ola 1 del restyle Pandi (docs + skills): editores por archivo bajo la matriz de dosis, review adversarial, fixes y lint.",
	phases: [{ title: "scout" }, { title: "edit" }, { title: "review" }, { title: "fix" }, { title: "verify" }],
};

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	// Contratos TRACKEADOS (nunca leerlos de .pi/tmp/ — es efímero).
	const dose = await readFile(".pi/skills/pandi-prose-style/SKILL.md");
	const docsStyle = await readFile(".pi/skills/didactic-docs-style/SKILL.md");
	const requestedConc = Number.isFinite(+input.concurrency) ? +input.concurrency : 4;
	const conc = Math.max(1, Math.min(requestedConc, limits.concurrency ?? requestedConc));
	if (conc !== requestedConc) log(`concurrency clamped ${requestedConc} -> ${conc}`);

	phase("scout");
	const raw = (await bash(`git ls-files 'README.md' 'AGENTS.md' 'docs/*.md' '.pi/skills/*/SKILL.md'`)).stdout.split("\n").filter(Boolean);
	const EXCLUDE = [/^docs\/html\//, /^docs\/conversaciones\//, /^docs\/research\//, /^docs\/scaffolds\//, /^\.pi\/skills\/pandi-prose-style\//];
	const files = raw.filter((f) => !EXCLUDE.some((rx) => rx.test(f)));
	const excluded = raw.length - files.length;
	log(`work-list: ${files.length} archivos (excluidos ${excluded}: html/conversaciones=fuera de lint, research=archival, scaffolds=regenerables por scaffold-docs-html, pandi-prose-style=el contrato mismo)`);
	await writeArtifact("worklist.json", JSON.stringify({ files, excludedCount: excluded }, null, 2));
	// Snapshot del estado pre-edición para que los reviewers puedan diffear aunque haya otros cambios en el árbol.
	const preDiff = (await bash(`git diff --stat -- ${files.join(" ")} | tail -1`)).stdout.trim();
	if (preDiff) log(`ATENCIÓN: ya había cambios locales en la work-list antes de editar: ${preDiff}`);

	// Prefijo estable del prompt: contratos primero, archivo volátil al final.
	const base =
		`Sos un editor de prosa. Aplicá a UN archivo la "dosis docs/skills" de esta matriz de estilo, AL PIE DE LA LETRA:\n\n${dose}\n\n` +
		`Para documentos Markdown de docs/ también rige este contrato (didáctica/estructura):\n\n${docsStyle}\n\n` +
		`Reglas de ESTA pasada (es una pasada de TONO, no una reescritura):\n` +
		`- Diff MÍNIMO: tocá solo frases donde el tono/concisión mejora de verdad; si el archivo ya está bien, cambiá poco o nada y decilo.\n` +
		`- Personalidad = condimento: calidez en aperturas y transiciones; JAMÁS en tablas de referencia, hechos de API ni instrucciones contractuales.\n` +
		`- 🐼 como máximo UNO por archivo, solo donde cae natural; CERO es un resultado válido. Nunca en frontmatter.\n` +
		`- La descripción del frontmatter de un skill se inyecta en system prompts: mantenela precisa; solo podás redundancia.\n` +
		`- En AGENTS.md las listas de instrucciones son contractuales: concisión sí, adorno mínimo (solo el framing admite calidez).\n` +
		`- Exactitud intocable: ningún hecho se debilita ni se pierde. Cada archivo mantiene su idioma. Markdown válido (markdownlint).\n` +
		`- No toques NINGÚN otro archivo.\n` +
		`Respondé "done" + 2-4 bullets de qué cambiaste (o "no-op" + por qué).\n\n`;

	phase("edit");
	log(`editores: ${files.length} (uno por archivo; supera el hint maxAgents~12 del contrato: granularidad por archivo para diffs mínimos, reviewers read-only)`);
	const edits = await agents(
		files.map((f) => ({
			prompt: `${base}Archivo: ${f}`,
			label: `edit-${f.split("/").slice(-2).join("/")}`,
			phase: "edit", model: "sonnet", effort: "medium", tools: ["read", "bash", "edit"],
		})),
		{ concurrency: conc, settle: true },
	);
	const editFailed = files.filter((_f, i) => edits[i] == null || edits[i]?.error);
	if (editFailed.length) log(`editores FALLIDOS (quedan sin restyle): ${editFailed.join(", ")}`);

	let reviewSummary = "review omitida por input.skipReview";
	let toFix = [];
	if (!input.skipReview) {
		phase("review");
		const FINDINGS = {
			type: "object", additionalProperties: false, required: ["file", "verdict", "mustFix", "pandasAdded"],
			properties: {
				file: { type: "string" },
				verdict: { type: "string", enum: ["ok", "needs-fixes"] },
				mustFix: { type: "array", items: { type: "string" }, description: "Solo problemas reales: hecho perdido/debilitado vs git, dosis violada (>1 🐼, adorno en tabla/API/frontmatter), idioma cambiado, markdown roto." },
				pandasAdded: { type: "number" },
			},
		};
		const reviewed = files.filter((f) => !editFailed.includes(f));
		const reviews = (await agents(
			reviewed.map((f) => ({
				prompt:
					`Sos un revisor adversarial de estilo. Matriz de dosis (contrato):\n\n${dose}\n\n` +
					`Revisá el diff del archivo recién editado con \`git diff -- ${f}\` (y leé el archivo). Reportá SOLO problemas reales: (a) un hecho técnico perdido o debilitado, (b) dosis violada — más de un 🐼, adorno en tablas/hechos de API/frontmatter/instrucciones contractuales, (c) el archivo cambió de idioma, (d) markdown inválido. No reportes gustos. Contá los 🐼 agregados por el diff. Devolvé JSON.\n\nArchivo: ${f}`,
				label: `review-${f.split("/").slice(-2).join("/")}`,
				phase: "review", agentType: "reviewer", model: "sonnet", effort: "high", schema: FINDINGS,
			})),
			{ concurrency: conc, settle: true },
		)).map((r, i) => r?.data ?? (log(`reviewer falló para ${reviewed[i]}`), null)).filter(Boolean);

		toFix = reviews.filter((r) => r.verdict === "needs-fixes" && r.mustFix?.length);
		const pandas = reviews.reduce((n, r) => n + (r.pandasAdded || 0), 0);
		reviewSummary = `${reviews.length} revisados, ${toFix.length} con mustFix, ${pandas} 🐼 agregados en total`;
		log(`review: ${reviewSummary}`);
		await writeArtifact("reviews.json", JSON.stringify(reviews, null, 2));

		if (toFix.length) {
			phase("fix");
			await agents(
				toFix.map((r) => ({
					prompt: `Aplicá EXACTAMENTE estos fixes al archivo ${r.file}; ningún otro cambio:\n${r.mustFix.map((m) => `- ${m}`).join("\n")}\n\nContrato de referencia:\n\n${dose}\n\nRespondé "done" + qué cambiaste.`,
					label: `fix-${r.file.split("/").pop()}`,
					phase: "fix", model: "sonnet", effort: "medium", tools: ["read", "bash", "edit"],
				})),
				{ concurrency: conc, settle: true },
			);
		}
	}

	phase("verify");
	const mdFiles = files.filter((f) => f.startsWith("docs/") || f === "README.md" || f === "AGENTS.md");
	const lint = await bash(`npx markdownlint-cli2 ${mdFiles.join(" ")} 2>&1 | tail -2`);
	log(`markdownlint (docs; los skills están fuera del glob del repo): ${lint.stdout.trim().split("\n").pop()}`);
	const diffstat = (await bash(`git diff --stat -- ${files.join(" ")}`)).stdout;
	await writeArtifact("diffstat.txt", diffstat);
	// Patch COMPLETO como artifact: sesiones concurrentes pueden barrer el working tree; con esto la re-aplicación es un `git apply`.
	await writeArtifact("changes.patch", (await bash(`git diff -- ${files.join(" ")}`)).stdout);
	const summary = {
		files: files.length, excluded, editFailed, review: reviewSummary,
		fixed: toFix.map((r) => r.file), lintTail: lint.stdout.trim().split("\n").pop(),
		pending: "orquestador: sync-skill-mirrors + sync-agent-guides + vendor-extension-skills, npm test, commits style(docs)/style(skills)",
	};
	await writeArtifact("summary.json", JSON.stringify(summary, null, 2));
	log(`resumen ${JSON.stringify(summary)}`);
	return summary;
}
