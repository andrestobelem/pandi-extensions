/**
 * Agent view markdown formatting — pure helpers and async builders that assemble the
 * Card / Prompt / Output sub-tab documents from run records, agent models, and artifacts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePiJsonModeOutput, parsePiJsonModeOutputLenient } from "./agent-output.js";
import { MAX_TOOL_TEXT, truncate } from "./format.js";
import { formatAgentPhase } from "./observe/index.js";
import { formatElapsedMs } from "./presentation.js";
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

type AgentArtifactSections = {
	access: string | undefined;
	prompt: string | undefined;
	stdout: string | undefined;
	stderr: string | undefined;
	structuredOutput: string | undefined;
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

export function fencedBlock(content: string, lang = "text"): string {
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

export async function formatAgentView(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<string> {
	return (await buildAgentViewParts(run, agent)).full;
}
