/**
 * Secciones de nivel reporte (tablas, callouts, diagrama) extraídas del orquestador html.ts.
 */

import type { RunReportModel } from "./html.js";
import type { ProgressSummary } from "./html-agents.js";
import { chip, prettyJsonOutput } from "./html-builders.js";
import { buildRunMermaidSource, MERMAID_CDN_INTEGRITY, MERMAID_CDN_URL } from "./html-mermaid.js";
import { artifactViewerHref, escapeHtml, safeRelativeHref } from "./safe-html.js";

export function renderCallouts(model: RunReportModel, autoRefreshSeconds: number | undefined): string {
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
	return callouts.join("\n");
}

export function renderHeaderChips(model: RunReportModel, summary: ProgressSummary): string {
	const failedAgents = summary.failed;
	return [
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
}

export function renderPhaseSection(model: RunReportModel): string {
	const phaseRows = model.phases
		.map(
			(p) =>
				`<tr><td class="mono">${escapeHtml(p.time)}</td><td>${escapeHtml(p.label)}</td><td>${escapeHtml(p.source ?? "log")}</td></tr>`,
		)
		.join("");
	if (!model.phases.length) return "";
	const hasStructuredPhases = model.phases.some((p) => p.source === "event");
	return (
		`<h2>Phases</h2><div class="kv muted">${
			hasStructuredPhases
				? "Structured phase events from the run dir; legacy log-derived phases are marked as log."
				: 'Derived from the "phase: …" log convention.'
		}</div>` +
		`<table><thead><tr><th>Time</th><th>Phase</th><th>Source</th></tr></thead><tbody>${phaseRows}</tbody></table>`
	);
}

export function renderLogSection(logs: RunReportModel["logs"]): string {
	return logs.length
		? `<details><summary>Timeline (${logs.length} log entries)</summary><div class="body">${renderTimeline(logs)}</div></details>`
		: "";
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

export function renderIntegritySection(integrity: RunReportModel["integrity"]): string {
	if (!integrity) return "";
	return (
		`<h2>Result integrity</h2><div class="chips">` +
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
	);
}

export function renderMetricsSection(t: RunReportModel["metricsTotals"]): string {
	if (!t) return "";
	return (
		`<h2>Run metrics</h2><div class="chips">` +
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
	);
}

export function renderBasedOnSection(basedOn: RunReportModel["basedOn"]): string {
	const basedOnRows = (basedOn ?? [])
		.map((item) => {
			const detail = [item.role, item.desc].filter(Boolean).join(" · ");
			return `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(detail)}</td></tr>`;
		})
		.join("");
	return basedOnRows
		? `<h2>Based on</h2><table><thead><tr><th>Scaffold/source</th><th>Role</th></tr></thead><tbody>${basedOnRows}</tbody></table>`
		: "";
}

export function renderArtifactSection(
	artifacts: RunReportModel["artifacts"],
	artifactsOmitted: number | undefined,
): string {
	if (!artifacts.length) return "";
	const artifactRows = artifacts
		.map((a) => {
			const href = artifactViewerHref(a.path) ?? safeRelativeHref(a.path);
			const label = escapeHtml(a.path);
			const cell = href ? `<a href="${href}">${label}</a>` : label;
			return `<tr><td>${cell}</td><td class="mono">${a.bytes !== undefined ? escapeHtml(String(a.bytes)) : ""}</td></tr>`;
		})
		.join("");
	return (
		`<h2>Artifacts</h2><table><thead><tr><th>File</th><th>Bytes</th></tr></thead><tbody>${artifactRows}</tbody></table>` +
		(artifactsOmitted
			? `<div class="callout warn"><b>Clamp:</b> ${artifactsOmitted} more files not listed.</div>`
			: "")
	);
}

export function renderMermaidSection(model: RunReportModel): string {
	if (!model.agents.length) return "";
	return (
		`<h2 id="run-diagram">Run diagram</h2><div class="mermaid">${escapeHtml(buildRunMermaidSource(model))}</div>` +
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
	);
}
