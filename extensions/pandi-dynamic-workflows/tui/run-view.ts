/**
 * Run-view TUI para pandi-dynamic-workflows.
 *
 * Lista archivos de un run y renderiza la full Markdown run view (status, agents,
 * timeline, artifacts, output). Listado/resolución de runs vive en runtime/runs.ts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_TEXT, stringify } from "../lib/format.js";
import { pickViewerForPath, showMarkdown } from "../lib/markdown-view.js";
import { notify } from "../lib/notify.js";
import { compactInline, formatElapsedMs } from "../lib/presentation.js";
import { formatAgentPhase, readRunEvents } from "../observe/index.js";
import {
	computeCodeHash,
	formatParallelAgents,
	getRunCachedCalls,
	getRunLogs,
	getRunState,
	getRunStatusLabel,
	isResumableState,
	isRunResult,
} from "../runtime/index.js";
import type { WorkflowRunRecord } from "../types.js";
import { showText } from "./status-ui.js";

export async function listRunFiles(runDir: string, maxFiles = 80): Promise<{ files: string[]; omitted: number }> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(path.relative(runDir, full).replaceAll(path.sep, "/"));
		}
	}
	await walk(runDir);
	return { files: out.slice(0, maxFiles), omitted: Math.max(0, out.length - maxFiles) };
}

export async function formatRunView(run: WorkflowRunRecord): Promise<string> {
	const { files, omitted } = await listRunFiles(run.runDir);
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
	const integrity = "integrity" in run ? run.integrity : undefined;
	const integrityLine = integrity
		? `Integrity: failed:${integrity.failedAgents} empty-output:${integrity.emptyOutputAgents} output:truncated:${integrity.outputTruncatedAgents} stdout:truncated:${integrity.stdoutTruncatedAgents} timedOut:${integrity.timedOutAgents} schemaFailed:${integrity.schemaFailedAgents}`
		: undefined;
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
		const integrityChips = [
			agent.outputEmpty ? " output:empty" : "",
			agent.outputTruncated ? " output:truncated" : "",
			agent.stdoutTruncated ? " stdout:truncated" : "",
		]
			.filter(Boolean)
			.join("");
		const preview = agent.promptPreview ? ` — prompt preview: ${compactInline(agent.promptPreview, 180)}` : "";
		return `- #${agent.id}${phase ? ` ${phase}` : ""} ${agent.name} — ${agent.state} ${elapsed}${code}${schema}${integrityChips}${prompt}${tools}${skills}${extensions}${keys}${agent.artifactPath ? ` — ${agent.artifactPath}` : ""}${preview}`;
	});

	// Detecta si el workflow source cambió desde este run (best-effort:
	// lee el recorded file path y compara hashes).
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
		...(integrityLine ? [integrityLine] : []),
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
		...(omitted > 0 ? [`${omitted} more files not listed.`] : []),
		...(isRunResult(run) && run.output !== undefined
			? ["", "## Output", "", stringify(run.output, MAX_TOOL_TEXT)]
			: state === "running"
				? ["", "## Output", "", "Output not available until completion."]
				: []),
	].join("\n");
}

// Abre un single run artifact en el viewer que le cabe: `.md`/`.markdown` se renderizan
// como rich Markdown, todo lo demás como text. El path se contiene dentro de runDir
// así un crafted relative path no puede leer arbitrary files off disk.
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

// Deja que el usuario elija uno de los artifacts de un run y lo abra en el viewer que le
// cabe. Compartido por el run view y el live agent view así la affordance `f` se comporta
// idénticamente en ambos.
export async function pickAndOpenRunArtifact(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<void> {
	const { files } = await listRunFiles(run.runDir);
	if (files.length === 0) {
		notify(ctx, "No artifacts found for this run.", "info");
		return;
	}
	const choice = await ctx.ui.select(`Open run artifact (${files.length})`, files);
	if (choice) await openRunArtifact(ctx, run.runDir, choice);
}

// La SCREEN run-view: renderiza el run como rich Markdown y, en un TUI, deja que el
// usuario presione `f` para abrir uno de sus artifacts (el archivo elegido va al Markdown
// o text viewer), luego retorna a la run view — el mismo open→action→reopen loop
// que usa el dashboard.
export async function showRunView(ctx: ExtensionContext, run: WorkflowRunRecord): Promise<void> {
	for (;;) {
		const canOpenFiles = ctx.mode === "tui" && ctx.hasUI;
		const intent = await showMarkdown(ctx, `Workflow run: ${run.runId}`, await formatRunView(run), { canOpenFiles });
		if (intent !== "openFiles") return;
		await pickAndOpenRunArtifact(ctx, run);
	}
}
