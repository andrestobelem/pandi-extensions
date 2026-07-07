/**
 * Builder puro model→HTML para el reporte de run de workflow (registro de diseño, run bd039ef9).
 *
 * Contrato (pineado por run-report-security.test.mjs):
 * - Cada string del modelo es UNTRUSTED DATA: la mayoría de strings renderiza vía el escaper de 5 chars;
 *   las salidas de agentes renderizan como Markdown solo vía marked + sanitize-html con allowlist estricta.
 * - La página emitida contiene CERO bloques <script>: el colapso usa
 *   <details>/<summary> nativos, así no hay ningún sink DOM para contenido inyectado.
 * - Los hrefs son solo relativos: paths absolutos, parent traversal y esquemas URL se
 *   rechazan (el collector también chequea contención; esto es defense-in-depth), y
 *   los valores de atributos se URL-encodean por segmento de path.
 * - Autocontenido: solo CSS inline (tokens pandi, claro+oscuro); sin assets de red.
 * - Sin fs, sin ctx, sin Date.now(): todos los tiempos vienen del modelo (generatedAt),
 *   así la regeneración desde un modelo fijo es byte-stable.
 */

import { renderRunReportMarkdown } from "./run-report-markdown.js";
import { artifactViewerHref, escapeHtml, safeRelativeHref } from "./run-report-safe-html.js";

export { escapeHtml, safeRelativeHref };

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

/* Tokens de artifact Pandi — inlineados por la regla de extensión autocontenida (la duplicación
 * por extensión es intencional). Pineados contra el canónico
 * .pi/skills/pandi-artifact-style/reference/pandi-tokens.css por el test de paridad run-report-tokens. */
export const PANDI_TOKENS_CSS = `:root {
  --bg: #242526;
  --paper: #292A2B;
  --info-bg: #2E2A33;
  --raised: #31353A;
  --ink: #E6E6E6;
  --ink2: #BBBBBB;
  --muted: #757575;
  --line: #3E4250;
  --line-strong: #676B79;
  --accent: #FF75B5;
  --accent-soft: #FF9AC1;
  --link: #6FC1FF;
  --info: #45A9F9;
  --success: #19F9D8;
  --warning: #FFCC95;
  --error: #FF4B82;
  --code: #19F9D8;
  --purple: #BCAAFE;
  --success-bg: #1E2E2B;
  --error-bg: #2E1E24;
  --warning-bg: #2E2A33;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ECECEC;
    --paper: #F2F1F1;
    --info-bg: #EDE4F8;
    --raised: #E6DBCB;
    --ink: #222223;
    --ink2: #676B79;
    --muted: #8D8D8D;
    --line: #C9C9C9;
    --line-strong: #676B79;
    --accent: #FF0077;
    --accent-soft: #FF629E;
    --link: #0091FF;
    --info: #0091FF;
    --success: #12B69D;
    --warning: #FF8400;
    --error: #FF4B82;
    --code: #12B69D;
    --purple: #B084EB;
    --success-bg: #DCEEEA;
    --error-bg: #F7DCE4;
    --warning-bg: #EDE4F8;
  }
}`;

const LAYOUT_CSS = `
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.container { max-width: 1000px; margin: 0 auto; padding: 28px 20px 60px; }
header .kicker { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); font-weight:600; }
header h1 { margin:6px 0 2px; font-size:24px; color:var(--ink); }
header .sub { color:var(--ink2); font-size:13px; }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 4px; }
.chip { font-size:12px; color:var(--ink2); background:var(--paper); border:1px solid var(--line); border-radius:999px; padding:3px 10px; }
.monitor-panel { background:var(--paper); border:1px solid var(--line); border-radius:14px; padding:14px; margin:18px 0; }
.monitor-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
.monitor-head h2 { margin:0; }
.monitor-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(135px,1fr)); gap:10px; margin:10px 0 14px; }
.metric-card { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:10px; min-height:82px; }
.metric-label { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.metric-value { font-size:22px; line-height:1.2; color:var(--ink); font-weight:700; margin-top:3px; }
.metric-detail { color:var(--ink2); font-size:12px; margin-top:5px; }
.meter { display:inline-block; width:70px; height:8px; border-radius:999px; background:var(--raised); border:1px solid var(--line); overflow:hidden; vertical-align:middle; margin-right:6px; }
.meter span { display:block; height:100%; background:var(--success); }
.meter.fail span { background:var(--error); }
.meter.run span { background:var(--info); }
.meter.warn span { background:var(--warning); }
.monitor-table { margin-top:8px; }
.monitor-table tr.featured td { background:var(--info-bg); }
.monitor-agent-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--ink2); margin:4px 0 8px; }
.monitor-agent-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.monitor-agent-state { font-weight:700; }
.monitor-agent-state.ok { color:var(--success); }
.monitor-agent-state.run { color:var(--info); }
.monitor-agent-state.fail { color:var(--error); }
.monitor-agent-state.warn { color:var(--warning); }
.agent-chipline { display:flex; flex-wrap:wrap; gap:5px; }
.mini-chip { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 7px; background:var(--bg); color:var(--ink2); font-size:11.5px; white-space:nowrap; }
.mini-chip.ok { border-color:var(--success); color:var(--success); background:var(--success-bg); }
.mini-chip.warn { border-color:var(--warning); color:var(--warning); background:var(--warning-bg); }
.mini-chip.fail { border-color:var(--error); color:var(--error); background:var(--error-bg); }
.monitor-selected { display:grid; gap:5px; }
.monitor-detail-line { color:var(--ink2); }
.monitor-subtitle { margin-top:4px; color:var(--muted); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
.rpill { font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; white-space:nowrap; }
.rpill.ok   { background:var(--success-bg); color:var(--success); border:1px solid var(--success); }
.rpill.run  { background:var(--info-bg);    color:var(--info);    border:1px solid var(--info); }
.rpill.fail { background:var(--error-bg);   color:var(--error);   border:1px solid var(--error); }
.rpill.warn { background:var(--warning-bg); color:var(--warning); border:1px solid var(--warning); }
h2 { font-size:16px; color:var(--info); margin:28px 0 10px; }
.callout { margin:10px 0; padding:10px 14px; border-radius:10px; font-size:13.5px; border:1px solid var(--line); border-left-width:4px; background:var(--paper); color:var(--ink); }
.callout.info    { background:var(--info-bg);    border-color:var(--purple); }
.callout.warn    { background:var(--warning-bg); border-color:var(--warning); }
.callout.error   { background:var(--error-bg);   border-color:var(--error); }
.opening { margin:14px 0 8px; color:var(--ink); background:var(--paper); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:10px; padding:10px 14px; font-size:13.5px; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--ink2); font-weight:600; }
details { background:var(--paper); border:1px solid var(--line); border-radius:12px; margin:10px 0; }
details > summary { padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
details > summary:hover { background:var(--raised); }
details .body { border-top:1px solid var(--line); padding:14px 16px; color:var(--ink2); }
details.fail-card { border-color:var(--error); }
pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ink); white-space:pre-wrap; word-break:break-word; }
pre.json-output { white-space:pre; }
.md-body { color:var(--ink2); }
.md-body p, .md-body ul, .md-body ol, .md-body blockquote, .md-body table { margin:0 0 10px; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 { color:var(--ink); margin:14px 0 8px; }
.md-body h1 { font-size:18px; } .md-body h2 { font-size:16px; } .md-body h3, .md-body h4, .md-body h5, .md-body h6 { font-size:14px; }
.md-body code { color:var(--code); background:var(--raised); border-radius:5px; padding:1px 5px; }
.md-body pre code { background:none; padding:0; color:var(--ink); }
.md-body blockquote { border-left:3px solid var(--accent); padding-left:12px; color:var(--ink2); }
.md-body .md-image-alt, .md-body .md-link-text { color:var(--muted); font-style:italic; }
a { color:var(--link); }
.muted { color:var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.kv { color:var(--ink2); font-size:12.5px; }
`;

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

function prettyJsonOutput(text: string): string | undefined {
	const trimmed = text.trim();
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return undefined;
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		return undefined;
	}
}

function renderTextBody(text: string, render: "pre" | "markdown"): string {
	const json = prettyJsonOutput(text);
	if (json !== undefined) return `<pre class="json-output">${escapeHtml(json)}</pre>`;
	return render === "markdown"
		? `<div class="md-body">${renderRunReportMarkdown(text)}</div>`
		: `<pre>${escapeHtml(text)}</pre>`;
}

function textBlock(
	title: string,
	t: RunReportText | undefined,
	open = false,
	render: "pre" | "markdown" = "pre",
): string {
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

function formatReportElapsedMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
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
	const elapsed = agent.elapsedMs === undefined ? "elapsed:…" : `elapsed:${formatReportElapsedMs(agent.elapsedMs)}`;
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
			`${escapeHtml(agent.state)}${agent.elapsedMs !== undefined ? ` <span class="muted">•</span> ${escapeHtml(formatReportElapsedMs(agent.elapsedMs))}` : ""}${agent.code !== undefined ? ` <span class="muted">•</span> code ${escapeHtml(String(agent.code))}` : ""}`,
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
			body += textBlock("Prompt", agent.prompt);
		}
		if (agent.output !== undefined) body += textBlock("Output", agent.output, false, "markdown");
		if (agent.data) body += textBlock("Structured data", agent.data);
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

	const logRows = model.logs
		.map(
			(l) =>
				`<tr><td class="mono">${escapeHtml(l.time)}</td><td>${escapeHtml(l.message)}` +
				(l.details ? `<div class="kv muted">${escapeHtml(l.details)}</div>` : "") +
				`</td></tr>`,
		)
		.join("");
	const logSection = model.logs.length
		? `<details><summary>Timeline (${model.logs.length} log entries)</summary><div class="body">` +
			`<table><thead><tr><th>Time</th><th>Message</th></tr></thead><tbody>${logRows}</tbody></table></div></details>`
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
${model.output ? `<h2>Final output</h2>${textBlock("Output", model.output, true, model.outputFormat === "markdown" ? "markdown" : "pre")}` : ""}
${integritySection}
${metricsSection}
${basedOnSection}
${phaseSection}
<h2>Agents (${model.agents.length})</h2>
${model.agents.map(renderAgent).join("\n")}
${logSection}
${artifactSection}
</div>
</body>
</html>
`;
}
