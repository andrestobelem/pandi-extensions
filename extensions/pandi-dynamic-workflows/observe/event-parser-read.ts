/**
 * Pipeline de lectura de run-events: events.jsonl + artifacts de agentes -> { logs, agents }.
 *
 * Los coercers, merge de agent-monitor y derivaciones phase/elapsed viven en event-parser.ts.
 * extractMarkdownSection vive en agent-view.ts y solo se llama DENTRO del cuerpo de readRunEvents.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMonitorModel, WorkflowLogEntry } from "../types.js";
import {
	booleanValue,
	isAgentMonitorState,
	mergeAgentMonitor,
	metricsValue,
	numberValue,
	type ParsedPhaseEvent,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./event-parser.js";
import { extractMarkdownSection } from "./markdown-section.js";
import { renderSafeInline } from "./text-sanitize.js";

export interface ParsedRunEvents {
	logs: WorkflowLogEntry[];
	phases: ParsedPhaseEvent[];
	agents: AgentMonitorModel[];
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
	const phases: ParsedPhaseEvent[] = [];
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
							...(booleanValue(details?.outputEmpty) === undefined
								? {}
								: { outputEmpty: booleanValue(details?.outputEmpty) }),
							...(booleanValue(details?.outputTruncated) === undefined
								? {}
								: { outputTruncated: booleanValue(details?.outputTruncated) }),
							...(booleanValue(details?.stdoutTruncated) === undefined
								? {}
								: { stdoutTruncated: booleanValue(details?.stdoutTruncated) }),
							...(numberValue(details?.outputChars) === undefined
								? {}
								: { outputChars: numberValue(details?.outputChars) }),
							...(numberValue(details?.stdoutChars) === undefined
								? {}
								: { stdoutChars: numberValue(details?.stdoutChars) }),
						});
					}
				} else if (event.type === "phase") {
					const id = numberValue(event.id);
					const label = stringValue(event.label);
					const time = stringValue(event.time);
					if (id !== undefined && label && time) phases.push({ id, label, time, source: "event" });
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
						const metrics = metricsValue(event.metrics);
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
							...(stringValue(event.model) ? { model: stringValue(event.model) } : {}),
							...(stringValue(event.thinking) ? { thinking: stringValue(event.thinking) } : {}),
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
							...(stringValue(event.promptCopy) ? { promptCopy: stringValue(event.promptCopy) } : {}),
							...(booleanValue(event.promptTruncated) === undefined
								? {}
								: { promptTruncated: booleanValue(event.promptTruncated) }),
							...(stringValue(event.output) !== undefined ? { output: stringValue(event.output) } : {}),
							...(booleanValue(event.schemaOk) === undefined ? {} : { schemaOk: booleanValue(event.schemaOk) }),
							...(booleanValue(event.outputEmpty) === undefined
								? {}
								: { outputEmpty: booleanValue(event.outputEmpty) }),
							...(booleanValue(event.outputTruncated) === undefined
								? {}
								: { outputTruncated: booleanValue(event.outputTruncated) }),
							...(booleanValue(event.stdoutTruncated) === undefined
								? {}
								: { stdoutTruncated: booleanValue(event.stdoutTruncated) }),
							...(numberValue(event.outputChars) === undefined
								? {}
								: { outputChars: numberValue(event.outputChars) }),
							...(numberValue(event.stdoutChars) === undefined
								? {}
								: { stdoutChars: numberValue(event.stdoutChars) }),
							...(metrics ? { metrics } : {}),
							promptAvailable: booleanValue(event.promptAvailable) === true || !!stringValue(event.artifactPath),
						});
					}
				}
			} catch {
				// Ignorá líneas de evento malformadas.
			}
		}
	} catch {
		// Toleramos events.jsonl ausente para runs antiguos o parciales.
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
		// Los runs sin artifacts de agentes igual renderizan su timeline normalmente.
	}

	return { logs, phases, agents: [...agentsById.values()].sort((a, b) => a.id - b.id) };
}

export async function readRunLogEvents(runDir: string): Promise<WorkflowLogEntry[]> {
	return (await readRunEvents(runDir)).logs;
}
