import type { AgentOptions, BashResult, RunLimits, SubagentResult } from "./types.js";
import type { AskOptions, BashOptions } from "./workflow-bash-ask.js";
import type { AgentSpec } from "./workflow-run-agents.js";

export interface WorkflowRuntimeApi {
	cwd: string;
	runId: string;
	runDir: string;
	input: unknown;
	limits: Readonly<RunLimits>;
	log(message: string, details?: unknown): Promise<void>;
	phase(label: string): Promise<void>;
	agent(prompt: string, options?: AgentOptions): Promise<SubagentResult>;
	agents(
		items: (string | AgentSpec)[],
		options?: AgentOptions & { concurrency?: number; settle?: false },
	): Promise<SubagentResult[]>;
	agents(
		items: (string | AgentSpec)[],
		options: AgentOptions & { concurrency?: number; settle: true },
	): Promise<(SubagentResult | null)[]>;
	workflow(name: string, input?: unknown): Promise<unknown>;
	ask(question: string, options?: AskOptions): Promise<string | boolean>;
	bash(command: string, options?: BashOptions): Promise<BashResult>;
	readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
	writeFile(filePath: string, data: string | Uint8Array): Promise<{ path: string }>;
	appendFile(filePath: string, data: string | Uint8Array): Promise<{ path: string }>;
	listFiles(dir?: string, options?: { maxFiles?: number }): Promise<string[]>;
	writeArtifact(name: string, data: unknown): Promise<{ path: string }>;
	appendArtifact(name: string, data: string | Uint8Array): Promise<{ path: string }>;
	sleep(ms: number): Promise<void>;
	json(value: unknown, maxChars?: number): string;
	compact(value: unknown, maxChars?: number): string;
}
