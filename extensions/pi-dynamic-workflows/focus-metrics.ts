/**
 * pi-dynamic-workflows focus observability (pure).
 *
 * "Measure focus live" (context-engineering §4), in the spirit of OpenTelemetry
 * GenAI spans: fold the Pi JSON-mode event stream a subagent already emits into
 * focus metrics — per-step token growth, tool-error rate, and retries — then roll
 * the per-agent metrics up into a per-run summary the engine writes as artifacts
 * (metrics.json / metrics.md).
 *
 * Fully self-contained — no ctx, no fs, no node/SDK imports — so it is trivially
 * testable from raw stdout fixtures. Mirrors agent-output.ts: tolerant line-by-line
 * JSON parsing that skips partial/invalid lines and never throws.
 *
 * Token accounting (from AssistantMessage.usage on message_end/turn_end/agent_end):
 *   - inputTokensPeak  = max per-call (input + cacheRead + cacheWrite) → peak
 *     context-window pressure (the focus signal). Cache-aware: with prompt caching
 *     providers report the cached prompt in cacheRead/cacheWrite and usage.input is
 *     only the uncached remainder (~2 tok observed), so input alone lies.
 *   - outputTokensTotal= sum usage.output → total generation
 *   - cost/cacheRead/cacheWrite are summed (each is per-API-call)
 * Tool-error rate comes from tool_execution_end {isError}; retries from auto_retry_end.
 */

export interface AgentFocusMetrics {
	id: number;
	name: string;
	ok: boolean;
	elapsedMs: number;
	/** Assistant turns observed (counted from message_end events only — see parseAgentFocusMetrics). */
	turns: number;
	/** Peak per-call prompt size (input + cacheRead + cacheWrite) = peak context pressure. */
	inputTokensPeak: number;
	/** Summed generated tokens across the agent's API calls. */
	outputTokensTotal: number;
	/** Peak per-call totalTokens reported by the provider. */
	totalTokens: number;
	cacheReadTotal: number;
	cacheWriteTotal: number;
	costTotal: number;
	toolCalls: number;
	toolErrors: number;
	autoRetries: number;
}

export interface RunFocusMetrics {
	measuredAgents: number;
	okAgents: number;
	failedAgents: number;
	/** Max single-agent peak input tokens across the run (worst context pressure). */
	inputTokensPeak: number;
	outputTokensTotal: number;
	totalTokens: number;
	cacheReadTotal: number;
	cacheWriteTotal: number;
	costTotal: number;
	toolCalls: number;
	toolErrors: number;
	/** toolErrors / toolCalls, or 0 when there were no tool calls. */
	toolErrorRate: number;
	autoRetries: number;
	/** Sum of per-agent durations (NOT wall-clock; agents run in parallel). */
	agentElapsedMsTotal: number;
	/** Per-agent metrics ordered by id — the per-step token-growth trajectory. */
	agents: AgentFocusMetrics[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extract a Usage-shaped reading from an assistant message, if present. */
function readUsage(message: unknown): {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
} | null {
	const msg = asRecord(message);
	if (msg?.role !== "assistant") return null;
	const usage = asRecord(msg.usage);
	if (!usage) return null;
	const cost = asRecord(usage.cost);
	return {
		input: numberOf(usage.input),
		output: numberOf(usage.output),
		total: numberOf(usage.totalTokens),
		cacheRead: numberOf(usage.cacheRead),
		cacheWrite: numberOf(usage.cacheWrite),
		cost: cost ? numberOf(cost.total) : 0,
	};
}

/**
 * Fold one subagent's JSON-mode stdout into AgentFocusMetrics. Tolerant: invalid or
 * partial lines are skipped, and an empty/garbage stream yields zeroed metrics.
 */
export function parseAgentFocusMetrics(
	stdout: string,
	meta: { id: number; name: string; ok: boolean; elapsedMs: number },
): AgentFocusMetrics {
	const metrics: AgentFocusMetrics = {
		id: meta.id,
		name: meta.name,
		ok: meta.ok,
		elapsedMs: Math.max(0, Math.round(numberOf(meta.elapsedMs))),
		turns: 0,
		inputTokensPeak: 0,
		outputTokensTotal: 0,
		totalTokens: 0,
		cacheReadTotal: 0,
		cacheWriteTotal: 0,
		costTotal: 0,
		toolCalls: 0,
		toolErrors: 0,
		autoRetries: 0,
	};
	if (typeof stdout !== "string" || stdout.length === 0) return metrics;

	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // partial/invalid line — skip (lenient, never throw)
		}
		const record = asRecord(event);
		if (!record) continue;

		if (record.type === "tool_execution_end") {
			metrics.toolCalls++;
			if (record.isError === true) metrics.toolErrors++;
		} else if (record.type === "auto_retry_end") {
			metrics.autoRetries++;
		} else if (record.type === "message_end") {
			// message_end is the canonical terminal event per assistant API call and carries
			// final usage. turn_end/agent_end merely repeat/replay the same assistant message,
			// so counting only message_end avoids double-counting without any dedup bookkeeping.
			const usage = readUsage(record.message);
			if (usage) {
				metrics.turns++;
				accumulateUsage(metrics, usage);
			}
		}
	}
	return metrics;
}

function accumulateUsage(
	metrics: AgentFocusMetrics,
	usage: { input: number; output: number; total: number; cacheRead: number; cacheWrite: number; cost: number },
): void {
	// Cache-aware prompt size: cached tokens ARE input the model attends to; usage.input
	// alone is only the uncached remainder under prompt caching.
	metrics.inputTokensPeak = Math.max(metrics.inputTokensPeak, usage.input + usage.cacheRead + usage.cacheWrite);
	metrics.totalTokens = Math.max(metrics.totalTokens, usage.total);
	metrics.outputTokensTotal += usage.output;
	metrics.cacheReadTotal += usage.cacheRead;
	metrics.cacheWriteTotal += usage.cacheWrite;
	metrics.costTotal += usage.cost;
}

/** Roll per-agent focus metrics up into a per-run summary. */
export function aggregateRunFocusMetrics(agents: AgentFocusMetrics[]): RunFocusMetrics {
	const ordered = [...agents].sort((a, b) => a.id - b.id);
	const agg: RunFocusMetrics = {
		measuredAgents: ordered.length,
		okAgents: 0,
		failedAgents: 0,
		inputTokensPeak: 0,
		outputTokensTotal: 0,
		totalTokens: 0,
		cacheReadTotal: 0,
		cacheWriteTotal: 0,
		costTotal: 0,
		toolCalls: 0,
		toolErrors: 0,
		toolErrorRate: 0,
		autoRetries: 0,
		agentElapsedMsTotal: 0,
		agents: ordered,
	};
	for (const a of ordered) {
		if (a.ok) agg.okAgents++;
		else agg.failedAgents++;
		agg.inputTokensPeak = Math.max(agg.inputTokensPeak, a.inputTokensPeak);
		agg.outputTokensTotal += a.outputTokensTotal;
		agg.totalTokens = Math.max(agg.totalTokens, a.totalTokens);
		agg.cacheReadTotal += a.cacheReadTotal;
		agg.cacheWriteTotal += a.cacheWriteTotal;
		agg.costTotal += a.costTotal;
		agg.toolCalls += a.toolCalls;
		agg.toolErrors += a.toolErrors;
		agg.autoRetries += a.autoRetries;
		agg.agentElapsedMsTotal += a.elapsedMs;
	}
	agg.toolErrorRate = agg.toolCalls > 0 ? agg.toolErrors / agg.toolCalls : 0;
	return agg;
}

/** Human-readable focus report. Notes excluded (cached/resumed) calls explicitly. */
export function formatFocusMetricsMarkdown(agg: RunFocusMetrics, opts: { cachedCalls?: number } = {}): string {
	const cached = Math.max(0, Math.round(numberOf(opts.cachedCalls)));
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines: string[] = [
		"# Focus metrics",
		"",
		`- measuredAgents: ${agg.measuredAgents} (ok ${agg.okAgents}, failed ${agg.failedAgents})`,
		`- inputTokensPeak: ${agg.inputTokensPeak} (worst single-agent context pressure)`,
		`- outputTokensTotal: ${agg.outputTokensTotal}`,
		`- totalTokens (peak/call): ${agg.totalTokens}`,
		`- cacheRead/cacheWrite: ${agg.cacheReadTotal}/${agg.cacheWriteTotal}`,
		`- costTotal: ${agg.costTotal.toFixed(4)}`,
		`- toolCalls: ${agg.toolCalls}, toolErrors: ${agg.toolErrors}, toolErrorRate: ${pct(agg.toolErrorRate)}`,
		`- autoRetries: ${agg.autoRetries}`,
		`- agentElapsedMsTotal: ${agg.agentElapsedMsTotal} (sum of per-agent durations; not wall-clock)`,
	];
	if (cached > 0) {
		lines.push(
			"",
			`> ${cached} cached/resumed call(s) were served from the journal and are NOT re-run, so they are excluded from these metrics.`,
		);
	}
	lines.push(
		"",
		"## Per-step trajectory (peak input tokens by agent id)",
		"",
		"| id | name | ok | turns | inputPeak | outputTotal | toolCalls | toolErrors | retries | elapsedMs |",
		"| -- | ---- | -- | ----- | --------- | ----------- | --------- | ---------- | ------- | --------- |",
	);
	// Agent names are workflow-supplied, so escape Markdown table-breaking characters
	// (pipes and newlines) before interpolating into a cell.
	const cell = (value: string) => String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
	for (const a of agg.agents) {
		lines.push(
			`| ${a.id} | ${cell(a.name)} | ${a.ok ? "ok" : "FAIL"} | ${a.turns} | ${a.inputTokensPeak} | ${a.outputTokensTotal} | ${a.toolCalls} | ${a.toolErrors} | ${a.autoRetries} | ${a.elapsedMs} |`,
		);
	}
	return lines.join("\n");
}
