/**
 * Builder puro model→HTML para el reporte de run de workflow (registro de diseño, run bd039ef9).
 *
 * Contrato (pineado por run-report-security.test.mjs):
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

const MERMAID_CDN_VERSION = "11.15.0";
const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.min.js`;
// Hash SHA-384 calculado en local contra el mermaid.min.js publicado en npm para esta
// versión exacta (node_modules/mermaid/dist/mermaid.min.js) — no se confió en la CDN a
// ciegas. Si el archivo servido por la CDN alguna vez no matchea, el navegador se niega a
// ejecutarlo (Subresource Integrity): falla cerrado, nunca ejecuta contenido inesperado.
const MERMAID_CDN_INTEGRITY = "sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF";

import { mermaidLabel } from "./graph-parse.js";
import { formatElapsedMs } from "./presentation.js";
import { LAYOUT_CSS, PANDI_TOKENS_CSS } from "./run-report-html-css.js";
import { renderRunReportMarkdown } from "./run-report-markdown.js";
import { artifactViewerHref, escapeHtml, safeRelativeHref } from "./run-report-safe-html.js";

export { escapeHtml, PANDI_TOKENS_CSS, safeRelativeHref };

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

function mermaidStateClass(agent: RunReportAgent): "completed" | "failed" | "running" | "other" {
	if (agent.ok === false || agent.state === "failed") return "failed";
	if (agent.state === "completed" || agent.ok === true) return "completed";
	if (agent.state === "running") return "running";
	return "other";
}

// Tonos pastel (no los sólidos/saturados típicos de mermaid): el diagrama vive al lado de
// la estética más suave del resto del reporte (pills de estado con fondo tenue + borde),
// y un bloque sólido bien saturado se siente más fuerte que el resto de la página.
const MERMAID_STATE_STYLES: Record<string, string> = {
	completed: "fill:#8fd6ab,color:#0b2e1d,stroke:#3fa066",
	failed: "fill:#f2a9a3,color:#3a0e0b,stroke:#d1554a",
	running: "fill:#9dc6f2,color:#0b2440,stroke:#4f86c9",
	other: "fill:#c7ccd1,color:#1c1f22,stroke:#8b939b",
};

const MAX_DETAILED_MERMAID_AGENTS_PER_GROUP = 12;

/**
 * Flowchart Mermaid del run concreto: agentes agrupados por fase en orden de aparición,
 * coloreados por estado. Complementa — no reemplaza — el grafo estático de workflow-graph.ts
 * (que dibuja la ESTRUCTURA del código, no una corrida). La fuente se escapa como texto antes
 * de llegar al contenedor `.mermaid` y también queda disponible como fallback colapsable; el
 * render client-side está pineado por run-report-security.test.mjs (CDN exacta + SRI + sandbox).
 */
interface RunMermaidGroup {
	label: string;
	agents: RunReportAgent[];
}

interface RunMermaidWave {
	agents: RunReportAgent[];
}

function timestampMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function inferPhaseForAgent(
	agent: RunReportAgent,
	phases: RunReportModel["phases"],
): { key: string; label: string } | undefined {
	if (agent.phaseId !== undefined || agent.phaseLabel) {
		const key = agent.phaseId !== undefined ? `p${agent.phaseId}` : `label:${agent.phaseLabel}`;
		return { key, label: agent.phaseLabel ?? `Phase ${agent.phaseId}` };
	}
	const ref = timestampMs(agent.startedAt) ?? timestampMs(agent.endedAt);
	if (ref === undefined) return undefined;
	let chosen: RunReportModel["phases"][number] | undefined;
	let chosenMs = Number.NEGATIVE_INFINITY;
	for (const phase of phases) {
		const phaseMs = timestampMs(phase.time);
		if (phaseMs === undefined || phaseMs > ref || phaseMs < chosenMs) continue;
		chosen = phase;
		chosenMs = phaseMs;
	}
	if (!chosen) return undefined;
	const key = chosen.source === "event" ? `p${modelPhaseKey(chosen)}` : `label:${chosen.label}`;
	return { key, label: chosen.label };
}

function modelPhaseKey(phase: RunReportModel["phases"][number]): string {
	return `${phase.time}:${phase.label}`;
}

function buildRunMermaidGroups(model: RunReportModel): RunMermaidGroup[] {
	const groups = new Map<string, RunMermaidGroup>();
	for (const agent of model.agents) {
		const phase = inferPhaseForAgent(agent, model.phases) ?? { key: "none", label: "Agents" };
		const group = groups.get(phase.key);
		if (group) group.agents.push(agent);
		else groups.set(phase.key, { label: phase.label, agents: [agent] });
	}
	return [...groups.values()];
}

/**
 * Un nombre de fase no expresa dependencias: `parallel()` y una síntesis posterior
 * pueden compartirlo. Cuando los intervalos completos lo prueban, separamos las
 * oleadas; sin timestamps completos conservamos el agrupamiento actual y no
 * inventamos serialidad.
 */
function buildRunMermaidWaves(agents: RunReportAgent[]): RunMermaidWave[] {
	if (agents.length <= 1) return [{ agents }];
	const timed = agents.map((agent) => ({
		agent,
		started: timestampMs(agent.startedAt),
		ended: timestampMs(agent.endedAt),
	}));
	if (timed.some(({ started, ended }) => started === undefined || ended === undefined || ended < started))
		return [{ agents }];

	timed.sort((a, b) => a.started! - b.started! || a.ended! - b.ended! || a.agent.id - b.agent.id);
	const waves: RunMermaidWave[] = [];
	let wave: RunReportAgent[] = [];
	let waveEndsAt = Number.NEGATIVE_INFINITY;
	for (const { agent, started, ended } of timed) {
		// Un relevo exacto sigue siendo secuencial: el runtime cuenta ends antes que starts
		// cuando estima el pico de paralelismo.
		if (wave.length > 0 && started! >= waveEndsAt) {
			waves.push({ agents: wave });
			wave = [];
			waveEndsAt = Number.NEGATIVE_INFINITY;
		}
		wave.push(agent);
		waveEndsAt = Math.max(waveEndsAt, ended!);
	}
	waves.push({ agents: wave });
	return waves;
}

function agentStateCounts(agents: RunReportAgent[]): Record<"completed" | "failed" | "running" | "other", number> {
	return agents.reduce(
		(counts, agent) => {
			counts[mermaidStateClass(agent)] += 1;
			return counts;
		},
		{ completed: 0, failed: 0, running: 0, other: 0 },
	);
}

function summaryStateClass(
	counts: Record<"completed" | "failed" | "running" | "other", number>,
): "completed" | "failed" | "running" | "other" {
	if (counts.failed > 0) return "failed";
	if (counts.running > 0) return "running";
	if (counts.completed > 0 && counts.other === 0) return "completed";
	return "other";
}

function mermaidGroupSummaryLabel(agents: RunReportAgent[]): string {
	const counts = agentStateCounts(agents);
	return [
		`${agents.length} agents`,
		counts.completed ? `${counts.completed} completed` : "",
		counts.failed ? `${counts.failed} failed` : "",
		counts.running ? `${counts.running} running` : "",
		counts.other ? `${counts.other} other` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export function buildRunMermaidSource(model: RunReportModel): string {
	if (model.agents.length === 0) {
		return 'flowchart TD\n  none["No agents in this run"]';
	}

	const groups = buildRunMermaidGroups(model);
	const lines = ["flowchart TD", '  start(["start"])'];
	const phaseEntries: string[] = [];
	const phaseExits: string[] = [];
	const usedClasses = new Set<string>();
	const classLines: string[] = [];
	let index = 0;
	for (const group of groups) {
		index += 1;
		const phaseId = `phase${index}`;
		const waves = buildRunMermaidWaves(group.agents);
		let previousExit: string | undefined;
		lines.push(`  subgraph ${phaseId}["${mermaidLabel(group.label)}"]`);
		lines.push("    direction TD");
		for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
			const wave = waves[waveIndex];
			const suffix = waves.length > 1 ? `_wave${waveIndex + 1}` : "";
			const entryId = `${phaseId}${suffix}_in`;
			const exitId = `${phaseId}${suffix}_out`;
			const parallel = wave.agents.length > 1;
			if (previousExit) lines.push(`    ${previousExit} --> ${entryId}`);
			lines.push(`    ${entryId}(("${parallel ? "fork" : "start"}"))`);
			lines.push(`    ${exitId}(("${parallel ? "join" : "done"}"))`);
			if (wave.agents.length > MAX_DETAILED_MERMAID_AGENTS_PER_GROUP) {
				const counts = agentStateCounts(wave.agents);
				const cls = summaryStateClass(counts);
				const summaryId = `${phaseId}${suffix}_summary`;
				lines.push(`    ${summaryId}(["${mermaidLabel(mermaidGroupSummaryLabel(wave.agents))}"])`);
				lines.push(`    ${entryId} --> ${summaryId}`);
				lines.push(`    ${summaryId} --> ${exitId}`);
				usedClasses.add(cls);
				classLines.push(`  class ${summaryId} ${cls}`);
			} else {
				for (const agent of wave.agents) {
					const cls = mermaidStateClass(agent);
					// Forma "stadium" (bordes totalmente redondeados): combina con el estilo pill de
					// los <span class="rpill"> de estado que usa el resto del reporte.
					lines.push(`    A${agent.id}(["${mermaidLabel(agent.name)}"])`);
					lines.push(`    ${entryId} --> A${agent.id}`);
					lines.push(`    A${agent.id} --> ${exitId}`);
					usedClasses.add(cls);
					classLines.push(`  class A${agent.id} ${cls}`);
				}
			}
			if (waveIndex === 0) phaseEntries.push(entryId);
			previousExit = exitId;
		}
		if (previousExit) phaseExits.push(previousExit);
		lines.push("  end");
	}
	if (phaseEntries.length > 0) {
		lines.push(`  start --> ${phaseEntries[0]}`);
		for (let i = 0; i < phaseEntries.length - 1; i += 1) {
			lines.push(`  ${phaseExits[i]} --> ${phaseEntries[i + 1]}`);
		}
		lines.push(`  ${phaseExits[phaseExits.length - 1]} --> done(["done"])`);
	}

	for (const cls of usedClasses) {
		lines.push(`  classDef ${cls} ${MERMAID_STATE_STYLES[cls]}`);
	}
	lines.push(...classLines);

	return lines.join("\n");
}

function pillClass(state: string, ok?: boolean): string {
	if (state === "completed" && ok !== false) return "ok";
	if (state === "running") return "run";
	if (state === "cached") return "ok";
	if (state === "interrupted") return "fail";
	if (state === "stale" || state === "cancelled" || state === "unknown") return "warn";
	return "fail";
}

function chip(label: string, value: string | number | undefined): string {
	if (value === undefined || value === "") return "";
	return `<span class="chip">${escapeHtml(label)}: ${escapeHtml(String(value))}</span>`;
}

function truncNote(t: RunReportText): string {
	return t.truncated ? ` <span class="muted">…[truncated]</span>` : "";
}

type RenderMode = "pre" | "markdown" | "structured";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function parsedJsonOutput(text: string): { value: JsonValue; pretty: string } | undefined {
	const trimmed = text.trim();
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return undefined;
	try {
		const value = JSON.parse(trimmed) as JsonValue;
		return { value, pretty: JSON.stringify(value, null, 2) };
	} catch {
		return undefined;
	}
}

function prettyJsonOutput(text: string): string | undefined {
	return parsedJsonOutput(text)?.pretty;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: JsonValue): value is null | boolean | number | string {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function humanizeKey(key: string): string {
	const words = key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return words.replace(/^./, (ch) => ch.toUpperCase());
}

function markdownScalar(value: JsonValue): string {
	if (value === null) return "`null`";
	if (typeof value === "string") return value.trim() || "_(empty)_";
	if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
	return `\`${JSON.stringify(value)}\``;
}

function markdownTableCell(value: JsonValue): string {
	return markdownScalar(value)
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " / ");
}

function flatRecordKeys(rows: { [key: string]: JsonValue }[]): string[] {
	const keys: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!keys.includes(key) && isJsonScalar(row[key])) keys.push(key);
		}
	}
	return keys;
}

function recordsToMarkdownTable(rows: { [key: string]: JsonValue }[]): string {
	const keys = flatRecordKeys(rows);
	if (keys.length === 0) return rows.map((row) => `- ${markdownScalar(row)}`).join("\n");
	const head = `| ${keys.map((key) => humanizeKey(key)).join(" | ")} |`;
	const sep = `| ${keys.map(() => "---").join(" | ")} |`;
	const body = rows.map((row) => `| ${keys.map((key) => markdownTableCell(row[key] ?? "")).join(" | ")} |`).join("\n");
	return `${head}\n${sep}\n${body}`;
}

function objectToKeyValueTable(record: { [key: string]: JsonValue }): string {
	const rows = Object.entries(record).filter(([, value]) => isJsonScalar(value));
	if (rows.length === 0) return "";
	return [
		"| Field | Value |",
		"| --- | --- |",
		...rows.map(([key, value]) => `| ${humanizeKey(key)} | ${markdownTableCell(value)} |`),
	].join("\n");
}

function structuredValueMarkdown(value: JsonValue, level = 3): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return "_none_";
		if (value.every((item) => typeof item === "string")) return value.map((item) => `- ${item}`).join("\n");
		if (value.every(isJsonRecord)) return recordsToMarkdownTable(value as { [key: string]: JsonValue }[]);
		return value.map((item) => `- ${markdownScalar(item)}`).join("\n");
	}
	if (isJsonRecord(value)) {
		const scalarTable = objectToKeyValueTable(value);
		const nested = Object.entries(value)
			.filter(([, nestedValue]) => !isJsonScalar(nestedValue))
			.map(
				([key, nestedValue]) =>
					`${"#".repeat(Math.min(level, 6))} ${humanizeKey(key)}\n\n${structuredValueMarkdown(nestedValue, level + 1)}`,
			)
			.join("\n\n");
		return [scalarTable, nested].filter(Boolean).join("\n\n") || "_empty object_";
	}
	return markdownScalar(value);
}

function structuredJsonMarkdown(value: JsonValue): string {
	if (!isJsonRecord(value)) return structuredValueMarkdown(value);
	return Object.entries(value)
		.map(([key, child]) => `### ${humanizeKey(key)}\n\n${structuredValueMarkdown(child, 4)}`)
		.join("\n\n");
}

function renderStructuredJson(text: string): string | undefined {
	const parsed = parsedJsonOutput(text);
	if (!parsed) return undefined;
	return (
		`<div class="structured-output"><div class="md-body">${renderRunReportMarkdown(structuredJsonMarkdown(parsed.value))}</div></div>` +
		`<details class="raw-json"><summary>Raw JSON</summary><div class="body"><pre class="json-output">${escapeHtml(parsed.pretty)}</pre></div></details>`
	);
}

function renderTextBody(text: string, render: RenderMode): string {
	if (render === "structured") {
		const structured = renderStructuredJson(text);
		if (structured !== undefined) return structured;
		return `<div class="md-body">${renderRunReportMarkdown(text)}</div>`;
	}
	const json = prettyJsonOutput(text);
	if (json !== undefined) return `<pre class="json-output">${escapeHtml(json)}</pre>`;
	return render === "markdown"
		? `<div class="md-body">${renderRunReportMarkdown(text)}</div>`
		: `<pre>${escapeHtml(text)}</pre>`;
}

function textBlock(title: string, t: RunReportText | undefined, open = false, render: RenderMode = "pre"): string {
	if (!t) return "";
	const body = renderTextBody(t.text, render);
	return (
		`<details${open ? " open" : ""}><summary>${escapeHtml(title)}${truncNote(t)}</summary>` +
		`<div class="body">${body}</div></details>`
	);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

type ProgressTone = "ok" | "fail" | "run" | "warn";

function meter(fraction: number, tone: ProgressTone = "ok"): string {
	const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
	return `<span class="meter ${tone}" title="${Math.round(pct * 100)}%"><span style="width:${Math.round(pct * 100)}%"></span></span>`;
}

function metricCard(label: string, value: string | number, detail = ""): string {
	return (
		`<div class="metric-card"><div class="metric-label">${escapeHtml(label)}</div>` +
		`<div class="metric-value">${escapeHtml(String(value))}</div>` +
		(detail ? `<div class="metric-detail">${detail}</div>` : "") +
		`</div>`
	);
}

function agentFailed(agent: RunReportAgent): boolean {
	return agent.ok === false || agent.state === "failed" || agent.state === "interrupted";
}

function agentSucceeded(agent: RunReportAgent): boolean {
	return (agent.state === "completed" || agent.state === "cached") && agent.ok !== false;
}

function agentDone(agent: RunReportAgent): boolean {
	return agent.state !== "running";
}

interface ProgressSummary {
	observed: number;
	total: number;
	done: number;
	running: number;
	failed: number;
	unknown: number;
	fraction: number;
	tone: ProgressTone;
	openEnded: boolean;
}

function plannedAgentTotal(agents: RunReportAgent[]): number {
	const phaseTotals = new Map<string, number>();
	let standalone = 0;
	for (const agent of agents) {
		if (agent.phaseTotal !== undefined && agent.phaseTotal > 0) {
			const key = agent.phaseId !== undefined ? `phase:${agent.phaseId}` : `agent:${agent.name}`;
			phaseTotals.set(key, Math.max(phaseTotals.get(key) ?? 0, agent.phaseTotal));
		} else {
			standalone += 1;
		}
	}
	let planned = standalone;
	for (const total of phaseTotals.values()) planned += total;
	return Math.max(agents.length, planned);
}

function summarizeProgress(model: RunReportModel): ProgressSummary {
	const observed = model.agents.length;
	const done = model.agents.filter(agentDone).length;
	const running = model.agents.filter((agent) => agent.state === "running").length;
	const failed = model.agents.filter(agentFailed).length;
	const unknown = model.agents.filter(
		(agent) => agentDone(agent) && !agentFailed(agent) && !agentSucceeded(agent),
	).length;
	const total = plannedAgentTotal(model.agents);
	const openEnded = model.state === "running" && running === 0 && done >= total && total > 0;
	const fraction = total > 0 ? (openEnded ? Math.min(done / total, 0.95) : done / total) : 0;
	const tone: ProgressTone =
		failed > 0 || model.state === "failed"
			? "fail"
			: model.state === "running" || running > 0 || openEnded
				? "run"
				: unknown > 0 || model.state === "cancelled" || model.state === "stale" || model.state === "unknown"
					? "warn"
					: "ok";
	return { observed, total, done, running, failed, unknown, fraction, tone, openEnded };
}

function progressValue(summary: ProgressSummary): string {
	return `${summary.done}/${summary.total}${summary.openEnded ? "+" : ""}`;
}

function formatReportAgentPhase(agent: RunReportAgent): string | undefined {
	if (!agent.phaseIndex || !agent.phaseTotal) return undefined;
	const batch = agent.phaseId ? `P${agent.phaseId} ` : "";
	return `${batch}${agent.phaseIndex}/${agent.phaseTotal}`;
}

function reportAgentPhaseDetail(agent: RunReportAgent): string {
	const phase = formatReportAgentPhase(agent);
	if (phase && agent.phaseLabel) return `${phase} • ${agent.phaseLabel}`;
	return phase ?? agent.phaseLabel ?? "";
}

function agentStateText(agent: RunReportAgent): string {
	if (agentFailed(agent)) return agent.state === "interrupted" ? "✗ interrupted" : "✗ failed";
	if (agent.state === "completed") return "✓ done";
	if (agent.state === "running") return "▶ running";
	if (agent.state === "cached") return "♻ cached";
	return "? unknown";
}

function shortModel(model: string): string {
	return model.split("/").filter(Boolean).pop() ?? model;
}

function commaListCount(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const count = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean).length;
	return count || undefined;
}

function compactInlineText(value: string, max = 220): string {
	const oneLine = value
		.replace(/\bhttps?:\/\/[^\s<>"]+/gi, "[external-url]")
		.replace(/\bjavascript:[^\s<>"]+/gi, "[unsafe-url]")
		.replace(/\s+/g, " ")
		.trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function skillsText(agent: RunReportAgent): string {
	if (agent.skills) return `${agent.skills}${agent.includeSkills ? " + discovery" : " (explicit only)"}`;
	return agent.includeSkills === false ? "disabled" : "default discovery";
}

function extensionsText(agent: RunReportAgent): string {
	if (agent.extensions) return `${agent.extensions}${agent.includeExtensions ? " + discovery" : " (explicit only)"}`;
	return agent.includeExtensions ? "default discovery" : "disabled";
}

function keysText(agent: RunReportAgent): string {
	return agent.keys ? agent.keys : agent.isolatedEnv ? "none selected" : "default inherited environment";
}

function agentAccessMeta(agent: RunReportAgent): string {
	return [
		agent.promptAvailable ? "prompt✓" : agent.promptAvailable === false ? "prompt?" : "",
		agent.schemaOk !== undefined ? `schema ${agent.schemaOk ? "ok" : "bad"}` : "",
		agent.model ? `model ${agent.model}` : "",
		agent.thinking ? `effort ${agent.thinking}` : "",
		agent.outputEmpty ? "output empty" : "",
		agent.outputTruncated ? "output truncated" : "",
		agent.outputChars !== undefined ? `output chars: ${agent.outputChars}` : "",
		agent.tools ? `tools: ${agent.tools}` : "tools: default",
		agent.excludeTools ? `exclude: ${agent.excludeTools}` : "",
		`skills: ${skillsText(agent)}`,
		`extensions: ${extensionsText(agent)}`,
		`keys: ${keysText(agent)}`,
		agent.missingKeys ? `missing: ${agent.missingKeys}` : "",
		agent.isolatedEnv ? "isolated env" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function agentRowMeta(agent: RunReportAgent): string[] {
	const toolCount = commaListCount(agent.tools);
	const skillCount = commaListCount(agent.skills);
	const extensionCount = commaListCount(agent.extensions);
	const keyCount = commaListCount(agent.keys);
	const missingCount = commaListCount(agent.missingKeys);
	const chips = [
		agent.promptAvailable ? "prompt✓" : "prompt?",
		agent.schemaOk !== undefined ? `schema:${agent.schemaOk ? "ok" : "bad"}` : "",
		agent.outputEmpty ? "empty-output" : "",
		agent.outputTruncated ? "output:truncated" : "",
		agent.stdoutTruncated ? "stdout:truncated" : "",
		agent.model ? `model:${shortModel(agent.model)}` : "",
		agent.thinking ? `effort:${agent.thinking}` : "",
		`tools:${toolCount ?? "default"}`,
		`skills:${skillCount ?? (agent.includeSkills === false ? "off" : "default")}`,
		`ext:${extensionCount ?? (agent.includeExtensions ? "default" : "off")}`,
		`keys:${keyCount ?? (agent.isolatedEnv ? "none" : "default")}`,
		missingCount ? `missing:${missingCount}` : "",
	];
	return chips.filter(Boolean);
}

function miniChipClass(label: string): string {
	if (label === "prompt✓" || label === "schema:ok") return "ok";
	if (label === "prompt?" || label.startsWith("missing:") || label.includes("truncated")) return "warn";
	if (label === "schema:bad" || label === "empty-output") return "fail";
	return "";
}

function renderMiniChips(chips: string[]): string {
	return `<div class="agent-chipline">${chips
		.map(
			(label) =>
				`<span class="mini-chip${miniChipClass(label) ? ` ${miniChipClass(label)}` : ""}">${escapeHtml(label)}</span>`,
		)
		.join("")}</div>`;
}

function renderMonitorAgentLine(agent: RunReportAgent): string {
	const phase = formatReportAgentPhase(agent);
	const elapsed = agent.elapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agent.elapsedMs)}`;
	return (
		`<div class="monitor-agent-row">` +
		`<span class="monitor-agent-state ${pillClass(agent.state, agent.ok)}">${escapeHtml(agentStateText(agent))}</span>` +
		`<span class="mono">#${escapeHtml(String(agent.id))}</span>` +
		(phase ? `<span class="mono">${escapeHtml(phase)}</span>` : "") +
		`<b>${escapeHtml(agent.name)}</b>` +
		`<span class="kv muted">${escapeHtml(elapsed)}</span>` +
		(agent.code === undefined ? "" : `<span class="kv muted">code:${escapeHtml(String(agent.code))}</span>`) +
		renderMiniChips(agentRowMeta(agent)) +
		`</div>`
	);
}

function detailLine(label: string, valueHtml: string): string {
	return `<div class="monitor-detail-line"><span class="kv muted">${escapeHtml(label)}:</span> ${valueHtml}</div>`;
}

function renderMonitorSelectedAgent(agent: RunReportAgent, failed: boolean): string {
	const artifact = link(agent.artifactHref, "artifact.md");
	const promptStatus = agent.promptAvailable ? "available" : "not available";
	const phaseToken = formatReportAgentPhase(agent);
	const phaseDetail = reportAgentPhaseDetail(agent);
	const phase = phaseDetail ? detailLine("phase", escapeHtml(phaseDetail)) : "";
	const config = [
		detailLine(
			"model",
			`${escapeHtml(agent.model ?? "default")} <span class="muted">•</span> effort: ${escapeHtml(agent.thinking ?? "default")}`,
		),
		detailLine(
			"tools",
			`${escapeHtml(agent.tools ?? "default")}${agent.excludeTools ? ` <span class="muted">•</span> exclude: ${escapeHtml(agent.excludeTools)}` : ""}`,
		),
		detailLine("skills", escapeHtml(skillsText(agent))),
		detailLine("extensions", escapeHtml(extensionsText(agent))),
		detailLine(
			"keys",
			`${escapeHtml(keysText(agent))}${agent.missingKeys ? ` <span class="muted">•</span> missing: ${escapeHtml(agent.missingKeys)}` : ""}`,
		),
		agent.isolatedEnv ? detailLine("env", "isolated") : "",
	]
		.filter(Boolean)
		.join("");
	const outputState = [
		agent.outputEmpty ? "empty" : "",
		agent.outputTruncated ? "truncated" : "",
		agent.outputChars !== undefined ? `${agent.outputChars} chars` : "",
	]
		.filter(Boolean)
		.join(" • ");
	const io = [
		agent.promptPreview ? detailLine("prompt preview", escapeHtml(compactInlineText(agent.promptPreview, 220))) : "",
		outputState ? detailLine("output state", escapeHtml(outputState)) : "",
		agent.output !== undefined ? detailLine("output", escapeHtml(compactInlineText(agent.output.text, 220))) : "",
		agent.outputEmpty ? detailLine("integrity", "empty-output") : "",
		agent.outputTruncated
			? detailLine(
					"integrity",
					`output:truncated${agent.outputChars === undefined ? "" : ` (${escapeHtml(String(agent.outputChars))} chars)`}`,
				)
			: "",
		agent.stdoutTruncated
			? detailLine(
					"integrity",
					`stdout:truncated${agent.stdoutChars === undefined ? "" : ` (${escapeHtml(String(agent.stdoutChars))} chars)`}`,
				)
			: "",
	]
		.filter(Boolean)
		.join("");
	return (
		`<div class="callout ${failed ? "error" : "info"} monitor-selected"><b>Selected agent</b>` +
		detailLine(
			"agent",
			`#${escapeHtml(String(agent.id))} ${phaseToken ? `${escapeHtml(phaseToken)} ` : ""}${escapeHtml(agent.name)}`,
		) +
		detailLine(
			"state",
			`${escapeHtml(agent.state)}${agent.elapsedMs !== undefined ? ` <span class="muted">•</span> ${escapeHtml(formatElapsedMs(agent.elapsedMs))}` : ""}${agent.code !== undefined ? ` <span class="muted">•</span> code ${escapeHtml(String(agent.code))}` : ""}`,
		) +
		phase +
		detailLine(
			"prompt",
			`${escapeHtml(promptStatus)}${artifact ? ` <span class="muted">•</span> ${artifact}` : ""}`,
		) +
		`<div class="monitor-subtitle">config</div>${config}` +
		(io ? `<div class="monitor-subtitle">i/o</div>${io}` : "") +
		`</div>`
	);
}

function renderWorkflowMonitor(model: RunReportModel, summary: ProgressSummary): string {
	const running = summary.running;
	const frac = summary.fraction;
	const last = model.logs.slice(-1)[0];
	const featured =
		model.agents.find(agentFailed) ?? model.agents.find((agent) => agent.state === "running") ?? model.agents[0];
	const row = (agent: RunReportAgent): string => {
		const isFeatured = featured && agent.id === featured.id;
		return `<tr${isFeatured ? ' class="featured"' : ""}><td>${renderMonitorAgentLine(agent)}</td></tr>`;
	};
	const agentRows = model.agents.map(row).join("");
	const parallel = model.agentConcurrency !== undefined ? `${running}/${model.agentConcurrency}` : String(running);
	const agentHeader =
		`<div class="monitor-agent-head"><b>Agents (${model.agents.length})</b>` +
		`<span>• parallel ${escapeHtml(parallel)}${model.peakParallelAgents === undefined ? "" : ` • peak ${escapeHtml(String(model.peakParallelAgents))}`}</span></div>`;
	const featuredHint = featured
		? renderMonitorSelectedAgent(featured, summary.failed > 0)
		: `<div class="callout info monitor-selected"><b>Selected agent</b><div class="monitor-detail-line muted">No agents recorded yet.</div></div>`;
	return (
		`<section class="monitor-panel"><div class="monitor-head"><h2>Workflow monitor</h2>` +
		`<span class="rpill ${pillClass(model.state)}">${escapeHtml(model.state)}</span></div>` +
		`<div class="monitor-grid">` +
		metricCard(
			"Progress",
			progressValue(summary),
			`${meter(frac, summary.tone)} <span>${Math.round(frac * 100)}%</span>`,
		) +
		metricCard(
			"parallel",
			model.agentConcurrency !== undefined ? `${running}/${model.agentConcurrency}` : running,
			model.peakParallelAgents !== undefined
				? `peak ${escapeHtml(String(model.peakParallelAgents))}`
				: "running now",
		) +
		metricCard("failed", summary.failed, summary.failed ? "review failed cards" : "no failed agents") +
		metricCard(
			"artifacts",
			model.artifacts.length,
			model.artifacts[0] ? escapeHtml(model.artifacts[0].path) : "none listed",
		) +
		metricCard("logs", model.logs.length, "timeline entries") +
		metricCard(
			"Latest activity",
			last ? `${String(last.time).slice(11, 19)} ${last.message}` : "—",
			"last log event",
		) +
		`</div>` +
		featuredHint +
		`<h2>Agent monitor</h2>` +
		agentHeader +
		(agentRows
			? `<table class="monitor-table"><thead><tr><th>Monitor row</th></tr></thead><tbody>${agentRows}</tbody></table>`
			: `<div class="muted">No agents recorded for this run.</div>`) +
		`</section>`
	);
}

function openingText(model: RunReportModel, summary: ProgressSummary): string {
	const totalAgents = summary.observed;
	const agentLabel = plural(totalAgents, "agente");
	const recordedLabel = plural(totalAgents, "registrado");
	if (summary.failed > 0) {
		return `${summary.failed} de ${totalAgents} ${plural(totalAgents, "agente")} falló${summary.failed === 1 ? "" : "n"}. Las tarjetas fallidas están abiertas abajo; empezá por ellas y luego revisá el output final si existe.`;
	}
	if (model.state === "running") {
		return `Instantánea del run: ${totalAgents} ${agentLabel} ${recordedLabel} hasta ahora. El run sigue en progreso, así que outputs y métricas pueden cambiar.`;
	}
	if (model.state === "cancelled") {
		return `El run fue cancelado con ${totalAgents} ${agentLabel} registrados. Usá la timeline y las tarjetas de agentes para encontrar el último paso confiable.`;
	}
	if (model.state === "stale") {
		return `El run parece stale: hay ${totalAgents} ${agentLabel} ${recordedLabel}, pero esta sesión no confirma un owner activo. Tratá este reporte como diagnóstico, no como veredicto final.`;
	}
	if (model.state === "completed") {
		return `${totalAgents} ${agentLabel} completaron el run sin fallas registradas. Empezá por el output final si existe; los detalles crudos quedan debajo para depurar.`;
	}
	return `Estado del run: ${model.state}. Hay ${totalAgents} ${agentLabel} registrados; revisá primero los callouts y después las tarjetas de agentes.`;
}

function link(href: string | undefined, label: string): string {
	const safe = artifactViewerHref(href) ?? safeRelativeHref(href);
	if (!safe) return "";
	return `<a href="${safe}">${escapeHtml(label)}</a>`;
}

function renderTimelineDetails(details: string | undefined): string {
	if (!details) return "";
	const pretty = prettyJsonOutput(details);
	const body = pretty
		? `<pre class="json-output">${escapeHtml(pretty)}</pre>`
		: `<div class="kv muted">${escapeHtml(details)}</div>`;
	return `<div class="timeline-details">${body}</div>`;
}

function renderTimeline(logs: RunReportModel["logs"]): string {
	const items = logs
		.map(
			(log) =>
				`<li class="timeline-item"><span class="timeline-time">${escapeHtml(log.time)}</span>` +
				`<div class="timeline-message">${escapeHtml(log.message)}</div>${renderTimelineDetails(log.details)}</li>`,
		)
		.join("");
	return `<ol class="timeline-list">${items}</ol>`;
}

function renderAgent(agent: RunReportAgent): string {
	const failed = agentFailed(agent);
	const pill = `<span class="rpill ${pillClass(agent.state, agent.ok)}">${escapeHtml(agent.state)}</span>`;
	const meta: string[] = [];
	if (agent.model) meta.push(`model ${agent.model}`);
	if (agent.thinking) meta.push(`effort ${agent.thinking}`);
	if (agent.elapsedMs !== undefined) meta.push(`elapsed ${Math.round(agent.elapsedMs / 100) / 10}s`);
	if (agent.code !== undefined) meta.push(`code ${agent.code}`);
	if (agent.killed) meta.push("killed");
	if (agent.schemaOk !== undefined) meta.push(`schema ${agent.schemaOk ? "ok" : "FAILED"}`);
	if (agent.outputEmpty) meta.push("output:empty");
	if (agent.outputTruncated) meta.push("output:truncated");
	if (agent.outputChars !== undefined) meta.push(`output chars ${agent.outputChars}`);
	if (agent.phaseLabel) meta.push(`phase ${agent.phaseLabel}`);
	const m = agent.metrics;
	if (m?.costTotal !== undefined) meta.push(`cost ${m.costTotal}`);
	if (m?.totalTokens !== undefined) meta.push(`tokens ${m.totalTokens}`);
	if (m?.toolCalls !== undefined) meta.push(`tools ${m.toolCalls}${m.toolErrors ? ` (${m.toolErrors} err)` : ""}`);
	if (agent.outputEmpty) meta.push("empty-output");
	if (agent.outputTruncated) meta.push("output:truncated");
	if (agent.stdoutTruncated) meta.push("stdout:truncated");

	const links: string[] = [];
	const artifact = link(agent.artifactHref, "artifact.md");
	if (artifact) links.push(artifact);
	const stdout = link(agent.stdoutHref, "stdout.log");
	if (stdout) links.push(stdout);
	const stderrLink = agent.stderrTail?.href ? link(agent.stderrTail.href, "stderr.log") : "";
	if (stderrLink) links.push(stderrLink);

	let body = "";
	if (agent.inlineOmitted) {
		body += `<div class="callout warn"><b>Inline content omitted:</b> the report's global inline budget was reached; use the links above for full content.</div>`;
	} else {
		if (agent.prompt) {
			body += `<div class="kv muted">Prompt (extracted from artifact; section boundaries are forgeable):</div>`;
			body += textBlock("Prompt", agent.prompt, false, "markdown");
		}
		if (agent.output !== undefined) body += textBlock("Output", agent.output, false, "structured");
		if (agent.data) body += textBlock("Structured data", agent.data, false, "structured");
	}
	if (agent.outputEmpty || agent.outputTruncated || agent.stdoutTruncated) {
		const facts = [
			agent.outputEmpty ? "empty-output" : "",
			agent.outputTruncated
				? `output:truncated${agent.outputChars === undefined ? "" : ` (${agent.outputChars} chars)`}`
				: "",
			agent.stdoutTruncated
				? `stdout:truncated${agent.stdoutChars === undefined ? "" : ` (${agent.stdoutChars} chars)`}`
				: "",
		].filter(Boolean);
		body += `<div class="callout warn"><b>Result integrity:</b> ${escapeHtml(facts.join(" · "))}. Full stdout remains linked when available.</div>`;
	}
	if (agent.stderrTail) {
		body += `<div class="kv muted">stderr (bounded tail):</div><pre>${escapeHtml(agent.stderrTail.text)}</pre>`;
	}
	if (!body) body = `<div class="muted">No inline content recorded for this agent.</div>`;
	body += `<div class="kv muted">${escapeHtml(agentAccessMeta(agent))}</div>`;

	return (
		`<details class="${failed ? "fail-card" : ""}"${failed ? " open" : ""}>` +
		`<summary>${pill} <b>#${agent.id} ${escapeHtml(agent.name)}</b>` +
		` <span class="kv muted">${escapeHtml(meta.join(" · "))}</span>` +
		(links.length ? ` <span class="kv">${links.join(" · ")}</span>` : "") +
		`</summary><div class="body">${body}</div></details>`
	);
}

export function buildRunReportHtml(model: RunReportModel): string {
	const summary = summarizeProgress(model);
	const statePill = `<span class="rpill ${pillClass(model.state)}">${escapeHtml(model.state)}</span>`;
	const failedAgents = summary.failed;
	const autoRefreshSeconds =
		model.state === "running" && model.autoRefreshSeconds !== undefined
			? Math.max(1, Math.round(model.autoRefreshSeconds))
			: undefined;

	const callouts: string[] = [];
	if (model.error !== undefined) {
		callouts.push(`<div class="callout error"><b>Run error:</b> ${escapeHtml(model.error)}</div>`);
	}
	if (model.state === "running") {
		callouts.push(
			`<div class="callout info"><b>Point-in-time snapshot</b> as of ${escapeHtml(model.generatedAt)}` +
				(model.liveness === "unverified"
					? ` — running as of ${escapeHtml(model.updatedAt ?? model.generatedAt)}; liveness unverified (out-of-session run dir).`
					: ". Outputs and metrics appear when the run completes.") +
				`</div>`,
		);
	}
	if (model.state === "stale") {
		callouts.push(
			`<div class="callout warn"><b>Stale:</b> status.json says running but no active run owns this id in the generating session.</div>`,
		);
	}
	if (model.codeDrift === "changed") {
		callouts.push(
			`<div class="callout warn"><b>Code drift:</b> the workflow script changed since this run (hash mismatch); the structure shown may not match what executed.</div>`,
		);
	} else if (model.codeDrift === "missing") {
		callouts.push(
			`<div class="callout warn"><b>Structure unavailable:</b> the workflow script was not found; rendering execution data only.</div>`,
		);
	}
	if (model.missingFiles.length) {
		callouts.push(
			`<div class="callout info"><b>Missing run files:</b> ${escapeHtml(model.missingFiles.join(", "))}.</div>`,
		);
	}
	for (const note of model.clampNotes) {
		callouts.push(`<div class="callout warn"><b>Clamp:</b> ${escapeHtml(note)}</div>`);
	}
	if (autoRefreshSeconds !== undefined) {
		callouts.push(
			`<div class="callout info"><b>Auto-refresh:</b> this watched report reloads every ${autoRefreshSeconds}s while the run is running. The final regenerated report removes this refresh tag.</div>`,
		);
	}

	const chips = [
		chip("run", model.runId),
		chip("scope", model.scope),
		chip("agents", model.agents.length),
		model.basedOn?.length ? chip("based on", model.basedOn.length) : "",
		failedAgents ? chip("failed", failedAgents) : "",
		model.integrity?.emptyOutputAgents ? chip("empty-output", model.integrity.emptyOutputAgents) : "",
		model.integrity?.outputTruncatedAgents ? chip("output:truncated", model.integrity.outputTruncatedAgents) : "",
		model.integrity?.stdoutTruncatedAgents ? chip("stdout:truncated", model.integrity.stdoutTruncatedAgents) : "",
		chip("concurrency", model.agentConcurrency),
		chip("maxAgents", model.maxAgents),
		chip("peak parallel", model.peakParallelAgents),
		chip("elapsed", model.elapsedMs !== undefined ? `${Math.round(model.elapsedMs / 1000)}s` : undefined),
		chip("generated", model.generatedAt),
	].join("");
	const opening = `<p class="opening">${escapeHtml(openingText(model, summary))}</p>`;

	const phaseRows = model.phases
		.map(
			(p) =>
				`<tr><td class="mono">${escapeHtml(p.time)}</td><td>${escapeHtml(p.label)}</td><td>${escapeHtml(p.source ?? "log")}</td></tr>`,
		)
		.join("");
	const hasStructuredPhases = model.phases.some((p) => p.source === "event");
	const phaseSection = model.phases.length
		? `<h2>Phases</h2><div class="kv muted">${
				hasStructuredPhases
					? "Structured phase events from the run dir; legacy log-derived phases are marked as log."
					: 'Derived from the "phase: …" log convention.'
			}</div>` +
			`<table><thead><tr><th>Time</th><th>Phase</th><th>Source</th></tr></thead><tbody>${phaseRows}</tbody></table>`
		: "";

	const logSection = model.logs.length
		? `<details><summary>Timeline (${model.logs.length} log entries)</summary><div class="body">${renderTimeline(model.logs)}</div></details>`
		: "";

	const integrity = model.integrity;
	const integritySection = integrity
		? `<h2>Result integrity</h2><div class="chips">` +
			[
				chip("agent results", integrity.agentResults),
				chip("failed", integrity.failedAgents),
				chip("empty-output", integrity.emptyOutputAgents),
				chip("output:truncated", integrity.outputTruncatedAgents),
				chip("stdout:truncated", integrity.stdoutTruncatedAgents),
				chip("timed out", integrity.timedOutAgents),
				chip("schema failed", integrity.schemaFailedAgents),
			].join("") +
			`</div>`
		: "";

	const mermaidSection = model.agents.length
		? `<h2 id="run-diagram">Run diagram</h2><div class="mermaid">${escapeHtml(buildRunMermaidSource(model))}</div>` +
			`<script src="${MERMAID_CDN_URL}" integrity="${MERMAID_CDN_INTEGRITY}" crossorigin="anonymous"></script>` +
			// theme:"base" + themeVariables sigue prefers-color-scheme (matchMedia fijo, sin
			// datos del modelo). Los hex de abajo son un subset intencionalmente duplicado de
			// PANDI_TOKENS_CSS (--paper/--link/--info-bg en light, --raised en dark para que el
			// cluster se despegue del fondo general en vez de casi fundirse con él): el diagrama sandbox
			// renderiza en un iframe aislado que NO hereda los custom properties del documento
			// padre, así que no hay forma de leerlos vs var(...) — hay que repetirlos literales.
			// Fondo de cluster + líneas con un toque del accent "link" (alpha bajo) en vez de
			// gris puro: un poco de color, sutil, sin competir con los estados pastel del nodo.
			// background matchea --paper (pandi) en vez de transparent: probamos transparente y
			// se volvió atrás a propósito (se veía peor que un fondo sólido consistente).
			// fontFamily matchea el stack del body (LAYOUT_CSS): el iframe sandbox NO hereda el
			// CSS de la página padre, así que sin esto mermaid cae al font default del browser.
			`<script>mermaid.initialize({startOnLoad:false,securityLevel:"sandbox",theme:"base",themeVariables:window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?{"background":"#F2F1F1","primaryColor":"#FFFFFF","primaryTextColor":"#222223","primaryBorderColor":"#C9C9C9","lineColor":"#0091FF66","clusterBkg":"#EDE4F8","clusterBorder":"#0091FF55","titleColor":"#676B79","fontFamily":"-apple-system, BlinkMacSystemFont, sans-serif"}:{"background":"#292A2B","primaryColor":"#31353A","primaryTextColor":"#E6E6E6","primaryBorderColor":"#3E4250","lineColor":"#6FC1FF66","clusterBkg":"#31353A","clusterBorder":"#6FC1FF55","titleColor":"#BBBBBB","fontFamily":"-apple-system, BlinkMacSystemFont, sans-serif"}});mermaid.run({querySelector:".mermaid"});</script>` +
			`<details><summary>Run diagram (Mermaid source text)</summary><div class="body">` +
			`<div class="kv muted">Si el diagrama de arriba no renderiza (JS deshabilitado o CDN bloqueada), pegá este texto en un visor Mermaid (mermaid.live u otro).</div>` +
			`<pre>${escapeHtml(buildRunMermaidSource(model))}</pre></div></details>`
		: "";

	const basedOnRows = (model.basedOn ?? [])
		.map((item) => {
			const detail = [item.role, item.desc].filter(Boolean).join(" · ");
			return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(detail)}</td></tr>`;
		})
		.join("");
	const basedOnSection = basedOnRows
		? `<h2>Based on</h2><table><thead><tr><th>Scaffold/source</th><th>Role</th></tr></thead><tbody>${basedOnRows}</tbody></table>`
		: "";

	const t = model.metricsTotals;
	const metricsSection = t
		? `<h2>Run metrics</h2><div class="chips">` +
			[
				chip("measured agents", t.measuredAgents),
				chip("ok", t.okAgents),
				chip("failed", t.failedAgents),
				chip("output tokens", t.outputTokensTotal),
				chip("cost", t.costTotal),
				chip("tool calls", t.toolCalls),
				chip("tool errors", t.toolErrors),
				chip("retries", t.autoRetries),
			].join("") +
			`</div>`
		: "";

	const artifactRows = model.artifacts
		.map((a) => {
			const href = artifactViewerHref(a.path) ?? safeRelativeHref(a.path);
			const label = escapeHtml(a.path);
			const cell = href ? `<a href="${href}">${label}</a>` : label;
			return `<tr><td>${cell}</td><td class="mono">${a.bytes !== undefined ? escapeHtml(String(a.bytes)) : ""}</td></tr>`;
		})
		.join("");
	const artifactSection = model.artifacts.length
		? `<h2>Artifacts</h2><table><thead><tr><th>File</th><th>Bytes</th></tr></thead><tbody>${artifactRows}</tbody></table>` +
			(model.artifactsOmitted
				? `<div class="callout warn"><b>Clamp:</b> ${model.artifactsOmitted} more files not listed.</div>`
				: "")
		: "";

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
<div class="chips">${chips}</div>
</header>
${opening}
${callouts.join("\n")}
${renderWorkflowMonitor(model, summary)}
${textBlock("Input", model.input)}
${model.output ? `<h2>Final output</h2>${textBlock("Output", model.output, true, model.outputFormat === "markdown" ? "markdown" : "structured")}` : ""}
${integritySection}
${metricsSection}
${basedOnSection}
${phaseSection}
${mermaidSection}
<h2>Agents (${model.agents.length})</h2>
${model.agents.map(renderAgent).join("\n")}
${logSection}
${artifactSection}
</div>
</body>
</html>
`;
}
