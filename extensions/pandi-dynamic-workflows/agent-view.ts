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
import { computeCodeHash } from "./journal.js";
import { notify } from "./notify.js";
import { formatElapsedMs } from "./presentation.js";
import { formatRunView, pickAndOpenRunArtifact } from "./run-view.js";

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
	const promptFromEvent = agent.promptCopy || undefined;
	const promptSource = promptFromEvent ?? prompt;
	const promptText = promptSource
		? `${truncate(promptSource)}${promptFromEvent && agent.promptTruncated ? "\n\n...[prompt copy truncated in events]" : ""}`
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
	// Full structured configuration: EVERY resolved runtime knob for this agent, always
	// rendered (never conditional on the artifact), as a Markdown table so the Enter
	// detail view is scannable/navigable. "default" means the option was not set and the
	// subagent inherited the orchestrator/session value.
	const configRows: [string, string][] = [
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
		...(agent.missingKeys?.length ? [["Missing keys", `⚠ ${agent.missingKeys.join(", ")}`] as [string, string]] : []),
		[
			"Environment",
			agent.isolatedEnv === undefined
				? "unknown"
				: agent.isolatedEnv
					? "isolated + selected keys"
					: "process default/inherited",
		],
		...(agent.schemaOk !== undefined
			? [["Structured schema", agent.schemaOk ? "ok" : "❌ validation failed"] as [string, string]]
			: []),
	];
	const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const configTable = [
		"| Setting | Value |",
		"| --- | --- |",
		...configRows.map(([key, value]) => `| ${escapeCell(key)} | ${escapeCell(value)} |`),
	].join("\n");
	const summary = [
		`- Agent: #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name}`,
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
	const titleLine = `# Agent #${agent.id}${phase ? ` ${phase}` : ""}: ${agent.name}`;
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
	const outputLines = [
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
	const promptLines = [
		"## Prompt sent to this agent",
		"",
		promptText,
		...(access ? ["", "## Runtime access (recorded in artifact)", "", truncate(access, 6000)] : []),
	];
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

// The Definition sub-tab: the workflow source this run executed, as a fenced code block,
// with a resume-cache warning when the file changed since the run (same hash check the
// run view does).
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

// The Graph sub-tab: a Markdown/text rendering of the same static workflow graph
// used by /workflow graph. Keep it as text+Mermaid inside the tabbed Markdown
// viewer; the standalone graph action owns the richer PNG-capable component.
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
		// open→action→reopen loop: `f` lets the user open one of the run's artifacts in the
		// right viewer (.md → Markdown, else text), then returns to the live agent view — the
		// same affordance the run view has, so the agent screen "fits together" with it.
		// The detail screen is a SUB-TABBED viewer (Card / Prompt / Output / Definition / Run / Graph)
		// so the user can move between the agent card, its prompt, its output, the workflow
		// source, the full run view, and the workflow graph without bouncing back to the dashboard.
		let definitionCache: string | undefined; // static per run: load once, reuse across tabs/refreshes
		let graphCache: string | undefined; // static per run: load once, reuse across tabs/refreshes
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
							// A tab switch during an in-flight refresh must not be dropped: the new
							// tab would stay on "Loading…" forever once the terminal-state poll stops.
							pending = true;
							return;
						}
						refreshing = true;
						try {
							const latest = await latestAgentForRun(run, agent);
							component.setState(latest.state);
							const active = component.getActiveTab();
							if (active === "card" || active === "prompt" || active === "output") {
								// One artifact read yields all three agent sections; fill them together.
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
							// Stop polling once the agent is terminal; the final output stays on
							// screen until the user closes the view. Tab switches still refresh
							// on demand via onTabChange below.
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
							{ key: "output", label: "Output" },
							{ key: "definition", label: "Definition" },
							{ key: "run", label: "Run" },
							{ key: "graph", label: "Graph" },
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
