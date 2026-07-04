/**
 * Run-dir → RunReportModel collector for the workflow run report (design record,
 * run bd039ef9). Assembles the pure builder's model from the persisted run files,
 * applying the bounding + degradation contract:
 *
 * - Structured-event-first sourcing: inline agent output comes from events.jsonl
 *   (already writer-bounded); the agent .md is consulted ONLY for the verbatim
 *   Prompt (no JSON copy exists), via a bounded prefix read.
 * - Every file read has a byte ceiling; stderr is read as a bounded TAIL (crash
 *   evidence lives at the end); journal.jsonl and stdout logs are never inlined.
 * - A global inline budget degrades later agents to metadata + links, with a
 *   visible clamp note (clamps are never silent).
 * - hrefs are recomputed relative to the run dir with a containment check —
 *   recorded absolute paths are untrusted.
 * - Degrades gracefully on partial/failed/foreign runs; throws only below the
 *   minimum (neither status.json nor result.json readable).
 * - Deterministic for a fixed opts.generatedAt: no other wall-clock reads.
 *
 * Reuses the extension's tested parsers (readRunEvents, getRunState,
 * computeCodeHash) so report semantics stay ≡ TUI semantics.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { extractMarkdownSection } from "./agent-view.js";
import { readRunEvents } from "./event-parser.js";
import { computeCodeHash } from "./journal.js";
import { buildRunReportHtml, type RunReportAgent, type RunReportModel, type RunReportText } from "./run-report-html.js";
import { getRunState } from "./run-state.js";
import type { WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "./types.js";

export type { RunReportModel };
export { buildRunReportHtml };

/** Bounds — anchored to existing runtime constants (design record §4). */
export const REPORT_BOUNDS = {
	/** Matches MAX_TOOL_TEXT / MAX_AGENT_OUTPUT_IN_RESULT. */
	outputChars: 24_000,
	/** Matches the readFilePrefix precedent for agent .md reads. */
	promptChars: 16_000,
	dataChars: 16_000,
	/** Tail, aligned with the TUI's 6 000-char stderr magnitude. */
	stderrTailChars: 6_000,
	logDetailChars: 500,
	/** Total inlined content across the page (conservative pick). */
	globalInlineBudgetBytes: 1_000_000,
	/** Per-file read ceiling: hostile dirs cannot OOM the generator. */
	fileReadCeilingBytes: 4_000_000,
	maxArtifactsListed: 100,
} as const;

export interface CollectRunReportOptions {
	/** In-session readRunStatus verdict (staleness authority). Absent = foreign dir. */
	liveStatus?: WorkflowRunStatus;
	/**
	 * Current workflow script source for drift detection: a string re-hashes
	 * against status.codeHash; null means "script missing"; undefined = unknown.
	 */
	currentScriptCode?: string | null;
	/** Timestamp embedded in the report; injectable for deterministic output. */
	generatedAt?: string;
}

async function readBounded(file: string, maxBytes: number): Promise<string | undefined> {
	try {
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/** Bounded TAIL read: open + seek to size − maxBytes (never read the whole file). */
async function readTail(file: string, maxBytes: number): Promise<string | undefined> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return undefined;
		const start = Math.max(0, stat.size - maxBytes);
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

async function readJsonBounded<T>(file: string, maxBytes: number): Promise<T | undefined> {
	const body = await readBounded(file, maxBytes);
	if (body === undefined) return undefined;
	try {
		return JSON.parse(body) as T;
	} catch {
		return undefined;
	}
}

function boundedText(value: string, max: number): RunReportText {
	return value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false };
}

/** Recompute a recorded (untrusted, possibly absolute) path relative to the run dir. */
function containedRelative(runDir: string, candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	const resolvedRoot = path.resolve(runDir);
	const resolved = path.resolve(resolvedRoot, candidate);
	if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return undefined;
	const rel = path.relative(resolvedRoot, resolved);
	if (!rel || rel.startsWith("..")) return undefined;
	return rel.split(path.sep).join("/");
}

function displayScriptPath(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const cwd = process.cwd();
	const resolved = path.resolve(file);
	if (resolved.startsWith(cwd + path.sep)) return path.relative(cwd, resolved).split(path.sep).join("/");
	return path.basename(resolved);
}

interface MetricsFile {
	measuredAgents?: number;
	okAgents?: number;
	failedAgents?: number;
	outputTokensTotal?: number;
	costTotal?: number;
	toolCalls?: number;
	toolErrors?: number;
	autoRetries?: number;
	agents?: {
		id?: number;
		turns?: number;
		inputTokensPeak?: number;
		outputTokensTotal?: number;
		totalTokens?: number;
		costTotal?: number;
		toolCalls?: number;
		toolErrors?: number;
		autoRetries?: number;
	}[];
}

/** Second bounded events pass: structured agent `data` (readRunEvents keeps output only). */
async function readAgentData(runDir: string, ceiling: number): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	const body = await readBounded(path.join(runDir, "events.jsonl"), ceiling);
	if (!body) return out;
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; id?: unknown; data?: unknown };
			if (event.type !== "agent" || typeof event.id !== "number" || event.data === undefined) continue;
			out.set(event.id, JSON.stringify(event.data, null, 2));
		} catch {
			// Malformed lines are tolerated everywhere.
		}
	}
	return out;
}

async function listArtifacts(
	runDir: string,
	max: number,
): Promise<{ artifacts: { path: string; bytes?: number }[]; omitted: number }> {
	const found: { path: string; bytes?: number }[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				// Never follow symlinked dirs out of the run dir.
				if (!entry.isSymbolicLink()) await walk(path.join(dir, entry.name), childRel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (childRel === "report.html") continue; // the report never lists itself
			let bytes: number | undefined;
			try {
				bytes = (await fs.stat(path.join(dir, entry.name))).size;
			} catch {
				bytes = undefined;
			}
			found.push({ path: childRel, ...(bytes === undefined ? {} : { bytes }) });
		}
	};
	await walk(runDir, "");
	found.sort((a, b) => a.path.localeCompare(b.path));
	return { artifacts: found.slice(0, max), omitted: Math.max(0, found.length - max) };
}

export async function collectRunReport(runDir: string, opts: CollectRunReportOptions = {}): Promise<RunReportModel> {
	const B = REPORT_BOUNDS;
	const status = await readJsonBounded<WorkflowRunStatus>(path.join(runDir, "status.json"), B.fileReadCeilingBytes);
	const result = await readJsonBounded<WorkflowRunResult>(path.join(runDir, "result.json"), B.fileReadCeilingBytes);
	if (!status && !result) {
		throw new Error(`Not a readable run dir (no status.json or result.json): ${runDir}`);
	}
	const record = opts.liveStatus ?? result ?? status;
	if (!record) throw new Error(`Unreachable: no run record for ${runDir}`);
	const base = status ?? result;

	const state = getRunState(record);
	const terminal = state !== "running";

	const events = await readRunEvents(runDir);
	const metrics = await readJsonBounded<MetricsFile>(path.join(runDir, "metrics.json"), B.fileReadCeilingBytes);
	const agentData = await readAgentData(runDir, B.fileReadCeilingBytes);

	// Log precedence: status logs when non-empty, else events (matches formatRunView).
	const rawLogs: WorkflowLogEntry[] = base?.logs?.length ? base.logs : events.logs;
	const logs = rawLogs.map((entry) => ({
		time: entry.time,
		message: entry.message,
		...(entry.details === undefined
			? {}
			: {
					details: boundedText(
						typeof entry.details === "string" ? entry.details : JSON.stringify(entry.details),
						B.logDetailChars,
					).text,
				}),
	}));
	const phases = logs
		.map((entry) => {
			const match = /^phase: (.+)$/.exec(entry.message);
			return match ? { label: match[1], time: entry.time } : undefined;
		})
		.filter((p): p is { label: string; time: string } => p !== undefined);

	const metricsById = new Map<number, NonNullable<MetricsFile["agents"]>[number]>();
	for (const row of metrics?.agents ?? []) if (typeof row.id === "number") metricsById.set(row.id, row);

	const clampNotes: string[] = [];
	let inlineBudget = B.globalInlineBudgetBytes;
	let omittedAgents = 0;

	// One agents/ dir listing shared by every per-agent file lookup below.
	const agentFiles = await fs.readdir(path.join(runDir, "agents")).catch(() => [] as string[]);

	const agents: RunReportAgent[] = [];
	for (const agent of events.agents) {
		// Report vocabulary: an agent still "running" while the run is terminal was interrupted.
		const agentState = agent.state === "running" && terminal ? "interrupted" : agent.state;
		const failed = agent.ok === false || agentState === "failed" || agentState === "interrupted";

		const artifactHref = containedRelative(runDir, agent.artifactPath);
		const logBase = artifactHref?.endsWith(".md") ? artifactHref.slice(0, -3) : undefined;
		const idSlug = String(agent.id).padStart(4, "0");
		// Prefer the containment-checked artifact-derived names; fall back to the id-scan.
		const fileFor = (suffix: string): string | undefined => {
			if (logBase && agentFiles.includes(path.posix.basename(`${logBase}${suffix}`))) {
				return `${logBase}${suffix}`;
			}
			const scanned = agentFiles.find((name) => name.startsWith(`${idSlug}-`) && name.endsWith(suffix));
			return scanned ? `agents/${scanned}` : undefined;
		};
		const stdoutHref = fileFor(".stdout.log");
		const stderrHref = fileFor(".stderr.log");

		let prompt: RunReportText | undefined;
		let output: RunReportText | undefined;
		let data: RunReportText | undefined;
		if (artifactHref) {
			const prefix = await readBounded(path.join(runDir, artifactHref), B.promptChars);
			const section = prefix ? extractMarkdownSection(prefix, "Prompt") : undefined;
			if (section) prompt = boundedText(section, B.promptChars);
		}
		if (agent.output) output = boundedText(agent.output, B.outputChars);
		const dataJson = agentData.get(agent.id);
		if (dataJson) data = boundedText(dataJson, B.dataChars);

		const inlineCost = (prompt?.text.length ?? 0) + (output?.text.length ?? 0) + (data?.text.length ?? 0);
		let inlineOmitted = false;
		if (inlineCost > inlineBudget) {
			inlineOmitted = true;
			omittedAgents += 1;
			prompt = undefined;
			output = undefined;
			data = undefined;
		} else {
			inlineBudget -= inlineCost;
		}

		// Crash evidence stays visible even under the global clamp (it is small and tailed).
		let stderrTail: { text: string; href?: string } | undefined;
		if (failed && stderrHref) {
			const tail = await readTail(path.join(runDir, stderrHref), B.stderrTailChars);
			if (tail) stderrTail = { text: tail, href: stderrHref };
		}

		const m = metricsById.get(agent.id);
		agents.push({
			id: agent.id,
			name: agent.name,
			state: agentState,
			...(agent.ok === undefined ? {} : { ok: agent.ok }),
			...(agent.code === undefined ? {} : { code: agent.code }),
			...(agent.killed === undefined ? {} : { killed: agent.killed }),
			...(agent.startedAt ? { startedAt: agent.startedAt } : {}),
			...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
			...(agent.elapsedMs === undefined ? {} : { elapsedMs: agent.elapsedMs }),
			...(agent.model ? { model: agent.model } : {}),
			...(agent.thinking ? { thinking: agent.thinking } : {}),
			...(agent.schemaOk === undefined ? {} : { schemaOk: agent.schemaOk }),
			...(agent.phaseLabel ? { phaseLabel: agent.phaseLabel } : {}),
			...(agent.promptPreview ? { promptPreview: agent.promptPreview } : {}),
			...(prompt ? { prompt } : {}),
			...(output ? { output } : {}),
			...(data ? { data } : {}),
			...(stderrTail ? { stderrTail } : {}),
			...(stdoutHref ? { stdoutHref } : {}),
			...(artifactHref ? { artifactHref } : {}),
			...(agent.tools?.length ? { tools: agent.tools.join(", ") } : {}),
			...(agent.skills?.length ? { skills: agent.skills.join(", ") } : {}),
			...(agent.keys?.length ? { keys: agent.keys.join(", ") } : {}),
			...(m
				? {
						metrics: {
							...(m.turns === undefined ? {} : { turns: m.turns }),
							...(m.inputTokensPeak === undefined ? {} : { inputTokensPeak: m.inputTokensPeak }),
							...(m.outputTokensTotal === undefined ? {} : { outputTokensTotal: m.outputTokensTotal }),
							...(m.totalTokens === undefined ? {} : { totalTokens: m.totalTokens }),
							...(m.costTotal === undefined ? {} : { costTotal: m.costTotal }),
							...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls }),
							...(m.toolErrors === undefined ? {} : { toolErrors: m.toolErrors }),
							...(m.autoRetries === undefined ? {} : { autoRetries: m.autoRetries }),
						},
					}
				: {}),
			...(inlineOmitted ? { inlineOmitted: true } : {}),
		});
	}
	if (omittedAgents > 0) {
		clampNotes.push(
			`global inline budget (${B.globalInlineBudgetBytes} bytes) reached — inline content omitted for ${omittedAgents} agent(s); their on-disk files are linked instead`,
		);
	}

	const missingFiles: string[] = [];
	for (const file of ["result.json", "events.jsonl", "metrics.json"]) {
		try {
			await fs.access(path.join(runDir, file));
		} catch {
			missingFiles.push(file);
		}
	}

	const inputBody = await readBounded(path.join(runDir, "input.json"), B.outputChars + 1);
	const outputValue = result?.output ?? base?.output;
	const outputText =
		outputValue === undefined
			? undefined
			: typeof outputValue === "string"
				? outputValue
				: JSON.stringify(outputValue, null, 2);

	let codeDrift: RunReportModel["codeDrift"] = "unknown";
	if (opts.currentScriptCode === null) codeDrift = "missing";
	else if (typeof opts.currentScriptCode === "string" && base?.codeHash) {
		codeDrift = computeCodeHash(opts.currentScriptCode) === base.codeHash ? "match" : "changed";
	}

	const { artifacts, omitted } = await listArtifacts(runDir, B.maxArtifactsListed);

	const errorMessage = result?.error ?? base?.error;
	return {
		workflow: record.workflow,
		runId: record.runId,
		...(displayScriptPath(base?.file) ? { scriptPath: displayScriptPath(base?.file) } : {}),
		...(base?.scope ? { scope: base.scope } : {}),
		state,
		liveness: opts.liveStatus ? "verified" : "unverified",
		generatedAt: opts.generatedAt ?? new Date().toISOString(),
		...(base?.startedAt ? { startedAt: base.startedAt } : {}),
		...(record.endedAt ? { endedAt: record.endedAt } : {}),
		...(status?.updatedAt ? { updatedAt: status.updatedAt } : {}),
		...(record.elapsedMs === undefined ? {} : { elapsedMs: record.elapsedMs }),
		...(record.agentConcurrency === undefined ? {} : { agentConcurrency: record.agentConcurrency }),
		...(record.maxAgents === undefined ? {} : { maxAgents: record.maxAgents }),
		...(record.peakParallelAgents === undefined ? {} : { peakParallelAgents: record.peakParallelAgents }),
		...(errorMessage === undefined ? {} : { error: errorMessage }),
		codeDrift,
		...(inputBody === undefined ? {} : { input: boundedText(inputBody, B.outputChars) }),
		...(outputText === undefined ? {} : { output: boundedText(outputText, B.outputChars) }),
		logs,
		phases,
		agents,
		...(metrics
			? {
					metricsTotals: {
						...(metrics.measuredAgents === undefined ? {} : { measuredAgents: metrics.measuredAgents }),
						...(metrics.okAgents === undefined ? {} : { okAgents: metrics.okAgents }),
						...(metrics.failedAgents === undefined ? {} : { failedAgents: metrics.failedAgents }),
						...(metrics.outputTokensTotal === undefined ? {} : { outputTokensTotal: metrics.outputTokensTotal }),
						...(metrics.costTotal === undefined ? {} : { costTotal: metrics.costTotal }),
						...(metrics.toolCalls === undefined ? {} : { toolCalls: metrics.toolCalls }),
						...(metrics.toolErrors === undefined ? {} : { toolErrors: metrics.toolErrors }),
						...(metrics.autoRetries === undefined ? {} : { autoRetries: metrics.autoRetries }),
					},
				}
			: {}),
		artifacts,
		...(omitted > 0 ? { artifactsOmitted: omitted } : {}),
		missingFiles,
		clampNotes,
	};
}
