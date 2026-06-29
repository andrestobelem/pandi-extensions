/**
 * Run-events parsing kernel for pi-dynamic-workflows.
 *
 * Pure value coercers, the agent-monitor merge logic, the phase/elapsed
 * derivations, and the events.jsonl -> { logs, agents } parsing pipeline
 * (readRunEvents). Extracted byte-identically from index.ts behind the
 * run-events-parsing.test.mjs characterization net.
 *
 * Deferred runtime cycle with index.ts: this module imports extractMarkdownSection
 * from ./index.js, but only calls it INSIDE readRunEvents' body (never at module
 * top level), and index.ts in turn imports these functions and calls them only
 * inside its own functions/TUI methods. Types are import type (erased at build).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractMarkdownSection } from "./agent-view.js";
import type {
	AgentMonitorModel,
	AgentMonitorState,
	AgentPhaseInfo,
	SubagentResult,
	WorkflowLogEntry,
} from "./index.js";
import { renderSafeInline } from "./render-utils.js";

interface ParsedRunEvents {
	logs: WorkflowLogEntry[];
	agents: AgentMonitorModel[];
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function phaseEventFields(phase: AgentPhaseInfo | undefined): Partial<SubagentResult> {
	if (!phase || phase.total <= 0) return {};
	return {
		phaseId: phase.id,
		phaseIndex: phase.index,
		phaseTotal: phase.total,
		...(phase.label ? { phaseLabel: phase.label } : {}),
	};
}

// Live elapsed for an agent: use the recorded value once it ends, otherwise
// derive it from startedAt while running so the row ticks instead of showing a
// frozen "elapsed:…" placeholder.
export function getAgentElapsedMs(
	agent: Pick<AgentMonitorModel, "state" | "startedAt" | "elapsedMs">,
): number | undefined {
	if (agent.elapsedMs !== undefined) return agent.elapsedMs;
	if (agent.state === "running" && agent.startedAt) {
		const started = new Date(agent.startedAt).getTime();
		if (Number.isFinite(started)) return Math.max(0, Date.now() - started);
	}
	return undefined;
}

export function formatAgentPhase(
	agent: Pick<AgentMonitorModel, "phaseId" | "phaseIndex" | "phaseTotal" | "phaseLabel">,
): string | undefined {
	if (!agent.phaseIndex || !agent.phaseTotal) return undefined;
	const batch = agent.phaseId ? `P${agent.phaseId} ` : "";
	return `${batch}${agent.phaseIndex}/${agent.phaseTotal}`;
}

export function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string");
	return values.length === value.length ? values : undefined;
}

export function isAgentMonitorState(value: unknown): value is AgentMonitorState {
	return (
		value === "running" || value === "completed" || value === "failed" || value === "cached" || value === "unknown"
	);
}

export function mergeAgentMonitor(
	existing: AgentMonitorModel | undefined,
	patch: Partial<AgentMonitorModel> & { id: number; name: string },
): AgentMonitorModel {
	const existingState = existing?.state;
	const patchState = patch.state;
	const state =
		existingState &&
		(existingState === "completed" || existingState === "failed" || existingState === "cached") &&
		patchState === "running"
			? existingState
			: (patchState ?? existingState ?? "unknown");
	const artifactPath = patch.artifactPath ?? existing?.artifactPath;
	return {
		id: patch.id,
		name: patch.name || existing?.name || `agent-${patch.id}`,
		state,
		...(existing?.startedAt || patch.startedAt ? { startedAt: patch.startedAt ?? existing?.startedAt } : {}),
		...(existing?.endedAt || patch.endedAt ? { endedAt: patch.endedAt ?? existing?.endedAt } : {}),
		...(existing?.elapsedMs !== undefined || patch.elapsedMs !== undefined
			? { elapsedMs: patch.elapsedMs ?? existing?.elapsedMs }
			: {}),
		...(existing?.ok !== undefined || patch.ok !== undefined ? { ok: patch.ok ?? existing?.ok } : {}),
		...(existing?.code !== undefined || patch.code !== undefined ? { code: patch.code ?? existing?.code } : {}),
		...(existing?.killed !== undefined || patch.killed !== undefined
			? { killed: patch.killed ?? existing?.killed }
			: {}),
		...(artifactPath ? { artifactPath } : {}),
		...(existing?.tools || patch.tools ? { tools: patch.tools ?? existing?.tools } : {}),
		...(existing?.excludeTools || patch.excludeTools
			? { excludeTools: patch.excludeTools ?? existing?.excludeTools }
			: {}),
		...(existing?.skills || patch.skills ? { skills: patch.skills ?? existing?.skills } : {}),
		...(existing?.includeSkills !== undefined || patch.includeSkills !== undefined
			? { includeSkills: patch.includeSkills ?? existing?.includeSkills }
			: {}),
		...(existing?.extensions || patch.extensions ? { extensions: patch.extensions ?? existing?.extensions } : {}),
		...(existing?.includeExtensions !== undefined || patch.includeExtensions !== undefined
			? { includeExtensions: patch.includeExtensions ?? existing?.includeExtensions }
			: {}),
		...(existing?.keys || patch.keys ? { keys: patch.keys ?? existing?.keys } : {}),
		...(existing?.missingKeys || patch.missingKeys
			? { missingKeys: patch.missingKeys ?? existing?.missingKeys }
			: {}),
		...(existing?.isolatedEnv !== undefined || patch.isolatedEnv !== undefined
			? { isolatedEnv: patch.isolatedEnv ?? existing?.isolatedEnv }
			: {}),
		...(existing?.phaseId !== undefined || patch.phaseId !== undefined
			? { phaseId: patch.phaseId ?? existing?.phaseId }
			: {}),
		...(existing?.phaseIndex !== undefined || patch.phaseIndex !== undefined
			? { phaseIndex: patch.phaseIndex ?? existing?.phaseIndex }
			: {}),
		...(existing?.phaseTotal !== undefined || patch.phaseTotal !== undefined
			? { phaseTotal: patch.phaseTotal ?? existing?.phaseTotal }
			: {}),
		...(existing?.phaseLabel || patch.phaseLabel ? { phaseLabel: patch.phaseLabel ?? existing?.phaseLabel } : {}),
		...(existing?.promptPreview || patch.promptPreview
			? { promptPreview: patch.promptPreview ?? existing?.promptPreview }
			: {}),
		...(existing?.output || patch.output ? { output: patch.output ?? existing?.output } : {}),
		...(existing?.schemaOk !== undefined || patch.schemaOk !== undefined
			? { schemaOk: patch.schemaOk ?? existing?.schemaOk }
			: {}),
		promptAvailable: existing?.promptAvailable === true || patch.promptAvailable === true || !!artifactPath,
	};
}

async function readFilePrefix(file: string, maxBytes = 16_000): Promise<string> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

export async function readRunEvents(runDir: string): Promise<ParsedRunEvents> {
	const logs: WorkflowLogEntry[] = [];
	const agentsById = new Map<number, AgentMonitorModel>();
	const upsert = (patch: Partial<AgentMonitorModel> & { id: number; name: string }) => {
		agentsById.set(patch.id, mergeAgentMonitor(agentsById.get(patch.id), patch));
	};

	try {
		const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
		for (const line of body.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as {
					type?: string;
					time?: string;
					message?: string;
					details?: unknown;
					[key: string]: unknown;
				};
				if (event.type === "log" && event.time && event.message) {
					const logEntry: WorkflowLogEntry = {
						time: event.time,
						message: event.message,
						...(event.details === undefined ? {} : { details: event.details }),
					};
					logs.push(logEntry);
					const startMatch = /^agent (\d+) start: (.+)$/.exec(event.message);
					if (startMatch) {
						upsert({
							id: Number.parseInt(startMatch[1], 10),
							name: startMatch[2],
							state: "running",
							startedAt: event.time,
						});
						continue;
					}
					const endMatch = /^agent (\d+) end: (.+)$/.exec(event.message);
					if (endMatch) {
						const details = recordValue(event.details);
						const ok = booleanValue(details?.ok);
						upsert({
							id: Number.parseInt(endMatch[1], 10),
							name: endMatch[2],
							state: ok === false ? "failed" : "completed",
							endedAt: event.time,
							...(ok === undefined ? {} : { ok }),
							...(numberValue(details?.code) === undefined ? {} : { code: numberValue(details?.code) }),
							...(numberValue(details?.elapsedMs) === undefined
								? {}
								: { elapsedMs: numberValue(details?.elapsedMs) }),
							...(booleanValue(details?.schemaOk) === undefined
								? {}
								: { schemaOk: booleanValue(details?.schemaOk) }),
						});
					}
				} else if (event.type === "agent") {
					const id = numberValue(event.id);
					const name = stringValue(event.name);
					if (id !== undefined && name) {
						const ok = booleanValue(event.ok);
						const explicitState = isAgentMonitorState(event.state) ? event.state : undefined;
						const tools = stringArrayValue(event.tools);
						const excludeTools = stringArrayValue(event.excludeTools);
						const skills = stringArrayValue(event.skills);
						const extensions = stringArrayValue(event.extensions);
						const keys = stringArrayValue(event.keys);
						const missingKeys = stringArrayValue(event.missingKeys);
						const phaseId = numberValue(event.phaseId);
						const phaseIndex = numberValue(event.phaseIndex);
						const phaseTotal = numberValue(event.phaseTotal);
						const phaseLabel = stringValue(event.phaseLabel);
						upsert({
							id,
							name,
							state: explicitState ?? (ok === undefined ? "unknown" : ok ? "completed" : "failed"),
							...(stringValue(event.startedAt) ? { startedAt: stringValue(event.startedAt) } : {}),
							...(stringValue(event.endedAt) ? { endedAt: stringValue(event.endedAt) } : {}),
							...(numberValue(event.elapsedMs) === undefined ? {} : { elapsedMs: numberValue(event.elapsedMs) }),
							...(ok === undefined ? {} : { ok }),
							...(numberValue(event.code) === undefined ? {} : { code: numberValue(event.code) }),
							...(booleanValue(event.killed) === undefined ? {} : { killed: booleanValue(event.killed) }),
							...(stringValue(event.artifactPath) ? { artifactPath: stringValue(event.artifactPath) } : {}),
							...(tools ? { tools } : {}),
							...(excludeTools ? { excludeTools } : {}),
							...(skills ? { skills } : {}),
							...(booleanValue(event.includeSkills) === undefined
								? {}
								: { includeSkills: booleanValue(event.includeSkills) }),
							...(extensions ? { extensions } : {}),
							...(booleanValue(event.includeExtensions) === undefined
								? {}
								: { includeExtensions: booleanValue(event.includeExtensions) }),
							...(keys ? { keys } : {}),
							...(missingKeys ? { missingKeys } : {}),
							...(booleanValue(event.isolatedEnv) === undefined
								? {}
								: { isolatedEnv: booleanValue(event.isolatedEnv) }),
							...(phaseId === undefined ? {} : { phaseId }),
							...(phaseIndex === undefined ? {} : { phaseIndex }),
							...(phaseTotal === undefined ? {} : { phaseTotal }),
							...(phaseLabel ? { phaseLabel } : {}),
							...(stringValue(event.output) ? { output: stringValue(event.output) } : {}),
							...(booleanValue(event.schemaOk) === undefined ? {} : { schemaOk: booleanValue(event.schemaOk) }),
							promptAvailable: booleanValue(event.promptAvailable) === true || !!stringValue(event.artifactPath),
						});
					}
				}
			} catch {
				// Ignore malformed event lines.
			}
		}
	} catch {
		// Missing events.jsonl is tolerated for older or partial runs.
	}

	try {
		const agentDir = path.join(runDir, "agents");
		const entries = await fs.readdir(agentDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = /^(\d{4})-(.+)\.md$/.exec(entry.name);
			if (!match) continue;
			const id = Number.parseInt(match[1], 10);
			const file = path.join(agentDir, entry.name);
			let title = match[2].replace(/-/g, " ");
			let promptAvailable = true;
			let promptPreview: string | undefined;
			try {
				const prefix = await readFilePrefix(file);
				const heading = /^#\s+(.+)$/m.exec(prefix);
				if (heading?.[1]) title = heading[1].trim();
				promptAvailable = prefix.includes("\n## Prompt\n") || prefix.includes("state: running");
				const promptSection = extractMarkdownSection(prefix, "Prompt");
				if (promptSection) promptPreview = renderSafeInline(promptSection).slice(0, 500);
			} catch {
				promptAvailable = false;
			}
			upsert({
				id,
				name: title,
				artifactPath: file,
				promptAvailable,
				...(promptPreview ? { promptPreview } : {}),
			});
		}
	} catch {
		// Runs without agent artifacts still render their timeline normally.
	}

	return { logs, agents: [...agentsById.values()].sort((a, b) => a.id - b.id) };
}

export async function readRunLogEvents(runDir: string): Promise<WorkflowLogEntry[]> {
	return (await readRunEvents(runDir)).logs;
}
