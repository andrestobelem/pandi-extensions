/**
 * Run-list / run-view kernel for pi-dynamic-workflows.
 *
 * Lists workflow runs, formats the run picker, resolves a run by id/alias, lists a
 * run's files, and renders the full Markdown run view (status, agents, timeline,
 * artifacts, output). selectRunByKey is the generic id/alias selector reused by the
 * dashboard. All 6 are consumed by index.ts (and selectRunByKey by a test).
 *
 * Deferred cycles: pulls run metadata/derivations from the run-store/run-state/
 * event-parser/journal/format/presentation siblings, and compactInline from
 * ./index.js (read only inside formatRunView's body); WorkflowRunRecord/
 * AgentMonitorModel cross as import type (erased). index.ts imports all 6 back and
 * re-exports selectRunByKey for the composition test. Extracted byte-identically.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatAgentPhase, readRunEvents } from "./event-parser.js";
import { MAX_TOOL_TEXT, stringify } from "./format.js";
import type { WorkflowRunRecord } from "./index.js";
import { computeCodeHash } from "./journal.js";
import { pickViewerForPath, showMarkdown } from "./markdown-view.js";
import { notify } from "./notify.js";
import { compactInline, formatElapsedMs } from "./presentation.js";
import {
	formatParallelAgents,
	formatParallelAgentsCompact,
	getRunCachedCalls,
	getRunLogs,
	getRunState,
	getRunStatusIcon,
	getRunStatusLabel,
	isResumableState,
	isRunResult,
} from "./run-state.js";
import { showText } from "./run-status-ui.js";
import { getRunDirs, readRunRecord } from "./run-store.js";

export async function listRuns(ctx: ExtensionContext): Promise<WorkflowRunRecord[]> {
	const runs: WorkflowRunRecord[] = [];
	for (const runDir of await getRunDirs(ctx)) {
		const record = await readRunRecord(runDir);
		if (record) runs.push(record);
	}
	return runs;
}

export function formatRunList(runs: WorkflowRunRecord[]): string {
	if (runs.length === 0) return "No workflow runs found.";
	return runs
		.slice(0, 50)
		.map((run) => {
			const bg = run.background ? " bg" : "";
			const state = getRunState(run);
			const active = state === "running" ? " active" : "";
			const resumable = isResumableState(state) ? " resumable" : "";
			const cached = getRunCachedCalls(run) > 0 ? ` cached:${getRunCachedCalls(run)}` : "";
			const parallelCompact = formatParallelAgentsCompact(run);
			const parallel = parallelCompact === "-" ? "" : ` parallel:${parallelCompact}`;
			return `${getRunStatusIcon(run)} ${run.runId} — ${run.workflow}${bg} — ${getRunStatusLabel(run)}${active}${resumable} — ${Math.round(run.elapsedMs / 1000)}s — agents ${run.agentCount}${parallel}${cached}`;
		})
		.join("\n");
}

// Resolve a run by key with EXACT id match taking priority over substring/alias matches, so a
// short exact id can never be shadowed by a different run whose id merely contains the key
// (which would otherwise cancel or delete the wrong run).
export function selectRunByKey<T>(
	items: T[],
	key: string,
	idOf: (item: T) => string,
	aliasOf?: (item: T) => string | undefined,
): T | undefined {
	return (
		items.find((item) => idOf(item) === key) ??
		items.find((item) => idOf(item).includes(key) || aliasOf?.(item) === key)
	);
}

export async function resolveRun(ctx: ExtensionContext, id: string | undefined): Promise<WorkflowRunRecord> {
	const runs = await listRuns(ctx);
	if (runs.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return runs[0];
	const found = selectRunByKey(
		runs,
		key,
		(run) => run.runId,
		(run) => run.workflow,
	);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

export async function listRunFiles(runDir: string, maxFiles = 80): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (out.length >= maxFiles) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(path.relative(runDir, full).replaceAll(path.sep, "/"));
		}
	}
	await walk(runDir);
	return out;
}

export async function formatRunView(run: WorkflowRunRecord): Promise<string> {
	const files = await listRunFiles(run.runDir);
	const parsedEvents = await readRunEvents(run.runDir);
	const started = new Date(run.startedAt).getTime();
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : parsedEvents.logs;
	const agents = parsedEvents.agents;
	const timeline = logs.map((entry) => {
		const elapsed = Math.max(0, new Date(entry.time).getTime() - started);
		const seconds = (elapsed / 1000).toFixed(1).padStart(5, " ");
		return `+${seconds}s ${entry.message}${entry.details === undefined ? "" : ` — ${stringify(entry.details, 500)}`}`;
	});
	const state = getRunState(run);
	const statusEmoji =
		state === "completed"
			? "✅"
			: state === "running"
				? "▶️"
				: state === "cancelled"
					? "🟨"
					: state === "stale"
						? "⚠️"
						: "❌";
	const cachedCalls = getRunCachedCalls(run);
	const resumable = isResumableState(state);
	const agentLines = agents.map((agent) => {
		const elapsed = agent.elapsedMs === undefined ? "elapsed:?" : `elapsed:${formatElapsedMs(agent.elapsedMs)}`;
		const phase = formatAgentPhase(agent);
		const code = agent.code === undefined ? "" : ` code:${agent.code}`;
		const schema = agent.schemaOk === undefined ? "" : ` schema:${agent.schemaOk ? "ok" : "bad"}`;
		const prompt = agent.promptAvailable ? " prompt:yes" : " prompt:no";
		const tools = ` tools:${agent.tools?.length ? agent.tools.join(",") : "default"}`;
		const skills = ` skills:${agent.skills?.length ? agent.skills.join(",") : agent.includeSkills === false ? "disabled" : "default"}`;
		const extensions = ` extensions:${agent.extensions?.length ? agent.extensions.join(",") : agent.includeExtensions ? "default" : "disabled"}`;
		const keys = ` keys:${agent.keys?.length ? agent.keys.join(",") : agent.isolatedEnv ? "none" : "default"}${agent.missingKeys?.length ? ` missing:${agent.missingKeys.join(",")}` : ""}`;
		const preview = agent.promptPreview ? ` — prompt preview: ${compactInline(agent.promptPreview, 180)}` : "";
		return `- #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name} — ${agent.state} ${elapsed}${code}${schema}${prompt}${tools}${skills}${extensions}${keys}${agent.artifactPath ? ` — ${agent.artifactPath}` : ""}${preview}`;
	});

	// Detect whether the workflow source changed since this run (best-effort:
	// reads the recorded file path and compares hashes).
	let codeChanged = false;
	if (run.codeHash && run.file) {
		try {
			const currentCode = await fs.readFile(run.file, "utf8");
			codeChanged = computeCodeHash(currentCode) !== run.codeHash;
		} catch {
			codeChanged = false;
		}
	}

	return [
		`# Workflow run: ${run.workflow}`,
		"",
		`Status: ${statusEmoji} ${getRunStatusLabel(run)}`,
		`Run: ${run.runId}`,
		`Background: ${run.background ? "yes" : "no"}`,
		`Elapsed: ${Math.round(run.elapsedMs / 1000)}s`,
		`Agents: ${run.agentCount}`,
		`Parallel agents: ${formatParallelAgents(run, agents)}`,
		...(run.maxAgents === undefined ? [] : [`Max agents: ${run.maxAgents}`]),
		...(cachedCalls > 0 ? [`Cached calls: ${cachedCalls}`] : []),
		...(run.resumedFrom ? [`Resumed from: ${run.resumedFrom}`] : []),
		...(run.codeHash ? [`Code hash: ${run.codeHash.slice(0, 16)}`] : []),
		`Directory: ${run.runDir}`,
		...(state === "running" ? [`Cancel: /workflow cancel ${run.runId}`] : []),
		...(resumable ? [`Resume: /workflow resume ${run.runId}`] : []),
		...(state === "stale" ? ["Note: this run was marked running on disk but is not active in this Pi session."] : []),
		...(codeChanged
			? [
					"Warning: workflow code changed since this run. On resume, calls whose arguments changed will be re-executed (cache miss); unchanged calls stay cached.",
				]
			: []),
		...(run.error ? [`Error: ${run.error}`] : []),
		"",
		"## Agents",
		"",
		...(agentLines.length ? agentLines : ["No agents recorded for this run."]),
		"",
		"## Timeline",
		"",
		...(timeline.length ? timeline : ["No logs recorded."]),
		"",
		"## Files / artifacts",
		"",
		...(files.length ? files.map((file) => `- ${file}`) : ["No files found."]),
		...(isRunResult(run) && run.output !== undefined
			? ["", "## Output", "", stringify(run.output, MAX_TOOL_TEXT)]
			: state === "running"
				? ["", "## Output", "", "Output not available until completion."]
				: []),
	].join("\n");
}

// Open a single run artifact in the viewer that fits it: `.md`/`.markdown` render as rich
// Markdown, everything else as text. The path is contained within runDir so a crafted
// relative path cannot read arbitrary files off disk.
export async function openRunArtifact(ctx: ExtensionContext, runDir: string, relPath: string): Promise<void> {
	const resolved = path.resolve(runDir, relPath);
	const base = path.resolve(runDir);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) {
		notify(ctx, `Artifact path escapes the run directory: ${relPath}`, "warning");
		return;
	}
	let content: string;
	try {
		content = await fs.readFile(resolved, "utf8");
	} catch (err) {
		notify(ctx, `Cannot read artifact ${relPath}: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return;
	}
	if (pickViewerForPath(relPath) === "markdown") await showMarkdown(ctx, relPath, content);
	else await showText(ctx, relPath, content);
}

// Let the user pick one of a run's artifacts and open it in the viewer that fits it. Shared
// by the run view and the live agent view so the `f` affordance behaves identically in both.
export async function pickAndOpenRunArtifact(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<void> {
	const files = await listRunFiles(run.runDir);
	if (files.length === 0) {
		notify(ctx, "No artifacts found for this run.", "info");
		return;
	}
	const choice = await ctx.ui.select(`Open run artifact (${files.length})`, files);
	if (choice) await openRunArtifact(ctx, run.runDir, choice);
}

// The run-view SCREEN: render the run as rich Markdown and, in a TUI, let the user press
// `f` to open one of its artifacts (the chosen file routes to the Markdown or text viewer),
// then return to the run view — the same open→action→reopen loop the dashboard uses.
export async function showRunView(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<void> {
	for (;;) {
		const canOpenFiles = ctx.mode === "tui" && ctx.hasUI;
		const intent = await showMarkdown(ctx, `Workflow run: ${run.runId}`, await formatRunView(run), { canOpenFiles });
		if (intent !== "openFiles") return;
		await pickAndOpenRunArtifact(ctx, run);
	}
}
