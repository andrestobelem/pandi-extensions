import type { RunReportAgent, RunReportModel } from "./html.js";
import { agentAccessMeta, agentFailed, link, type ProgressSummary, pillClass, plural } from "./html-agents.js";
import { prettyJsonOutput, textBlock } from "./html-text.js";
import { escapeHtml } from "./safe-html.js";

export function openingText(model: RunReportModel, summary: ProgressSummary): string {
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

export function renderTimelineDetails(details: string | undefined): string {
	if (!details) return "";
	const pretty = prettyJsonOutput(details);
	const body = pretty
		? `<pre class="json-output">${escapeHtml(pretty)}</pre>`
		: `<div class="kv muted">${escapeHtml(details)}</div>`;
	return `<div class="timeline-details">${body}</div>`;
}

export function renderTimeline(logs: RunReportModel["logs"]): string {
	const items = logs
		.map(
			(log) =>
				`<li class="timeline-item"><span class="timeline-time">${escapeHtml(log.time)}</span>` +
				`<div class="timeline-message">${escapeHtml(log.message)}</div>${renderTimelineDetails(log.details)}</li>`,
		)
		.join("");
	return `<ol class="timeline-list">${items}</ol>`;
}

export function renderAgent(agent: RunReportAgent): string {
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
