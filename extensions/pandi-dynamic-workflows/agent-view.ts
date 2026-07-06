/**
 * Agent view rendering — the live/finished agent detail view (formatAgentView), its run/
 * artifact path resolvers, the markdown-section extractor, and showLiveAgentView which opens
 * the AgentLiveViewComponent. The read/render half of the agent monitor.
 *
 * Deferred cycles: showLiveAgentView constructs AgentLiveViewComponent (agent-live-view.js)
 * inside its body while that component reads liveAgentHeaderStatus from here; event-parser.js
 * reads extractMarkdownSection from here inside a body. index.ts re-exports
 * liveAgentHeaderStatus for the usability test. Extracted byte-identically.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentLiveViewComponent } from "./agent-live-view.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import { formatAgentPhase, readRunEvents } from "./event-parser.js";
import { MAX_TOOL_TEXT, truncate } from "./format.js";
import { computeCodeHash } from "./journal.js";
import { notify } from "./notify.js";
import { formatElapsedMs } from "./presentation.js";
import { formatRunView, pickAndOpenRunArtifact } from "./run-view.js";
import type { AgentMonitorModel, WorkflowRunRecord } from "./types.js";

type ParsedPiStdout = ReturnType<typeof parsePiJsonModeOutput>;
type SettingRow = [string, string];
type AgentSummaryFormatInput = {
	run: WorkflowRunRecord;
	agent: AgentMonitorModel;
	agentRef: string;
	stateIcon: string;
	phase: string | undefined;
	artifactPath: string | undefined;
	artifactError: string;
};

type AgentOutputLinesInput = {
	outputText: string;
	structuredOutput: string | undefined;
	stdoutNote: string | undefined;
	liveStdoutPath: string | undefined;
	liveStderrPath: string | undefined;
	stderr: string | undefined;
	liveStderr: string;
};

type AgentPromptLinesInput = {
	agentRef: string;
	agentName: string;
	promptTable: string;
	promptText: string;
	access: string | undefined;
};

export function resolveAgentArtifactPath(run: WorkflowRunRecord, agent: AgentMonitorModel): string | undefined {
	if (!agent.artifactPath) return undefined;
	// artifactPath se origina en events.jsonl no confiable; conténlo dentro de runDir
	// para que una ruta absoluta manipulada o un recorrido "../" no puedan leer archivos arbitrarios.
	const resolved = path.resolve(run.runDir, agent.artifactPath);
	const base = path.resolve(run.runDir);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
	return resolved;
}

function resolveAgentLiveStreamPath(artifactPath: string | undefined, stream: "stdout" | "stderr"): string | undefined {
	if (!artifactPath) return undefined;
	return artifactPath.endsWith(".md") ? `${artifactPath.slice(0, -3)}.${stream}.log` : `${artifactPath}.${stream}.log`;
}

export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const knownHeadings = ["Access", "Prompt", "Structured Output", "Stdout", "Stderr"];
	const nextHeadings = knownHeadings
		.filter((candidate) => candidate !== heading)
		.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const nextPattern = nextHeadings.length ? `\\n## (?:${nextHeadings.join("|")})\\n` : "$^";
	const match = new RegExp(`(?:^|\\n)## ${escaped}\\n\\n([\\s\\S]*?)(?=${nextPattern}|$)`).exec(markdown);
	return match?.[1]?.trim();
}

function fencedBlock(content: string, lang = "text"): string {
	const fence = content.includes("```") ? "````" : "```";
	return `${fence}${lang}\n${content}\n${fence}`;
}

function escapeMarkdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatSettingTable(rows: SettingRow[]): string {
	return [
		"| Setting | Value |",
		"| --- | --- |",
		...rows.map(([key, value]) => `| ${escapeMarkdownTableCell(key)} | ${escapeMarkdownTableCell(value)} |`),
	].join("\n");
}

function agentStateIcon(state: AgentMonitorModel["state"]): string {
	if (state === "completed") return "✅";
	if (state === "running") return "▶️";
	if (state === "cached") return "♻️";
	if (state === "failed") return "❌";
	return "?";
}

function formatAgentRef(agent: AgentMonitorModel, phase: string | undefined): string {
	return `#${agent.id}${phase ? ` ${phase}` : ""}`;
}

function describePromptSource(
	promptFromEvent: string | undefined,
	prompt: string | undefined,
	promptAvailable: boolean | undefined,
): string {
	if (promptFromEvent) return "event promptCopy";
	if (prompt) return "artifact Prompt section";
	return promptAvailable ? "artifact missing/unparsed" : "unavailable";
}

function formatAgentOutputText(output: string | undefined, state: AgentMonitorModel["state"]): string {
	if (output !== undefined) return truncate(output, MAX_TOOL_TEXT);
	if (state === "running") return "Agent is still running. The parsed answer will appear here when it finishes.";
	return "No parsed answer was recorded. Check Diagnostics and the artifact path below if you need the raw stdout/stderr.";
}

function formatPromptText(
	promptSource: string | undefined,
	promptFromEvent: string | undefined,
	promptTruncated: boolean | undefined,
	promptAvailable: boolean | undefined,
): string {
	if (promptSource)
		return `${truncate(promptSource)}${promptFromEvent && promptTruncated ? "\n\n...[prompt copy truncated in events]" : ""}`;
	return promptAvailable
		? "Prompt artifact exists, but the prompt section could not be parsed."
		: "Prompt not available for this run/agent.";
}

function isPromptSourceTruncated(
	promptSource: string | undefined,
	promptFromEvent: string | undefined,
	promptTruncated: boolean | undefined,
): boolean {
	return !!promptSource && (promptSource.length > MAX_TOOL_TEXT || !!(promptFromEvent && promptTruncated));
}

function formatPromptMetadataRows(
	agent: AgentMonitorModel,
	agentRef: string,
	stateIcon: string,
	promptSourceLabel: string,
	promptSource: string | undefined,
	promptWasTruncated: boolean,
	artifactPath: string | undefined,
): SettingRow[] {
	return [
		["Agent", `${agentRef} ${agent.name}`],
		["State", `${stateIcon} ${agent.state}`],
		["Source", promptSourceLabel],
		["Characters", promptSource ? `${promptSource.length} source` : "n/a"],
		["Truncated", promptWasTruncated ? "yes" : "no"],
		["Artifact", artifactPath ?? "unavailable"],
	];
}

function formatAgentConfigRows(agent: AgentMonitorModel): SettingRow[] {
	// Full structured configuration: EVERY resolved runtime knob for this agent, always
	// rendered (never conditional on the artifact), as a Markdown table so the Enter
	// detail view is scannable/navigable. "default" means the option was not set and the
	// subagent inherited the orchestrator/session value.
	return [
		["Model", agent.model ?? "default (inherited from orchestrator)"],
		["Effort / thinking", agent.thinking ?? "default (inherited session level)"],
		["Tools", agent.tools?.length ? agent.tools.join(", ") : "default (full toolset)"],
		["Excluded tools", agent.excludeTools?.length ? agent.excludeTools.join(", ") : "none"],
		[
			"Skills",
			agent.skills?.length
				? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}`
				: agent.includeSkills === false
					? "disabled"
					: "default discovery",
		],
		[
			"Extensions",
			agent.extensions?.length
				? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}`
				: agent.includeExtensions
					? "default discovery"
					: "disabled",
		],
		[
			"Env keys",
			agent.keys?.length
				? `${agent.keys.join(", ")} (values redacted)`
				: agent.isolatedEnv
					? "none selected"
					: "default inherited environment",
		],
		...(agent.missingKeys?.length ? [["Missing keys", `⚠ ${agent.missingKeys.join(", ")}`] as SettingRow] : []),
		[
			"Environment",
			agent.isolatedEnv === undefined
				? "unknown"
				: agent.isolatedEnv
					? "isolated + selected keys"
					: "process default/inherited",
		],
		...(agent.schemaOk !== undefined
			? [["Structured schema", agent.schemaOk ? "ok" : "❌ validation failed"] as SettingRow]
			: []),
	];
}

function formatAgentSummaryLines({
	run,
	agent,
	agentRef,
	stateIcon,
	phase,
	artifactPath,
	artifactError,
}: AgentSummaryFormatInput): string[] {
	return [
		`- Agent: ${agentRef} ${agent.name}`,
		`- State: ${stateIcon} ${agent.state}`,
		`- Model: ${agent.model ?? "default"} • effort: ${agent.thinking ?? "default"}`,
		...(phase ? [`- Phase: ${phase}${agent.phaseLabel ? ` (${agent.phaseLabel})` : ""}`] : []),
		`- Workflow: ${run.workflow}`,
		`- Run: ${run.runId}`,
		...(agent.startedAt ? [`- Started: ${agent.startedAt}`] : []),
		...(agent.endedAt ? [`- Ended: ${agent.endedAt}`] : []),
		...(agent.elapsedMs !== undefined ? [`- Elapsed: ${formatElapsedMs(agent.elapsedMs)}`] : []),
		...(agent.ok !== undefined ? [`- OK: ${agent.ok}`] : []),
		...(agent.code !== undefined ? [`- Exit code: ${agent.code}`] : []),
		...(agent.killed !== undefined ? [`- Killed: ${agent.killed}`] : []),
		...(agent.schemaOk !== undefined ? [`- Schema OK: ${agent.schemaOk}`] : []),
		`- Artifact: ${artifactPath ?? "unavailable"}`,
		...(artifactError ? [`- Artifact read error: ${artifactError}`] : []),
	];
}

async function readLiveStreamIfSectionMissing(
	streamPath: string | undefined,
	artifactSection: string | undefined,
): Promise<string> {
	if (!streamPath || artifactSection) return "";
	return fs.readFile(streamPath, "utf8").catch(() => "");
}

function formatStdoutNote(
	stdoutForParsing: string,
	parsedStdout: ParsedPiStdout | undefined,
	artifactStdout: string | undefined,
): string | undefined {
	if (!stdoutForParsing) return undefined;
	const source = artifactStdout ? "Raw" : "Live";
	if (parsedStdout?.ok)
		return `${source} stdout is a Pi JSON event stream; parsed assistant output is shown above and raw stdout is omitted.`;
	return `${source} stdout could not be parsed as Pi JSON (${parsedStdout?.warning ?? "unknown reason"}); see the artifact/live stream path if you need the raw stream.`;
}

function formatAgentOutputLines({
	outputText,
	structuredOutput,
	stdoutNote,
	liveStdoutPath,
	liveStderrPath,
	stderr,
	liveStderr,
}: AgentOutputLinesInput): string[] {
	return [
		"## Agent answer",
		"",
		"Best available agent text. Raw Pi JSON stdout is hidden when it parses cleanly; otherwise see Diagnostics/artifact.",
		"",
		outputText,
		...(structuredOutput
			? ["", "## Structured output", "", fencedBlock(truncate(structuredOutput, MAX_TOOL_TEXT), "text")]
			: []),
		"",
		"## Diagnostics",
		"",
		...(stdoutNote ? [`- stdout: ${stdoutNote}`] : ["- stdout: not recorded yet."]),
		...(liveStdoutPath ? [`- live stdout: ${liveStdoutPath}`] : []),
		...(liveStderrPath ? [`- live stderr: ${liveStderrPath}`] : []),
		...(stderr || liveStderr
			? ["", "### stderr", "", fencedBlock(truncate(stderr || liveStderr, 6000), "text")]
			: []),
	];
}

function formatAgentPromptLines({
	agentRef,
	agentName,
	promptTable,
	promptText,
	access,
}: AgentPromptLinesInput): string[] {
	return [
		`# Prompt: Agent ${agentRef}: ${agentName}`,
		"",
		"## Summary",
		"",
		promptTable,
		"",
		"## Prompt body",
		"",
		promptText,
		...(access ? ["", "## Runtime access", "", truncate(access, 6000)] : []),
	];
}

// The agent detail document split into the base sub-tab views (Card / Prompt / Output) plus
// the legacy single-document concatenation (`full`, used by print mode and non-TUI paths).
export interface AgentViewParts {
	card: string;
	prompt: string;
	output: string;
	full: string;
}

export async function buildAgentViewParts(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentViewParts> {
	const artifactPath = resolveAgentArtifactPath(run, agent);
	let artifactBody = "";
	let artifactError = "";
	if (artifactPath) {
		try {
			artifactBody = await fs.readFile(artifactPath, "utf8");
		} catch (err) {
			artifactError = err instanceof Error ? err.message : String(err);
		}
	}
	const access = artifactBody ? extractMarkdownSection(artifactBody, "Access") : undefined;
	const prompt = artifactBody ? extractMarkdownSection(artifactBody, "Prompt") : undefined;
	const stdout = artifactBody ? extractMarkdownSection(artifactBody, "Stdout") : undefined;
	const stderr = artifactBody ? extractMarkdownSection(artifactBody, "Stderr") : undefined;
	const structuredOutput = artifactBody ? extractMarkdownSection(artifactBody, "Structured Output") : undefined;
	const liveStdoutPath = resolveAgentLiveStreamPath(artifactPath, "stdout");
	const liveStderrPath = resolveAgentLiveStreamPath(artifactPath, "stderr");
	const liveStdout = await readLiveStreamIfSectionMissing(liveStdoutPath, stdout);
	const liveStderr = await readLiveStreamIfSectionMissing(liveStderrPath, stderr);
	const stdoutForParsing = stdout || liveStdout;
	const parsedStdout = stdout
		? parsePiJsonModeOutput(stdout)
		: liveStdout
			? parsePiJsonModeOutputLenient(liveStdout)
			: undefined;
	const modelOutput = agent.output !== undefined ? agent.output : parsedStdout?.ok ? parsedStdout.output : undefined;
	const stdoutNote = formatStdoutNote(stdoutForParsing, parsedStdout, stdout);
	const promptFromEvent = agent.promptCopy || undefined;
	const promptSource = promptFromEvent ?? prompt;
	const promptText = formatPromptText(promptSource, promptFromEvent, agent.promptTruncated, agent.promptAvailable);
	const stateIcon = agentStateIcon(agent.state);
	const phase = formatAgentPhase(agent);
	const agentRef = formatAgentRef(agent, phase);
	const outputText = formatAgentOutputText(modelOutput, agent.state);
	const configRows = formatAgentConfigRows(agent);
	const configTable = formatSettingTable(configRows);
	const summary = formatAgentSummaryLines({ run, agent, agentRef, stateIcon, phase, artifactPath, artifactError });
	const titleLine = `# Agent ${agentRef}: ${agent.name}`;
	const cardLines = [
		titleLine,
		"",
		"## Summary",
		"",
		...summary,
		"",
		"## Configuration",
		"",
		"Resolved runtime configuration for this agent (model, effort, tools, skills, extensions, keys, env).",
		"",
		configTable,
	];
	const outputLines = formatAgentOutputLines({
		outputText,
		structuredOutput,
		stdoutNote,
		liveStdoutPath,
		liveStderrPath,
		stderr,
		liveStderr,
	});
	const promptSourceLabel = describePromptSource(promptFromEvent, prompt, agent.promptAvailable);
	const promptWasTruncated = isPromptSourceTruncated(promptSource, promptFromEvent, agent.promptTruncated);
	const promptRows = formatPromptMetadataRows(
		agent,
		agentRef,
		stateIcon,
		promptSourceLabel,
		promptSource,
		promptWasTruncated,
		artifactPath,
	);
	const promptTable = formatSettingTable(promptRows);
	const promptLines = formatAgentPromptLines({ agentRef, agentName: agent.name, promptTable, promptText, access });
	// `full` preserves the legacy single-document section order exactly: card, answer,
	// structured output, prompt, access, diagnostics.
	const diagnosticsIndex = outputLines.indexOf("## Diagnostics");
	const answerAndStructured = outputLines.slice(0, diagnosticsIndex - 1);
	const diagnostics = outputLines.slice(diagnosticsIndex);
	const full = [...cardLines, "", ...answerAndStructured, "", ...promptLines, "", ...diagnostics].join("\n");
	return {
		card: cardLines.join("\n"),
		prompt: promptLines.join("\n"),
		output: outputLines.join("\n"),
		full,
	};
}

async function formatAgentView(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<string> {
	return (await buildAgentViewParts(run, agent)).full;
}

// La pestaña Definition: la fuente del flujo de trabajo que ejecutó esta ejecución, como un bloque de código cercado,
// con una advertencia de caché de reanudación cuando el archivo cambió desde la ejecución (igual verificación de hash que
// hace la vista de ejecución).
async function formatWorkflowDefinition(run: WorkflowRunRecord): Promise<string> {
	const header = [`# Workflow definition: ${run.workflow}`, "", `File: ${run.file ?? "unknown"}`];
	if (!run.file) return [...header, "", "No workflow file was recorded for this run."].join("\n");
	let code: string;
	try {
		code = await fs.readFile(run.file, "utf8");
	} catch (err) {
		return [...header, "", `Cannot read workflow file: ${err instanceof Error ? err.message : String(err)}`].join(
			"\n",
		);
	}
	const codeChanged = run.codeHash !== undefined && computeCodeHash(code) !== run.codeHash;
	return [
		...header,
		...(codeChanged
			? [
					"",
					"⚠ Warning: this file changed since the run started. On resume, calls whose arguments changed will re-execute (cache miss); unchanged calls stay cached.",
				]
			: []),
		"",
		fencedBlock(truncate(code, 60_000), "js"),
	].join("\n");
}

// La pestaña Graph: una representación Markdown/texto del mismo gráfico de flujo de trabajo estático
// usado por /workflow graph. Mantenlo como text+Mermaid dentro del visor Markdown con pestañas;
// la acción de gráfico independiente posee el componente más rico capaz de PNG.
async function formatWorkflowGraphView(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<string> {
	const header = [`# Workflow graph: ${run.workflow}`, "", `Run: ${run.runId}`];
	const { resolveWorkflowForRun } = await import("./workflow-resolve.js");
	const workflow = await resolveWorkflowForRun(ctx, run);
	if (!workflow) return [...header, "", "Cannot open graph: workflow file not found."].join("\n");
	let code: string;
	try {
		code = await fs.readFile(workflow.path, "utf8");
	} catch (err) {
		return [...header, "", `Cannot read workflow file: ${err instanceof Error ? err.message : String(err)}`].join(
			"\n",
		);
	}
	const codeChanged = run.codeHash !== undefined && computeCodeHash(code) !== run.codeHash;
	const { makeWorkflowGraphForContext } = await import("./workflow-graph.js");
	return [
		...header,
		`File: ${workflow.path}`,
		...(codeChanged
			? ["", "⚠ Warning: this file changed since the run started, so the graph reflects the current workflow file."]
			: []),
		"",
		await makeWorkflowGraphForContext(ctx, workflow, code),
	].join("\n");
}

const TERMINAL_AGENT_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cached"]);

function isTerminalAgentState(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_AGENT_STATES.has(state);
}

// Header status label for the live agent viewer: keep advertising the 1s poll
// only while the agent can still change; show a stable "final" marker once it
// reaches a terminal state (and the poll is stopped).
export function liveAgentHeaderStatus(state: string | undefined): string {
	return isTerminalAgentState(state) ? `final (${state})` : "refresh 1s";
}

async function latestAgentForRun(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentMonitorModel> {
	const { agents } = await readRunEvents(run.runDir);
	return agents.find((candidate) => candidate.id === agent.id) ?? agent;
}

export async function showLiveAgentView(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
	agent: AgentMonitorModel,
): Promise<void> {
	if (ctx.mode === "print") {
		console.log(await formatAgentView(run, await latestAgentForRun(run, agent)));
		return;
	}
	if (ctx.mode === "tui") {
		// bucle open→action→reopen: `f` deja al usuario abrir uno de los artefactos de la ejecución en
		// el visor correcto (.md → Markdown, de lo contrario texto), luego regresa a la vista de agente en vivo —
		// la misma capacidad que tiene la vista de ejecución, para que la pantalla del agente "encaje" con ella.
		// La pantalla de detalle es un visor SUB-TABULADO (Card / Prompt / Graph / Output / Definition / Run)
		// para que el usuario pueda moverse entre la tarjeta del agente, su prompt, el gráfico del flujo de trabajo, su salida,
		// la fuente del flujo de trabajo, y la vista de ejecución completa sin rebotar al panel.
		let definitionCache: string | undefined; // estático por ejecución: carga una vez, reutiliza entre pestañas/actualizaciones
		let graphCache: string | undefined; // estático por ejecución: carga una vez, reutiliza entre pestañas/actualizaciones
		for (;;) {
			let timer: NodeJS.Timeout | undefined;
			let refreshing = false;
			let component: AgentLiveViewComponent | undefined;
			let intent: "openFiles" | undefined;
			try {
				intent = await ctx.ui.custom<"openFiles" | undefined>((tui, theme, _keybindings, done) => {
					let pending = false;
					const refresh = async () => {
						if (!component) return;
						if (refreshing) {
							// Un cambio de pestaña durante una actualización en vuelo no debe ser descartado: el
							// nuevo tab estaría en "Cargando…" por siempre una vez que la encuesta de estado terminal se detiene.
							pending = true;
							return;
						}
						refreshing = true;
						try {
							const latest = await latestAgentForRun(run, agent);
							component.setState(latest.state);
							const active = component.getActiveTab();
							if (active === "card" || active === "prompt" || active === "output") {
								// Una lectura de artefacto produce las tres secciones del agente; rellénlas juntas.
								const parts = await buildAgentViewParts(run, latest);
								component.setTabContent("card", parts.card);
								component.setTabContent("prompt", parts.prompt);
								component.setTabContent("output", parts.output);
							} else if (active === "definition") {
								definitionCache ??= await formatWorkflowDefinition(run);
								component.setTabContent("definition", definitionCache);
							} else if (active === "run") {
								component.setTabContent("run", await formatRunView(run));
							} else if (active === "graph") {
								graphCache ??= await formatWorkflowGraphView(ctx, run);
								component.setTabContent("graph", graphCache);
							}
							tui.requestRender();
							// Detén el sondeo una vez que el agente es terminal; la salida final permanece
							// en pantalla hasta que el usuario cierre la vista. Los cambios de pestaña aún se actualizan
							// bajo demanda a través de onTabChange abajo.
							if (timer && isTerminalAgentState(latest.state)) {
								clearInterval(timer);
								timer = undefined;
							}
						} finally {
							refreshing = false;
							if (pending) {
								pending = false;
								void refresh();
							}
						}
					};
					component = new AgentLiveViewComponent(
						theme,
						() => tui.terminal.rows,
						done,
						() => tui.requestRender(),
						true,
						[
							{ key: "card", label: "Card" },
							{ key: "prompt", label: "Prompt" },
							{ key: "graph", label: "Graph" },
							{ key: "output", label: "Output" },
							{ key: "definition", label: "Definition" },
							{ key: "run", label: "Run" },
						],
						() => void refresh(), // load the newly-focused tab immediately
					);
					timer = setInterval(() => void refresh(), 1000);
					void refresh();
					return component;
				});
			} finally {
				if (timer) clearInterval(timer);
			}
			if (intent !== "openFiles") return;
			await pickAndOpenRunArtifact(ctx, run);
		}
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(
			`Workflow agent: ${agent.name}`,
			await formatAgentView(run, await latestAgentForRun(run, agent)),
		);
		return;
	}
	notify(ctx, await formatAgentView(run, await latestAgentForRun(run, agent)), "info");
}
