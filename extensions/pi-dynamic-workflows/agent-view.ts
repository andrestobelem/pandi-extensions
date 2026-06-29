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
import type { AgentMonitorModel, WorkflowRunRecord } from "./index.js";
import { notify } from "./notify.js";
import { formatElapsedMs } from "./presentation.js";

export function resolveAgentArtifactPath(run: WorkflowRunRecord, agent: AgentMonitorModel): string | undefined {
	if (!agent.artifactPath) return undefined;
	// artifactPath originates from untrusted events.jsonl; contain it within runDir
	// so a crafted absolute path or "../" traversal cannot read arbitrary files.
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

async function formatAgentView(run: WorkflowRunRecord, agent: AgentMonitorModel): Promise<string> {
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
	let liveStdout = "";
	let liveStderr = "";
	if (liveStdoutPath && !stdout) liveStdout = await fs.readFile(liveStdoutPath, "utf8").catch(() => "");
	if (liveStderrPath && !stderr) liveStderr = await fs.readFile(liveStderrPath, "utf8").catch(() => "");
	const stdoutForParsing = stdout || liveStdout;
	const parsedStdout = stdout
		? parsePiJsonModeOutput(stdout)
		: liveStdout
			? parsePiJsonModeOutputLenient(liveStdout)
			: undefined;
	const modelOutput = agent.output || (parsedStdout?.ok ? parsedStdout.output : undefined);
	const stdoutNote = stdoutForParsing
		? parsedStdout?.ok
			? `${stdout ? "Raw" : "Live"} stdout is a Pi JSON event stream; parsed assistant output is shown above and raw stdout is omitted.`
			: `${stdout ? "Raw" : "Live"} stdout could not be parsed as Pi JSON (${parsedStdout?.warning ?? "unknown reason"}); see the artifact/live stream path if you need the raw stream.`
		: undefined;
	const promptText = prompt
		? truncate(prompt, 12_000)
		: agent.promptAvailable
			? "Prompt artifact exists, but the prompt section could not be parsed."
			: "Prompt not available for this run/agent.";
	const stateIcon =
		agent.state === "completed"
			? "✅"
			: agent.state === "running"
				? "▶️"
				: agent.state === "cached"
					? "♻️"
					: agent.state === "failed"
						? "❌"
						: "?";
	const phase = formatAgentPhase(agent);
	const outputText = modelOutput
		? truncate(modelOutput, MAX_TOOL_TEXT)
		: agent.state === "running"
			? "Agent is still running. The parsed answer will appear here when it finishes."
			: "No parsed answer was recorded. Check Diagnostics and the artifact path below if you need the raw stdout/stderr.";
	const accessFallback = [
		`- tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}`,
		`- excludeTools: ${agent.excludeTools?.length ? agent.excludeTools.join(", ") : "none"}`,
		`- skills: ${agent.skills?.length ? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}` : agent.includeSkills === false ? "disabled" : "default discovery"}`,
		`- extensions: ${agent.extensions?.length ? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}` : agent.includeExtensions ? "default discovery" : "disabled"}`,
		`- keys: ${agent.keys?.length ? `${agent.keys.join(", ")} (values redacted)` : agent.isolatedEnv ? "none selected" : "default inherited environment"}`,
		...(agent.missingKeys?.length ? [`- missingKeys: ${agent.missingKeys.join(", ")}`] : []),
		...(agent.isolatedEnv === undefined
			? []
			: [`- env: ${agent.isolatedEnv ? "isolated + selected keys" : "process default/inherited"}`]),
	].join("\n");
	const summary = [
		`- Agent: #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name}`,
		`- State: ${stateIcon} ${agent.state}`,
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
	return [
		`# Agent #${agent.id}${phase ? ` ${phase}` : ""}: ${agent.name}`,
		"",
		"## Summary",
		"",
		...summary,
		"",
		"## Agent answer",
		"",
		"Best available agent text. Raw Pi JSON stdout is hidden when it parses cleanly; otherwise see Diagnostics/artifact.",
		"",
		outputText,
		...(structuredOutput
			? ["", "## Structured output", "", fencedBlock(truncate(structuredOutput, MAX_TOOL_TEXT), "text")]
			: []),
		"",
		"## Prompt sent to this agent",
		"",
		prompt ? fencedBlock(promptText, "text") : promptText,
		"",
		"## Runtime access",
		"",
		access ? truncate(access, 6000) : accessFallback,
		"",
		"## Diagnostics",
		"",
		...(stdoutNote ? [`- stdout: ${stdoutNote}`] : ["- stdout: not recorded yet."]),
		...(liveStdoutPath ? [`- live stdout: ${liveStdoutPath}`] : []),
		...(liveStderrPath ? [`- live stderr: ${liveStderrPath}`] : []),
		...(stderr || liveStderr
			? ["", "### stderr", "", fencedBlock(truncate(stderr || liveStderr, 6000), "text")]
			: []),
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
		let timer: NodeJS.Timeout | undefined;
		let refreshing = false;
		let component: AgentLiveViewComponent | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				component = new AgentLiveViewComponent(
					theme,
					() => tui.terminal.rows,
					() => done(undefined),
					() => tui.requestRender(),
				);
				const refresh = async () => {
					if (refreshing || !component) return;
					refreshing = true;
					try {
						const latest = await latestAgentForRun(run, agent);
						component.setContent(await formatAgentView(run, latest), latest.state);
						tui.requestRender();
						// Stop polling once the agent is terminal; the final output stays
						// on screen until the user closes the view.
						if (timer && isTerminalAgentState(latest.state)) {
							clearInterval(timer);
							timer = undefined;
						}
					} finally {
						refreshing = false;
					}
				};
				timer = setInterval(() => void refresh(), 1000);
				void refresh();
				return component;
			});
		} finally {
			if (timer) clearInterval(timer);
		}
		return;
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
