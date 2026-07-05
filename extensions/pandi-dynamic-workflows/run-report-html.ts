/**
 * Pure model→HTML builder for the workflow run report (design record, run bd039ef9).
 *
 * Contract (pinned by run-report-security.test.mjs):
 * - Every model string is UNTRUSTED DATA: most strings render through the 5-char escaper;
 *   agent outputs render as Markdown only through marked + sanitize-html with a strict allowlist.
 * - The emitted page contains ZERO <script> blocks — collapsing uses native
 *   <details>/<summary>, so there is no DOM sink for injected content at all.
 * - hrefs are relative-only: absolute paths, parent traversal, and URL schemes are
 *   refused (the collector containment-checks too; this is defense-in-depth), and
 *   attribute values are URL-encoded per path segment.
 * - Self-contained: inline CSS only (pandi tokens, light+dark); no network assets.
 * - No fs, no ctx, no Date.now(): all times come from the model (generatedAt),
 *   so regeneration from a fixed model is byte-stable.
 */

import { renderRunReportMarkdown } from "./run-report-markdown.js";
import { escapeHtml, safeRelativeHref } from "./run-report-safe-html.js";

export { escapeHtml, safeRelativeHref };

export interface RunReportText {
	text: string;
	truncated: boolean;
}

export interface RunReportAgent {
	id: number;
	name: string;
	/** AgentMonitorState plus the report-vocabulary "interrupted" (agent running while run terminal). */
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
	promptPreview?: string;
	/** Verbatim prompt copy; newer runs source this from bounded structured events. */
	prompt?: RunReportText;
	output?: RunReportText;
	/** Re-serialized structured data (never raw bytes). */
	data?: RunReportText;
	stderrTail?: { text: string; href?: string };
	stdoutHref?: string;
	artifactHref?: string;
	tools?: string;
	skills?: string;
	keys?: string;
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
	/** True when the global inline budget clamped this agent to metadata + links. */
	inlineOmitted?: boolean;
}

export interface RunReportModel {
	workflow: string;
	runId: string;
	scriptPath?: string;
	scope?: string;
	/** running | completed | failed | cancelled | stale */
	state: string;
	/** "verified" (in-session readRunStatus verdict) or "unverified" (foreign dir snapshot). */
	liveness: "verified" | "unverified";
	generatedAt: string;
	/** Opt-in browser refresh for server-regenerated watched reports; ignored unless state is running. */
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
	logs: { time: string; message: string; details?: string }[];
	phases: { label: string; time: string; source?: "event" | "log" }[];
	agents: RunReportAgent[];
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
	/** Visible clamp callouts — clamps are never silent (pandi rule 5). */
	clampNotes: string[];
}

/* Pandi artifact tokens — inlined per the self-contained-extension rule (per-extension
 * duplication is intentional). Pinned against the canonical
 * .pi/skills/pandi-artifact-style/reference/pandi-tokens.css by run-report-tokens parity test. */
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
	if (state === "stale" || state === "cancelled" || state === "interrupted" || state === "unknown") return "warn";
	return "fail";
}

function chip(label: string, value: string | number | undefined): string {
	if (value === undefined || value === "") return "";
	return `<span class="chip">${escapeHtml(label)}: ${escapeHtml(String(value))}</span>`;
}

function truncNote(t: RunReportText): string {
	return t.truncated ? ` <span class="muted">…[truncated]</span>` : "";
}

function textBlock(
	title: string,
	t: RunReportText | undefined,
	open = false,
	render: "pre" | "markdown" = "pre",
): string {
	if (!t) return "";
	const body =
		render === "markdown"
			? `<div class="md-body">${renderRunReportMarkdown(t.text)}</div>`
			: `<pre>${escapeHtml(t.text)}</pre>`;
	return (
		`<details${open ? " open" : ""}><summary>${escapeHtml(title)}${truncNote(t)}</summary>` +
		`<div class="body">${body}</div></details>`
	);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

function openingText(model: RunReportModel, failedAgents: number): string {
	const totalAgents = model.agents.length;
	const agentLabel = plural(totalAgents, "agente");
	const recordedLabel = plural(totalAgents, "registrado");
	if (failedAgents > 0) {
		return `${failedAgents} de ${totalAgents} ${plural(totalAgents, "agente")} falló${failedAgents === 1 ? "" : "n"}. Las tarjetas fallidas están abiertas abajo; empezá por ellas y luego revisá el output final si existe.`;
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
	const safe = safeRelativeHref(href);
	if (!safe) return "";
	return `<a href="${safe}">${escapeHtml(label)}</a>`;
}

function renderAgent(agent: RunReportAgent): string {
	const failed = agent.ok === false || agent.state === "failed";
	const pill = `<span class="rpill ${pillClass(agent.state, agent.ok)}">${escapeHtml(agent.state)}</span>`;
	const meta: string[] = [];
	if (agent.model) meta.push(`model ${agent.model}`);
	if (agent.thinking) meta.push(`effort ${agent.thinking}`);
	if (agent.elapsedMs !== undefined) meta.push(`elapsed ${Math.round(agent.elapsedMs / 100) / 10}s`);
	if (agent.code !== undefined) meta.push(`code ${agent.code}`);
	if (agent.killed) meta.push("killed");
	if (agent.schemaOk !== undefined) meta.push(`schema ${agent.schemaOk ? "ok" : "FAILED"}`);
	if (agent.phaseLabel) meta.push(`phase ${agent.phaseLabel}`);
	const m = agent.metrics;
	if (m?.costTotal !== undefined) meta.push(`cost ${m.costTotal}`);
	if (m?.totalTokens !== undefined) meta.push(`tokens ${m.totalTokens}`);
	if (m?.toolCalls !== undefined) meta.push(`tools ${m.toolCalls}${m.toolErrors ? ` (${m.toolErrors} err)` : ""}`);

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
		if (agent.output) body += textBlock("Output", agent.output, false, "markdown");
		if (agent.data) body += textBlock("Structured data", agent.data);
	}
	if (agent.stderrTail) {
		body += `<div class="kv muted">stderr (bounded tail):</div><pre>${escapeHtml(agent.stderrTail.text)}</pre>`;
	}
	if (!body) body = `<div class="muted">No inline content recorded for this agent.</div>`;
	const access: string[] = [];
	if (agent.tools) access.push(`tools: ${agent.tools}`);
	if (agent.skills) access.push(`skills: ${agent.skills}`);
	if (agent.keys) access.push(`keys: ${agent.keys}`);
	if (access.length) body += `<div class="kv muted">${escapeHtml(access.join(" · "))}</div>`;

	return (
		`<details class="${failed ? "fail-card" : ""}"${failed ? " open" : ""}>` +
		`<summary>${pill} <b>#${agent.id} ${escapeHtml(agent.name)}</b>` +
		` <span class="kv muted">${escapeHtml(meta.join(" · "))}</span>` +
		(links.length ? ` <span class="kv">${links.join(" · ")}</span>` : "") +
		`</summary><div class="body">${body}</div></details>`
	);
}

export function buildRunReportHtml(model: RunReportModel): string {
	const statePill = `<span class="rpill ${pillClass(model.state)}">${escapeHtml(model.state)}</span>`;
	const failedAgents = model.agents.filter((a) => a.ok === false || a.state === "failed").length;
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
		failedAgents ? chip("failed", failedAgents) : "",
		chip("concurrency", model.agentConcurrency),
		chip("maxAgents", model.maxAgents),
		chip("peak parallel", model.peakParallelAgents),
		chip("elapsed", model.elapsedMs !== undefined ? `${Math.round(model.elapsedMs / 1000)}s` : undefined),
		chip("generated", model.generatedAt),
	].join("");
	const opening = `<p class="opening">${escapeHtml(openingText(model, failedAgents))}</p>`;

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
			const href = safeRelativeHref(a.path);
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
${textBlock("Input", model.input)}
${model.output ? `<h2>Final output</h2>${textBlock("Output", model.output, true)}` : ""}
${metricsSection}
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
