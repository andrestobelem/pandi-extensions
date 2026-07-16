/**
 * Builder puro model→HTML para el reporte de run de workflow (registro de diseño, run bd039ef9).
 *
 * Contrato (pineado por observe/security.test.mjs):
 * - Cada string del modelo es UNTRUSTED DATA: la mayoría de strings renderiza vía el escaper de 5 chars;
 *   las salidas de agentes renderizan como Markdown solo vía marked + sanitize-html con allowlist estricta.
 * - La página emite EXACTAMENTE dos bloques <script>, ambos literales fijos para el
 *   renderer del diagrama Mermaid del run: el loader (URL de CDN pineada a una versión
 *   exacta + hash Subresource Integrity, así una CDN comprometida/con contenido distinto
 *   falla cerrado — el browser se niega a correrlo — en vez de ejecutar JS arbitrario) y
 *   el init call (`securityLevel: "sandbox"`: el diagrama renderiza en un iframe aislado,
 *   sin acceso al DOM de la página padre). Ningún otro <script> puede aparecer nunca, y
 *   ninguno de estos dos interpola strings del modelo. El resto de los colapsables usa
 *   <details>/<summary> nativos, sin sink DOM para contenido inyectado.
 * - Los hrefs son solo relativos: paths absolutos, parent traversal y esquemas URL se
 *   rechazan (el collector también chequea contención; esto es defense-in-depth), y
 *   los valores de atributos se URL-encodean por segmento de path.
 * - Autocontenido salvo esa única excepción pineada (el <script src> de Mermaid): solo CSS
 *   inline (tokens pandi, claro+oscuro) y esa CDN; ningún otro asset de red.
 * - Sin fs, sin ctx, sin Date.now(): todos los tiempos vienen del modelo (generatedAt),
 *   así la regeneración desde un modelo fijo es byte-stable.
 */

import { pillClass, renderWorkflowMonitor, summarizeProgress } from "./html-agents.js";
import { textBlock } from "./html-builders.js";
import { LAYOUT_CSS, PANDI_TOKENS_CSS } from "./html-css.js";
import {
	renderArtifactSection,
	renderBasedOnSection,
	renderCallouts,
	renderHeaderChips,
	renderIntegritySection,
	renderLogSection,
	renderMermaidSection,
	renderMetricsSection,
	renderPhaseSection,
	renderSchemasSection,
} from "./html-report-sections.js";
import { openingText, renderAgent } from "./html-sections.js";
import { escapeHtml } from "./safe-html.js";

export { PANDI_TOKENS_CSS } from "./html-css.js";
export { buildRunMermaidSource } from "./html-mermaid.js";
export { escapeHtml, safeRelativeHref } from "./safe-html.js";

export interface RunReportText {
	text: string;
	truncated: boolean;
}

export interface RunReportBasedOn {
	name: string;
	role?: string;
	desc?: string;
}

export interface RunReportAgent {
	id: number;
	name: string;
	/** AgentMonitorState más el vocabulario de reporte "interrupted" (agente running mientras el run es terminal). */
	state: string;
	ok?: boolean;
	code?: number;
	killed?: boolean;
	startedAt?: string;
	endedAt?: string;
	elapsedMs?: number;
	model?: string;
	thinking?: string;
	schemaOk?: boolean;
	phaseLabel?: string;
	phaseId?: number;
	phaseIndex?: number;
	phaseTotal?: number;
	promptPreview?: string;
	/** Copia textual del prompt; los runs nuevos la obtienen desde eventos estructurados acotados. */
	prompt?: RunReportText;
	output?: RunReportText;
	outputChars?: number;
	outputEmpty?: boolean;
	outputTruncated?: boolean;
	stdoutTruncated?: boolean;
	stdoutChars?: number;
	/** Datos estructurados reserializados (nunca bytes crudos). */
	data?: RunReportText;
	stderrTail?: { text: string; href?: string };
	stdoutHref?: string;
	artifactHref?: string;
	promptAvailable?: boolean;
	tools?: string;
	excludeTools?: string;
	skills?: string;
	includeSkills?: boolean;
	extensions?: string;
	includeExtensions?: boolean;
	keys?: string;
	missingKeys?: string;
	isolatedEnv?: boolean;
	metrics?: {
		turns?: number;
		inputTokensPeak?: number;
		outputTokensTotal?: number;
		totalTokens?: number;
		costTotal?: number;
		toolCalls?: number;
		toolErrors?: number;
		autoRetries?: number;
	};
	/** True cuando el presupuesto inline global limitó este agente a metadata + links. */
	inlineOmitted?: boolean;
}

export interface RunReportModel {
	workflow: string;
	runId: string;
	scriptPath?: string;
	scope?: string;
	/** running | completed | failed | cancelled | stale */
	state: string;
	/** "verified" (veredicto readRunStatus en sesión) o "unverified" (snapshot de dir externo). */
	liveness: "verified" | "unverified";
	generatedAt: string;
	/** Refresh opt-in del browser para reportes watched regenerados por servidor; se ignora salvo que state sea running. */
	autoRefreshSeconds?: number;
	startedAt?: string;
	endedAt?: string;
	updatedAt?: string;
	elapsedMs?: number;
	agentConcurrency?: number;
	maxAgents?: number;
	peakParallelAgents?: number;
	error?: string;
	codeDrift?: "match" | "changed" | "missing" | "unknown";
	input?: RunReportText;
	output?: RunReportText;
	outputFormat?: "pre" | "markdown";
	basedOn?: RunReportBasedOn[];
	/** Cómo se extrajo la estructura del preview ("estático (parse-only)" | "evaluado"); chip opcional. */
	previewMode?: string;
	/** Structured-output schemas del workflow (vista pre-launch de Claude Code; opcional en runs). */
	schemas?: { name: string; json: string }[];
	/** Texto completo del script del workflow, para la sección colapsable "Script". */
	script?: RunReportText;
	logs: { time: string; message: string; details?: string }[];
	phases: { label: string; time: string; source?: "event" | "log" }[];
	agents: RunReportAgent[];
	integrity?: {
		agentResults?: number;
		failedAgents?: number;
		emptyOutputAgents?: number;
		outputTruncatedAgents?: number;
		stdoutTruncatedAgents?: number;
		timedOutAgents?: number;
		schemaFailedAgents?: number;
	};
	metricsTotals?: {
		measuredAgents?: number;
		okAgents?: number;
		failedAgents?: number;
		outputTokensTotal?: number;
		costTotal?: number;
		toolCalls?: number;
		toolErrors?: number;
		autoRetries?: number;
	};
	artifacts: { path: string; bytes?: number }[];
	artifactsOmitted?: number;
	missingFiles: string[];
	/** Callouts visibles de clamp: los clamps nunca son silenciosos (regla pandi 5). */
	clampNotes: string[];
}

export function buildRunReportHtml(model: RunReportModel): string {
	const summary = summarizeProgress(model);
	const statePill = `<span class="rpill ${pillClass(model.state)}">${escapeHtml(model.state)}</span>`;
	const autoRefreshSeconds =
		model.state === "running" && model.autoRefreshSeconds !== undefined
			? Math.max(1, Math.round(model.autoRefreshSeconds))
			: undefined;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${autoRefreshSeconds !== undefined ? `<meta http-equiv="refresh" content="${autoRefreshSeconds}">` : ""}
<title>${escapeHtml(`${model.workflow} — run report`)}</title>
<style>
${PANDI_TOKENS_CSS}
${LAYOUT_CSS}
</style>
</head>
<body>
<div class="container">
<header>
<div class="kicker">Pandi artifact · workflow run report</div>
<h1>${escapeHtml(model.workflow)} ${statePill}</h1>
<div class="sub">${escapeHtml(model.scriptPath ?? "")}</div>
<div class="chips">${renderHeaderChips(model, summary)}</div>
</header>
<p class="opening">${escapeHtml(openingText(model, summary))}</p>
${renderCallouts(model, autoRefreshSeconds)}
${renderWorkflowMonitor(model, summary)}
${textBlock("Input", model.input)}
${model.output ? `<h2>Final output</h2>${textBlock("Output", model.output, true, model.outputFormat === "markdown" ? "markdown" : "structured")}` : ""}
${renderIntegritySection(model.integrity)}
${renderMetricsSection(model.metricsTotals)}
${renderBasedOnSection(model.basedOn)}
${renderSchemasSection(model.schemas)}
${model.script ? `<h2>Script</h2>${textBlock("Script", model.script)}` : ""}
${renderPhaseSection(model)}
${renderMermaidSection(model)}
<h2>Agents (${model.agents.length})</h2>
${model.agents.map(renderAgent).join("\n")}
${renderLogSection(model.logs)}
${renderArtifactSection(model.artifacts, model.artifactsOmitted)}
</div>
</body>
</html>
`;
}
