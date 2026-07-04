// scaffold-docs-html — genera docs/html/scaffolds/<key>.html para cada scaffold del catálogo:
// fan-out (1 agente por scaffold escribe Markdown con diagrama mermaid) → conversión determinística
// con el conversor pandi de pi-docs → índice → verificación.
// Input: { keys?: string[] (subset), concurrency?, model?, effort? }
export const meta = {
	name: "scaffold-docs-html",
	description: "Genera un HTML pandi (diagrama mermaid + explicación completa) por scaffold del catálogo.",
	phases: [{ title: "discover" }, { title: "author" }, { title: "index" }, { title: "convert" }, { title: "verify" }],
};

export default async function main() {
	const input = (() => { try { return typeof args === "string" ? JSON.parse(args) || {} : args || {}; } catch { return {}; } })();
	const SCAFFOLDS_DIR = "extensions/pi-dynamic-workflows/scaffolds";
	const CATALOG = "extensions/pi-dynamic-workflows/catalog.ts";
	// Las fuentes Markdown viven TRACKEADAS en docs/scaffolds/; el HTML es el mirror generado
	// por `npm run sync:docs:html` (docs/html/scaffolds/), no se convierte a mano.
	const MD_DIR = "docs/scaffolds";
	const OUT_DIR = "docs/html/scaffolds";

	phase("discover");
	const ls = await bash(`ls ${SCAFFOLDS_DIR}`);
	let keys = ls.stdout.split("\n").filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
	if (Array.isArray(input.keys) && input.keys.length) {
		const subset = new Set(input.keys);
		const skipped = keys.filter((k) => !subset.has(k));
		keys = keys.filter((k) => subset.has(k));
		log(`subset solicitado: ${keys.length} keys; EXCLUIDOS ${skipped.length}: ${skipped.join(", ")}`);
	}
	if (keys.length === 0) throw new Error("No se encontraron scaffolds.");
	const catalogSrc = await readFile(CATALOG);
	const requestedConc = Number.isFinite(+input.concurrency) ? +input.concurrency : 6;
	const conc = Math.max(1, Math.min(requestedConc, limits.concurrency ?? requestedConc));
	if (conc !== requestedConc) log(`concurrency clamped ${requestedConc} -> ${conc} (limits)`);
	log(`scaffolds descubiertos: ${keys.length} · concurrency efectiva: ${conc}`);
	await bash(`mkdir -p ${MD_DIR} ${OUT_DIR}`);

	// Prompt con prefijo estable; lo volátil (key) va al final.
	// Contrato de estilo didáctico trackeado: single source of truth del estándar.
	const style = await readFile(".pi/skills/didactic-docs-style/SKILL.md");
	const basePrompt =
		`Contrato de estilo didáctico (cumplilo AL PIE DE LA LETRA):\n\n${style}\n\n` +
		`Sos un documentador técnico del repo pi-dynamic-workflows. Tu tarea: escribir la documentación COMPLETA en Markdown (en español, tono técnico, no marketing) de UN workflow scaffold.\n\n` +
		`Fuentes (leelas con tus tools de lectura):\n` +
		`- El código fuente del scaffold: ${SCAFFOLDS_DIR}/<key>.js (leelo ENTERO; es la fuente de verdad).\n` +
		`- Su entrada en el catálogo (blurb + use cases): ${CATALOG}.\n\n` +
		`Estructura EXACTA del Markdown (usá estos encabezados):\n` +
		`# <key>\n` +
		`> blurb de una línea (del catálogo, traducido)\n\n` +
		`## Diagrama\n` +
		"Un fence ```mermaid con un flowchart TD que refleje FIELMENTE la estructura del scaffold: fases, agentes/fan-outs (mostrá paralelismo con subgraphs o nodos worker), pipelines, loops, gates de decisión y síntesis. Derivalo del código real, no del nombre. Sintaxis mermaid válida (etiquetas entre comillas si tienen caracteres especiales; sin paréntesis sueltos en labels).\n\n" +
		`## Qué hace\n2-4 párrafos.\n\n` +
		`## Cuándo usarlo\nBullets con casos de uso (incluí los del catálogo) y cuándo NO usarlo.\n\n` +
		`## Cómo funciona\nExplicación fase por fase siguiendo el código: qué hace cada fase, qué primitivas usa (agent/agents/parallel/pipeline/workflow), qué personas/modelos, cómo maneja fallos parciales y caching.\n\n` +
		`## Input y output\nTabla o bullets con el shape del input (campos, defaults, clamps) y qué retorna + qué artifacts escribe (writeArtifact).\n\n` +
		`## Fases\nLista numerada de las fases declaradas en meta.phases (o las llamadas phase()).\n\n` +
		`Reglas: nada de inventar comportamiento que no esté en el código; si algo es configurable, mostrá el default. Escribí el resultado con tu tool de escritura en ${MD_DIR}/<key>.md y respondé solo "done <key>".\n\n`;

	const authorSpec = (key) => ({
		prompt: `${basePrompt}El scaffold que te toca: key = ${key}. Archivo: ${SCAFFOLDS_DIR}/${key}.js. Salida: ${MD_DIR}/${key}.md`,
		label: `author-${key}`,
		phase: "author",
		agentType: "explore",
		model: input.model ?? "sonnet",
		effort: input.effort ?? "medium",
		tools: ["read", "bash", "write"],
	});

	phase("author");
	const results = await agents(keys.map(authorSpec), { concurrency: conc, settle: true });
	let failed = keys.filter((_k, i) => results[i] == null || results[i]?.error);
	if (failed.length) {
		log(`fallaron ${failed.length}/${keys.length} autores; reintento una vez: ${failed.join(", ")}`);
		const retry = await agents(failed.map(authorSpec), { concurrency: Math.min(conc, failed.length), settle: true });
		failed = failed.filter((_k, i) => retry[i] == null || retry[i]?.error);
	}
	if (failed.length) log(`SIN DOC tras reintento (${failed.length}): ${failed.join(", ")}`);
	const authored = keys.filter((k) => !failed.includes(k));

	phase("index");
	const ok = authored;
	const indexMd = await agent(
		`Escribí un index.md (en español) para la carpeta de documentación de workflow scaffolds. Para cada scaffold listado abajo: un item con link [\`<key>\`](./<key>.md) y su blurb de una línea tomado del catálogo (traducido). Agrupá por afinidad (verificación, research, fan-out, meta/composición, iterativos, etc.) con secciones H2. Título H1: "Workflow scaffolds". Aclarar al inicio qué es un scaffold (patrón ejecutable del catálogo de pi-dynamic-workflows). Respondé SOLO el Markdown.\n\nScaffolds documentados: ${ok.join(", ")}${failed.length ? `\nSIN página (mencionalos en una nota final como pendientes): ${failed.join(", ")}` : ""}\n\nCatálogo:\n${catalogSrc}`,
		{ label: "index", phase: "index", model: input.model ?? "sonnet", effort: "medium" },
	);
	// Robustez: si el agente envuelve la respuesta en un fence ```markdown, lo quitamos.
	const cleanIndex = String(indexMd).replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, "$1");
	await writeFile(`${MD_DIR}/index.md`, cleanIndex);

	phase("convert");
	const sync = await bash("npm run sync:docs:html");
	const convFails = [];
	if ((sync.code ?? 0) !== 0) { convFails.push("sync:docs:html"); log(`sync:docs:html falló: ${sync.stderr.slice(0, 300)}`); }

	phase("verify");
	const count = await bash(`ls ${OUT_DIR}/*.html | wc -l`);
	const noMermaid = [];
	for (const k of ok) {
		const g = await bash(`grep -c 'class="mermaid"' ${OUT_DIR}/${k}.html || true`);
		if (!(+g.stdout.trim() > 0)) noMermaid.push(k);
	}
	if (noMermaid.length) log(`páginas SIN diagrama mermaid: ${noMermaid.join(", ")}`);
	const summary = { total: keys.length, authored: authored.length, converted: ok.length, failedAuthors: failed, failedConversions: convFails, missingDiagram: noMermaid, htmlCount: +count.stdout.trim() };
	await writeArtifact("summary.json", JSON.stringify(summary, null, 2));
	log(`resumen ${JSON.stringify(summary)}`);
	return summary;
}
