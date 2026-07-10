import { formatElapsedMs } from "../presentation.js";
import type { RunReportAgent, RunReportModel } from "./html.js";
import { artifactViewerHref, escapeHtml, safeRelativeHref } from "./safe-html.js";

export function pillClass(state: string, ok?: boolean): string {
	if (state === "completed" && ok !== false) return "ok";
	if (state === "running") return "run";
	if (state === "cached") return "ok";
	if (state === "interrupted") return "fail";
	if (state === "stale" || state === "cancelled" || state === "unknown") return "warn";
	return "fail";
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
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

export function agentFailed(agent: RunReportAgent): boolean {
	return agent.ok === false || agent.state === "failed" || agent.state === "interrupted";
}

function agentSucceeded(agent: RunReportAgent): boolean {
	return (agent.state === "completed" || agent.state === "cached") && agent.ok !== false;
}

function agentDone(agent: RunReportAgent): boolean {
	return agent.state !== "running";
}

export interface ProgressSummary {
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

export function summarizeProgress(model: RunReportModel): ProgressSummary {
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

export function agentAccessMeta(agent: RunReportAgent): string {
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

export function link(href: string | undefined, label: string): string {
	const safe = artifactViewerHref(href) ?? safeRelativeHref(href);
	if (!safe) return "";
	return `<a href="${safe}">${escapeHtml(label)}</a>`;
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

export function renderWorkflowMonitor(model: RunReportModel, summary: ProgressSummary): string {
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
