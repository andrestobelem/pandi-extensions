/**
 * Pure monitor/agents tab renderers for WorkflowDashboard — agent state labels, row meta
 * chips, selected-agent detail, and the Monitor + Agents list+detail views. No class state;
 * the dashboard class wires theme formatters and pushes returned lines.
 */
import type { WorkflowAgentEntry, WorkflowMonitorModel } from "./dashboard-collectors.js";
import { formatAgentPhase, getAgentElapsedMs } from "./event-parser.js";
import { compactInline, formatElapsedMs } from "./presentation.js";
import { padRightVisible, renderMeter, renderSafeInline } from "./render-utils.js";
import {
	formatParallelAgents,
	getRunAgentConcurrency,
	getRunParallelAgents,
	getRunState,
	getRunStatusLabel,
} from "./run-state.js";
import type { AgentMonitorModel, WorkflowRunRecord } from "./types.js";
import { START_WORKFLOW_HINT, windowLabel, windowStart } from "./workflow-dashboard-views.js";

interface DashboardMonitorViewFormatters {
	line: (s: string) => string;
	accent: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
	error: (s: string) => string;
	warning: (s: string) => string;
	dim: (s: string) => string;
}

export function agentStateLabel(
	agent: AgentMonitorModel,
	accent: (s: string) => string,
	muted: (s: string) => string,
	success: (s: string) => string,
	error: (s: string) => string,
): string {
	if (agent.state === "completed") return success("✓ done");
	if (agent.state === "running") return accent("▶ running");
	if (agent.state === "cached") return muted("♻ cached");
	if (agent.state === "failed") return error("✗ failed");
	return muted("? unknown");
}

/**
 * Render the shared "Selected agent" detail block used by both the Monitor and
 * Agents tabs. The two callers only differ in: optional header lines
 * (workflow/run/parallel), whether the `state:` line includes the schema
 * suffix, and the `compactInline` width for prompt preview / output.
 */
export function renderSelectedAgentDetail(
	line: (s: string) => string,
	agent: AgentMonitorModel,
	accent: (s: string) => string,
	muted: (s: string) => string,
	success: (s: string) => string,
	warning: (s: string) => string,
	dim: (s: string) => string,
	options: { headerLines?: string[]; includeSchemaInState: boolean; compactWidth: number },
): string[] {
	const lines: string[] = [];
	lines.push(line(muted("")));
	lines.push(line(accent("Selected agent")));
	for (const header of options.headerLines ?? []) lines.push(line(header));
	lines.push(line(`agent: #${agent.id} ${formatAgentPhase(agent) ? `${formatAgentPhase(agent)} ` : ""}${agent.name}`));
	const elapsedMs = getAgentElapsedMs(agent);
	const schemaSuffix = options.includeSchemaInState
		? `${agent.schemaOk === undefined ? "" : ` • schema ${agent.schemaOk ? "ok" : "bad"}`}`
		: "";
	lines.push(
		line(
			`state: ${renderSafeInline(agent.state)}${elapsedMs === undefined ? "" : ` • ${formatElapsedMs(elapsedMs)}`}${agent.code === undefined ? "" : ` • code ${agent.code}`}${schemaSuffix}`,
		),
	);
	if (formatAgentPhase(agent))
		lines.push(line(`phase: ${formatAgentPhase(agent)}${agent.phaseLabel ? muted(` • ${agent.phaseLabel}`) : ""}`));
	lines.push(
		line(
			`prompt: ${agent.promptAvailable ? success("available") : warning("not available")} ${agent.artifactPath ? muted(`• ${agent.artifactPath}`) : ""}`,
		),
	);
	lines.push(line(""));
	lines.push(line(dim("config")));
	lines.push(
		line(
			`model: ${agent.model ? renderSafeInline(agent.model) : "default"} • effort: ${agent.thinking ? renderSafeInline(agent.thinking) : "default"}`,
		),
	);
	lines.push(
		line(
			`tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}${agent.excludeTools?.length ? ` • exclude: ${agent.excludeTools.join(", ")}` : ""}`,
		),
	);
	lines.push(
		line(
			`skills: ${agent.skills?.length ? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}` : agent.includeSkills === false ? "disabled" : "default discovery"}`,
		),
	);
	lines.push(
		line(
			`extensions: ${agent.extensions?.length ? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}` : agent.includeExtensions ? "default discovery" : "disabled"}`,
		),
	);
	lines.push(
		line(
			`keys: ${agent.keys?.length ? agent.keys.join(", ") : agent.isolatedEnv ? "none selected" : "default inherited environment"}${agent.missingKeys?.length ? warning(` • missing: ${agent.missingKeys.join(", ")}`) : ""}`,
		),
	);
	if (
		agent.promptPreview ||
		agent.output !== undefined ||
		agent.outputEmpty ||
		agent.outputTruncated ||
		agent.stdoutTruncated
	) {
		lines.push(line(""));
		lines.push(line(dim("i/o")));
	}
	if (agent.promptPreview)
		lines.push(line(`prompt preview: ${renderSafeInline(compactInline(agent.promptPreview, options.compactWidth))}`));
	if (agent.output !== undefined)
		lines.push(line(`output: ${renderSafeInline(compactInline(agent.output, options.compactWidth))}`));
	if (agent.outputEmpty) lines.push(line(warning("integrity: empty-output")));
	if (agent.outputTruncated)
		lines.push(
			line(
				warning(
					`integrity: output:truncated${agent.outputChars === undefined ? "" : ` (${agent.outputChars} chars)`}`,
				),
			),
		);
	if (agent.stdoutTruncated)
		lines.push(
			line(
				warning(
					`integrity: stdout:truncated${agent.stdoutChars === undefined ? "" : ` (${agent.stdoutChars} chars)`}`,
				),
			),
		);
	return lines;
}

// Common per-row chip suffix (`prompt schema tools skills extensions keys`)
// shared byte-for-byte by the Monitor and Agents tabs. Callers keep their own
// prefix/state/elapsed and the tab-specific segments (Monitor's `code:` chip,
// Agents' `— <workflow> <runId>` segment) outside this helper.
export function renderAgentRowMeta(
	agent: AgentMonitorModel,
	muted: (s: string) => string,
	success: (s: string) => string,
	error: (s: string) => string,
	warning: (s: string) => string,
	dim: (s: string) => string,
): string {
	// Chips unidos por un divisor ` · ` para que la fila respire; las ETIQUETAS de chip usan dim para que
	// los chips que llevan estado (prompt✓ / schema:bad / missing) sigan siendo los que atraen la vista.
	const chips: string[] = [agent.promptAvailable ? success("prompt✓") : warning("prompt?")];
	if (agent.schemaOk !== undefined) chips.push(agent.schemaOk ? muted("schema:ok") : error("schema:bad"));
	if (agent.outputEmpty) chips.push(error("empty-output"));
	if (agent.outputTruncated) chips.push(warning("output:truncated"));
	if (agent.stdoutTruncated) chips.push(warning("stdout:truncated"));
	// chips de modelo/esfuerzo: id de modelo corto (último segmento de ruta) para mantener la fila compacta;
	// omitido completamente cuando se desconoce (ejecuciones registradas antes de que existieran estos campos).
	if (agent.model) chips.push(dim(`model:${renderSafeInline(agent.model.split("/").pop() ?? agent.model)}`));
	if (agent.thinking) chips.push(dim(`effort:${renderSafeInline(agent.thinking)}`));
	chips.push(dim(`tools:${agent.tools?.length ? agent.tools.length : "default"}`));
	chips.push(
		dim(`skills:${agent.skills?.length ? agent.skills.length : agent.includeSkills === false ? "off" : "default"}`),
	);
	chips.push(
		dim(`ext:${agent.extensions?.length ? agent.extensions.length : agent.includeExtensions ? "default" : "off"}`),
	);
	chips.push(dim(`keys:${agent.keys?.length ? agent.keys.length : agent.isolatedEnv ? "none" : "default"}`));
	if (agent.missingKeys?.length) chips.push(warning(`missing:${agent.missingKeys.length}`));
	return chips.join(" · ");
}

export function renderMonitorAgents(
	line: (s: string) => string,
	model: WorkflowMonitorModel,
	monitorAgentIndex: number,
	selectedAgent: AgentMonitorModel | undefined,
	{ accent, muted, success, error, warning, dim }: DashboardMonitorViewFormatters,
): string[] {
	const lines: string[] = [];
	if (model.agents.length === 0) return lines;
	lines.push(line(muted("")));
	const start = windowStart(monitorAgentIndex, model.agents.length, 6, 12);
	const visible = model.agents.slice(start, start + 12);
	lines.push(
		line(
			accent(`Agents (${model.agents.length})`) +
				muted(windowLabel(model.agents.length, start, 12)) +
				muted(
					` • parallel ${model.agentConcurrency && model.agentConcurrency > 0 ? `${model.parallelAgents}/${model.agentConcurrency}` : model.parallelAgents}${model.peakParallelAgents === undefined ? "" : ` • peak ${model.peakParallelAgents}`}`,
				),
		),
	);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const agent = visible[i];
		const selected = index === monitorAgentIndex;
		const prefix = selected ? accent("› ") : "  ";
		const state = agentStateLabel(agent, accent, muted, success, error);
		const agentElapsedMs = getAgentElapsedMs(agent);
		const elapsed = agentElapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agentElapsedMs)}`;
		const phase = formatAgentPhase(agent);
		const code = agent.code === undefined ? "" : agent.code === 0 ? muted(` code:0`) : error(` code:${agent.code}`);
		const meta = renderAgentRowMeta(agent, muted, success, error, warning, dim);
		lines.push(
			line(
				`${prefix}${state} #${agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(agent.name)} ${muted(elapsed)}${code} ${meta}`,
			),
		);
	}
	if (!selectedAgent) return lines;
	lines.push(
		...renderSelectedAgentDetail(line, selectedAgent, accent, muted, success, warning, dim, {
			includeSchemaInState: false,
			compactWidth: 220,
		}),
	);
	return lines;
}

export function renderMonitor(
	model: WorkflowMonitorModel | undefined,
	monitorModels: WorkflowMonitorModel[],
	monitorRunIndex: number,
	monitorAgentIndex: number,
	selectedAgent: AgentMonitorModel | undefined,
	{ line, accent, muted, success, error, warning, dim }: DashboardMonitorViewFormatters,
): string[] {
	// Línea en blanco + subtítulo dim: agrupa el bloque de etiqueta densa en secciones legibles.
	const lines: string[] = [];
	const section = (caption: string) => {
		lines.push(line(""));
		lines.push(line(dim(caption)));
	};
	if (!model) {
		lines.push(line(warning("No se encontraron workflow runs.")));
		lines.push(line(muted(START_WORKFLOW_HINT)));
		return lines;
	}

	const stateColor =
		model.state === "completed"
			? success
			: model.state === "running"
				? accent
				: model.state === "stale"
					? warning
					: error;
	const label = (name: string, value: string) =>
		lines.push(line(`${muted(padRightVisible(`${name}:`, 11))} ${value}`));
	const statusTail = model.active ? accent("active") : model.stale ? warning("stale") : muted("inactive");
	const total = monitorModels.length;
	if (total > 1) {
		lines.push(
			line(accent(`Active runs (${total})`) + muted(` • [ ] switch • showing ${monitorRunIndex + 1}/${total}`)),
		);
		for (let i = 0; i < total; i++) {
			const m = monitorModels[i];
			const focused = i === monitorRunIndex;
			const prefix = focused ? accent("› ") : "  ";
			const glyph =
				m.state === "completed"
					? success("✓")
					: m.state === "running"
						? accent("▶")
						: m.state === "stale"
							? warning("?")
							: error("✗");
			const parallel =
				m.agentConcurrency && m.agentConcurrency > 0
					? `${m.parallelAgents}/${m.agentConcurrency}`
					: String(m.parallelAgents);
			const rowMeter = renderMeter(m.agentsStarted > 0 ? m.agentsDone / m.agentsStarted : 0, 8, {
				fill: success,
				empty: muted,
			});
			lines.push(
				line(
					`${prefix}${glyph} ${m.workflow} ${muted(m.runId)} ${rowMeter} ${m.agentsDone}/${m.agentsStarted} ${muted(`parallel:${parallel}`)}`,
				),
			);
		}
		lines.push(line(muted("")));
	}
	const title =
		total > 1
			? `Active run ${monitorRunIndex + 1}/${total}`
			: model.priority === "active"
				? "Active run"
				: "Latest run";
	lines.push(line(accent(title)));
	label("workflow", model.workflow);
	label("state", `${stateColor(getRunStatusLabel(model.run))} ${muted("•")} ${statusTail}`);
	label("elapsed", formatElapsedMs(model.elapsedMs));

	section("Progress");
	const progressFrac = model.agentsStarted > 0 ? model.agentsDone / model.agentsStarted : 0;
	const progressMeter = renderMeter(progressFrac, 14, { fill: success, empty: muted });
	label(
		"agents",
		`${model.agentsDone}/${model.agentsStarted} done/started ${progressMeter} ${muted(`${Math.round(progressFrac * 100)}%`)}`,
	);
	const hasConcurrency = !!(model.agentConcurrency && model.agentConcurrency > 0);
	const parallelText = hasConcurrency
		? `${model.parallelAgents}/${model.agentConcurrency}`
		: `${model.parallelAgents}`;
	const utilMeter = hasConcurrency
		? ` ${renderMeter(model.parallelAgents / (model.agentConcurrency as number), 14, { fill: accent, empty: muted })}`
		: "";
	label(
		"parallel",
		`${parallelText} running${utilMeter}${model.peakParallelAgents === undefined ? "" : ` • peak:${model.peakParallelAgents}`}`,
	);
	label("bash", `${model.bashDone} done`);
	label("artifacts", String(model.artifactCount));

	section("Location");
	label("run", model.runId);
	label("runDir", dim(model.runDir));

	section("Activity");
	const last = model.lastLog
		? `${model.lastLog.time.slice(11, 19)} ${renderSafeInline(model.lastLog.message)}`
		: "No logs recorded yet.";
	label("last", last);
	if (model.run.error) label("error", error(renderSafeInline(compactInline(model.run.error, 200))));
	// Action hints live on the gated header banner (render line 1); no redundant footer here.
	lines.push(
		...renderMonitorAgents(line, model, monitorAgentIndex, selectedAgent, {
			line,
			accent,
			muted,
			success,
			error,
			warning,
			dim,
		}),
	);
	return lines;
}

export function renderAgents(
	agentEntries: WorkflowAgentEntry[],
	agentIndex: number,
	runs: WorkflowRunRecord[],
	selectedAgentEntry: WorkflowAgentEntry | undefined,
	{ line, accent, muted, success, error, warning, dim }: DashboardMonitorViewFormatters,
): string[] {
	const lines: string[] = [];
	if (agentEntries.length === 0) {
		lines.push(line(warning("No workflow agents found yet.")));
		lines.push(
			line(
				muted(
					"Start a workflow with subagents, then return here to inspect prompts, state, artifacts, and output.",
				),
			),
		);
		lines.push(line(muted(START_WORKFLOW_HINT)));
		return lines;
	}
	const running = agentEntries.filter((entry) => entry.agent.state === "running").length;
	const failed = agentEntries.filter((entry) => entry.agent.state === "failed").length;
	const cached = agentEntries.filter((entry) => entry.agent.state === "cached").length;
	const activeRuns = runs.filter((run) => getRunState(run) === "running");
	const parallelNow = activeRuns.reduce((sum, run) => sum + getRunParallelAgents(run), 0);
	const parallelLimit = activeRuns.reduce((sum, run) => sum + (getRunAgentConcurrency(run) ?? 0), 0);
	const parallelText = parallelLimit > 0 ? `${parallelNow}/${parallelLimit}` : String(parallelNow);
	const start = windowStart(agentIndex, agentEntries.length, 7, 14);
	const visible = agentEntries.slice(start, start + 14);
	lines.push(
		line(
			`${accent("All agents")} ${muted(`(${agentEntries.length})`)}${muted(windowLabel(agentEntries.length, start, 14))} ${accent(`parallel:${parallelText}`)} ${running ? accent(`running:${running}`) : muted("running:0")} ${failed ? error(`failed:${failed}`) : muted("failed:0")} ${cached ? muted(`cached:${cached}`) : ""}`,
		),
	);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const entry = visible[i];
		const selected = index === agentIndex;
		const prefix = selected ? accent("› ") : "  ";
		const state = agentStateLabel(entry.agent, accent, muted, success, error);
		const agentElapsedMs = getAgentElapsedMs(entry.agent);
		const elapsed = agentElapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agentElapsedMs)}`;
		const phase = formatAgentPhase(entry.agent);
		const meta = renderAgentRowMeta(entry.agent, muted, success, error, warning, dim);
		lines.push(
			line(
				`${prefix}${state} #${entry.agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(entry.agent.name)} ${muted(`— ${entry.run.workflow} ${entry.run.runId.slice(-12)}`)} ${muted(elapsed)} ${meta}`,
			),
		);
	}
	if (!selectedAgentEntry) return lines;
	const agent = selectedAgentEntry.agent;
	const run = selectedAgentEntry.run;
	lines.push(
		...renderSelectedAgentDetail(line, agent, accent, muted, success, warning, dim, {
			headerLines: [`workflow: ${run.workflow}`, `run: ${run.runId}`, `parallel: ${formatParallelAgents(run)}`],
			includeSchemaInState: true,
			compactWidth: 260,
		}),
	);
	// Action hints live on the gated header banner (render line 1); no redundant footer here.
	return lines;
}
