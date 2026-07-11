/**
 * Builders de Card/Output y orquestación async de la vista de detalle de agente.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_TOOL_TEXT, truncate } from "../lib/format.js";
import { formatElapsedMs } from "../lib/presentation.js";
import { formatAgentPhase } from "../observe/index.js";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "../runtime/index.js";
import type { AgentMonitorModel, WorkflowRunRecord } from "../types.js";
import {
	extractMarkdownSection,
	fencedBlock,
	formatAgentPromptLines,
	formatSettingTable,
	resolvePromptPresentation,
} from "./agent-view-prompt.js";
import type {
	AgentArtifactSections,
	AgentOutputLinesInput,
	AgentSummaryFormatInput,
	AgentViewParts,
	ParsedPiStdout,
	SettingRow,
} from "./agent-view-types.js";

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

function formatAgentOutputText(output: string | undefined, state: AgentMonitorModel["state"]): string {
	if (output !== undefined) return truncate(output, MAX_TOOL_TEXT);
	if (state === "running") return "Agent is still running. The parsed answer will appear here when it finishes.";
	return "No parsed answer was recorded. Check Diagnostics and the artifact path below if you need the raw stdout/stderr.";
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

function parseBestAgentStdout(stdout: string | undefined, liveStdout: string): ParsedPiStdout | undefined {
	if (stdout) return parsePiJsonModeOutput(stdout);
	if (liveStdout) return parsePiJsonModeOutputLenient(liveStdout);
	return undefined;
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

async function readAgentArtifactBody(
	artifactPath: string | undefined,
): Promise<{ artifactBody: string; artifactError: string }> {
	if (!artifactPath) return { artifactBody: "", artifactError: "" };
	try {
		return { artifactBody: await fs.readFile(artifactPath, "utf8"), artifactError: "" };
	} catch (err) {
		return { artifactBody: "", artifactError: err instanceof Error ? err.message : String(err) };
	}
}

function extractAgentArtifactSections(artifactBody: string): AgentArtifactSections {
	return {
		access: artifactBody ? extractMarkdownSection(artifactBody, "Access") : undefined,
		prompt: artifactBody ? extractMarkdownSection(artifactBody, "Prompt") : undefined,
		stdout: artifactBody ? extractMarkdownSection(artifactBody, "Stdout") : undefined,
		stderr: artifactBody ? extractMarkdownSection(artifactBody, "Stderr") : undefined,
		structuredOutput: artifactBody ? extractMarkdownSection(artifactBody, "Structured Output") : undefined,
	};
}

export async function buildAgentViewParts(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<AgentViewParts> {
	const artifactPath = resolveAgentArtifactPath(run, agent);
	const { artifactBody, artifactError } = await readAgentArtifactBody(artifactPath);
	const { access, prompt, stdout, stderr, structuredOutput } = extractAgentArtifactSections(artifactBody);
	const liveStdoutPath = resolveAgentLiveStreamPath(artifactPath, "stdout");
	const liveStderrPath = resolveAgentLiveStreamPath(artifactPath, "stderr");
	const liveStdout = await readLiveStreamIfSectionMissing(liveStdoutPath, stdout);
	const liveStderr = await readLiveStreamIfSectionMissing(liveStderrPath, stderr);
	const stdoutForParsing = stdout || liveStdout;
	const parsedStdout = parseBestAgentStdout(stdout, liveStdout);
	const modelOutput = agent.output !== undefined ? agent.output : parsedStdout?.ok ? parsedStdout.output : undefined;
	const stdoutNote = formatStdoutNote(stdoutForParsing, parsedStdout, stdout);
	const promptFromEvent = agent.promptCopy || undefined;
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
	const { promptText, promptTable } = resolvePromptPresentation(
		agent,
		promptFromEvent,
		prompt,
		agentRef,
		stateIcon,
		artifactPath,
	);
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

export async function formatAgentView(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<string> {
	return (await buildAgentViewParts(run, agent)).full;
}
