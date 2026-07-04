// didactic-docs — mejora didáctica por lotes de toda la documentación de dynamic workflows:
// editores en paralelo (guía, README, handbook, 25 primitivas, 25 scaffolds) con contrato de estilo
// compartido → panel de revisión (accuracy + didáctica) → fixes → verificación (lint + reconversión HTML).
// Input: { concurrency?, skipScaffolds?, skipReview? }
export const meta = {
	name: "didactic-docs",
	description: "Mejora didáctica de la documentación de dynamic workflows con revisión adversarial.",
	phases: [{ title: "edit" }, { title: "review" }, { title: "fix" }, { title: "verify" }],
};

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const EXT = "extensions/pandi-dynamic-workflows";
	const PRIM = `${EXT}/primitives`;
	const MD_DIR = ".pi/tmp/scaffold-docs";
	const OUT_DIR = "docs/html/scaffolds";
	const CONVERTER = "extensions/pandi-docs/scripts/markdown-to-html.mjs";
	// Contrato de estilo TRACKEADO (single source of truth del estándar didáctico);
	// nunca leerlo de .pi/tmp/ — ese directorio es efímero y ya perdimos drafts ahí.
	const style = await readFile(".pi/skills/didactic-docs-style/SKILL.md");
	// Contrato de dosis de tono Pandi: se pasa junto al didáctico para que el tono sobreviva regeneraciones.
	const dose = await readFile(".pi/skills/pandi-prose-style/SKILL.md");
	const requestedConc = Number.isFinite(+input.concurrency) ? +input.concurrency : (limits.concurrency ?? 4);
	const conc = Math.max(1, Math.min(requestedConc, limits.concurrency ?? requestedConc));
	if (conc !== requestedConc) log(`concurrency clamped ${requestedConc} -> ${conc}`);

	const primFiles = (await bash(`ls ${PRIM}`)).stdout.split("\n").filter((f) => f.endsWith(".md"));
	const scaffoldMds = input.skipScaffolds ? [] : (await bash(`ls ${MD_DIR}`)).stdout.split("\n").filter((f) => f.endsWith(".md") && f !== "index.md");
	if (input.skipScaffolds) log("scaffolds EXCLUIDOS por input.skipScaffolds");

	const base =
		`Sos un editor técnico senior. Mejorá UN documento de la documentación de dynamic workflows siguiendo este contrato de estilo AL PIE DE LA LETRA:\n\n${style}\n\n` +
		`Contrato de dosis de tono (fila "Docs": condimento leve, 🐼 ≤ 1 por doc y cero es válido, jamás en tablas/hechos/frontmatter):\n\n${dose}\n\n` +
		`Método: (1) leé el documento entero; (2) verificá los hechos dudosos contra el código fuente indicado; (3) reescribilo en el MISMO archivo con tus tools de edición/escritura. No toques ningún otro archivo. Respondé solo "done" más una lista de 3-5 cambios didácticos que hiciste.\n\n`;

	const editorSpecs = [
		{
			key: "guide",
			prompt: `${base}Documento: docs/dynamic-workflows.md (la guía completa). Es correcta pero densa: arranca en referencia sin quickstart y no tiene diagramas. Reestructurala con divulgación progresiva; agregá (a) un quickstart de ~20 líneas con un workflow mínimo y cómo correrlo, (b) un flowchart mermaid "¿qué primitiva uso?" (agents/pipeline/parallel/race/workflow), (c) un diagrama mermaid del ciclo de ejecución, (d) tablas de decisión donde hoy hay párrafos largos. Código fuente para verificar: ${EXT}/*.ts y ${EXT}/primitives/. Mantené TODO el contenido factual (es LA referencia).`,
			label: "edit-guide", model: "opus", effort: "high",
		},
		{
			key: "readme",
			prompt: `${base}Documento: ${EXT}/README.md (README del paquete npm). Audiencia: alguien que lo descubre; necesita entender en 30 segundos qué gana y cómo probarlo. Agregá un ejemplo mínimo end-to-end (crear un workflow de 10 líneas y correrlo) temprano. Verificá comandos contra ${EXT}/command-handlers.ts.`,
			label: "edit-readme", model: "sonnet", effort: "high",
		},
		{
			key: "handbook",
			prompt: `${base}Documentos (los dos, en el mismo turno): docs/handbooks/workflow-catalog.md y su entrada en docs/handbooks/README.md. El catálogo es una quick reference por familia: agregá al inicio una tabla/flowchart de decisión "qué familia según tu problema" y por scaffold un one-liner de cuándo elegirlo sobre sus vecinos. Linkeá las páginas HTML por scaffold (docs/html/scaffolds/<key>.html). Verificá contra ${EXT}/catalog.ts.`,
			label: "edit-handbook", model: "sonnet", effort: "medium",
		},
		...primFiles.map((f) => ({
			key: `prim:${f}`,
			prompt: `${base}Documento: ${PRIM}/${f} (referencia de una primitiva/global inyectado; se shippea en el paquete npm — mantenelo ≤ ~65 líneas). Asegurá: apertura en 30 segundos, UN ejemplo mínimo ejecutable (3-8 líneas) verificado contra la implementación en ${EXT}/ (buscá con grep el global correspondiente), y secciones "When to use / not" y "Gotchas" nítidas. Mantené el formato de encabezados existente (Runtime/Signature/Returns).`,
			label: `edit-${f.replace(".md", "")}`, model: "sonnet", effort: "medium",
		})),
		...scaffoldMds.map((f) => ({
			key: `scaf:${f}`,
			prompt: `${base}Documento: ${MD_DIR}/${f} (fuente Markdown en español de la página HTML del scaffold ${f.replace(".md", "")}). Agregá tras el blurb una sección "## En 30 segundos" (2-3 frases llanas: qué hace y cuándo lo elegirías) y una sección "## Cómo lanzarlo" con un ejemplo real: \`/workflow new mi-run --pattern=${f.replace(".md", "")}\` + un input JSON típico (verificalo contra el shape de input documentado más abajo en el mismo doc y contra ${EXT}/scaffolds/${f.replace(".md", ".js")}). Mejorá claridad del resto sin perder fidelidad al código. Mantené el fence mermaid intacto salvo error evidente.`,
			label: `edit-${f.replace(".md", "")}-scaffold`, model: "sonnet", effort: "medium",
		})),
	].map((s) => ({ ...s, phase: "edit", tools: ["read", "bash", "write", "edit"] }));

	const sampleReviewCount = input.skipReview ? 0 : Math.min(11, editorSpecs.length);
	const recommendedMaxAgents = editorSpecs.length + sampleReviewCount + sampleReviewCount;
	if (limits.maxAgents && recommendedMaxAgents > limits.maxAgents) {
		log(`WARNING: maxAgents may be tight for full didactic-docs pass ${JSON.stringify({ recommendedMaxAgents, limit: limits.maxAgents, editors: editorSpecs.length, sampleReviewCount, possibleFixers: sampleReviewCount })}`);
	}

	phase("edit");
	log(`editores: ${editorSpecs.length} (guide, readme, handbook, ${primFiles.length} primitivas, ${scaffoldMds.length} scaffolds); concurrency=${conc}; recommendedMaxAgents~${recommendedMaxAgents}`);
	const edits = await agents(editorSpecs.map(({ key, ...s }) => s), { concurrency: conc, settle: true });
	const editFailed = editorSpecs.filter((_s, i) => edits[i] == null || edits[i]?.error).map((s) => s.key);
	if (editFailed.length) log(`editores FALLIDOS (quedan sin mejorar): ${editFailed.join(", ")}`);

	let reviewSummary = "review omitida por input.skipReview";
	if (!input.skipReview) {
		phase("review");
		const sample = [
			"docs/dynamic-workflows.md",
			`${EXT}/README.md`,
			"docs/handbooks/workflow-catalog.md",
			...primFiles.slice(0, 4).map((f) => `${PRIM}/${f}`),
			...scaffoldMds.slice(0, 4).map((f) => `${MD_DIR}/${f}`),
		];
		log(`review sobre ${sample.length} docs (muestra; primitivas/scaffolds restantes NO se revisan individualmente)`);
		const FINDINGS = {
			type: "object", additionalProperties: false, required: ["file", "verdict", "mustFix"],
			properties: {
				file: { type: "string" },
				verdict: { type: "string", enum: ["ok", "needs-fixes"] },
				mustFix: { type: "array", items: { type: "string" }, description: "Solo problemas concretos: inexactitud vs código, ejemplo que no correría, mermaid inválido, lint roto, regresión de contenido." },
			},
		};
		const reviews = (await agents(
			sample.map((f) => ({
				prompt:
					`Sos un revisor adversarial de documentación. Contrato de estilo:\n\n${style}\n\nRevisá el documento ${f} recién editado. Buscá SOLO problemas reales: (a) afirmaciones que contradigan el código en ${EXT}/ (verificá leyendo la implementación), (b) ejemplos que no correrían tal cual, (c) mermaid con sintaxis inválida, (d) contenido factual que se haya perdido respecto de git (usá \`git diff -- ${f}\` si está trackeado), (e) violaciones del contrato. No reportes gustos de estilo. Devolvé JSON.`,
				label: `review-${f.split("/").pop()}`, phase: "review", agentType: "reviewer", model: "sonnet", effort: "high", schema: FINDINGS,
			})),
			{ concurrency: conc, settle: true },
		)).map((r, i) => r?.data ?? (log(`reviewer falló para ${sample[i]}`), null)).filter(Boolean);

		const toFix = reviews.filter((r) => r.verdict === "needs-fixes" && r.mustFix?.length);
		reviewSummary = `${reviews.length} revisados, ${toFix.length} con mustFix`;
		log(`review: ${reviewSummary}`);
		await writeArtifact("reviews.json", JSON.stringify(reviews, null, 2));

		if (toFix.length) {
			phase("fix");
			await agents(
				toFix.map((r) => ({
					prompt: `Aplicá EXACTAMENTE estos fixes al documento ${r.file} (verificando contra el código en ${EXT}/ cuando corresponda); no hagas otros cambios:\n${r.mustFix.map((m) => `- ${m}`).join("\n")}\n\nContrato de estilo de referencia:\n\n${style}\n\nRespondé "done" + qué cambiaste.`,
					label: `fix-${r.file.split("/").pop()}`, phase: "fix", model: "sonnet", effort: "medium", tools: ["read", "bash", "write", "edit"],
				})),
				{ concurrency: conc, settle: true },
			);
		}
	}

	phase("verify");
	const lint = await bash(`npx markdownlint-cli2 "docs/dynamic-workflows.md" "docs/handbooks/*.md" "${EXT}/README.md" "${EXT}/primitives/*.md" 2>&1 | tail -3`);
	log(`markdownlint: ${lint.stdout.trim().split("\n").pop()}`);
	const convFails = [];
	for (const f of scaffoldMds) {
		const k = f.replace(".md", "");
		const r = await bash(`node ${CONVERTER} ${MD_DIR}/${f} -o ${OUT_DIR}/${k}.html --kicker "Workflow scaffold"`);
		if ((r.code ?? 0) !== 0) { convFails.push(k); log(`reconversión falló: ${k}`); }
	}
	const summary = { editors: editorSpecs.length, editFailed, review: reviewSummary, lintTail: lint.stdout.trim().split("\n").pop(), reconvertFailed: convFails };
	await writeArtifact("summary.json", JSON.stringify(summary, null, 2));
	log(`resumen ${JSON.stringify(summary)}`);
	return summary;
}
