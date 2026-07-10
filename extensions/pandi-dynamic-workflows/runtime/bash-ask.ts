import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "../lib/concurrency.js";
import type { OccurrenceCounter } from "../lib/occurrence-counter.js";
import type { AskResult, BashResult, JournalCache, RunLimits } from "../types.js";
import {
	appendJournalRecord,
	computeCallKey,
	lookupJournalRecord,
	makeJournalRecord,
	normalizeBashResultForJournal,
} from "./journal.js";
import { callSignal } from "./worker-bridge.js";

export interface BashOptions {
	cwd?: string;
	timeoutMs?: number;
	throwOnError?: boolean;
	cache?: boolean;
	__workflowNamespace?: string;
}

export interface AskOptions {
	kind?: "input" | "confirm" | "select";
	choices?: string[];
	placeholder?: string;
	default?: string | boolean;
	timeoutMs?: number;
	cache?: boolean;
	/** La respuesta es secreta: nunca la persistas (events/journal) ni la reproduzcas al reanudar. */
	secret?: boolean;
	__workflowNamespace?: string;
}

export type BashAskContext = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	runDir: string;
	getCodeHash: () => string;
	journal: JournalCache | undefined;
	occurrences: OccurrenceCounter;
	runLimits: Readonly<RunLimits>;
	runSignal: { signal: AbortSignal };
	bumpCachedCalls: () => void;
	log: (message: string, details?: unknown) => Promise<void>;
	appendEvent: (event: unknown) => Promise<void>;
};

export async function runBash(
	context: BashAskContext,
	command: string,
	options: BashOptions = {},
): Promise<BashResult> {
	const { pi, ctx, journal, occurrences, runLimits, runSignal, log, appendEvent } = context;
	throwIfAborted(runSignal.signal);
	// bash caching is opt-in: bash(cmd, { cache: true }). occ assigned
	// synchronously before any await for deterministic ordering.
	const cacheEnabled = options.cache === true;
	const key = computeCallKey("bash", [
		command,
		{
			cwd: options.cwd ?? ctx.cwd,
			...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
		},
	]);
	const occ = occurrences.next(key);
	if (cacheEnabled) {
		const hit = lookupJournalRecord(journal, key, occ);
		// "code" present + no artifactPath => BashResult (not a SubagentResult or AskResult). Keys never
		// collide across methods (computeCallKey namespaces by method), so this only narrows the type.
		if (hit && "code" in hit && !("artifactPath" in hit)) {
			context.bumpCachedCalls();
			await log(`bash cached: ${command.slice(0, 80)}`, {
				key: key.slice(0, 12),
				occ,
				...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
			});
			if (options.throwOnError && !hit.ok) {
				throw new Error(`Command failed (${hit.code}): ${command}\n${hit.stderr || hit.stdout}`);
			}
			return hit;
		}
	}
	const startedAt = Date.now();
	await log(
		`bash start: ${command.slice(0, 120)}`,
		options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : undefined,
	);
	const result = await pi.exec("bash", ["-lc", command], {
		cwd: options.cwd ?? ctx.cwd,
		timeout: options.timeoutMs ?? runLimits.agentTimeoutMs,
		signal: runSignal.signal,
	});
	throwIfAborted(runSignal.signal);
	const rawBashResult: BashResult = {
		ok: result.code === 0 && !result.killed,
		code: result.code,
		killed: result.killed,
		elapsedMs: Date.now() - startedAt,
		stdout: result.stdout,
		stderr: result.stderr,
	};
	const bashResult = cacheEnabled ? normalizeBashResultForJournal(rawBashResult) : rawBashResult;
	await appendEvent({
		type: "bash",
		command,
		...bashResult,
		...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
	});
	if (cacheEnabled) {
		await appendJournalRecord(
			context.runDir,
			makeJournalRecord({ key, occ, method: "bash", codeHash: context.getCodeHash(), result: bashResult }),
		);
	}
	await log(`bash end: ${command.slice(0, 120)}`, {
		ok: bashResult.ok,
		code: bashResult.code,
		...(options.__workflowNamespace ? { workflowNamespace: options.__workflowNamespace } : {}),
	});
	if (options.throwOnError && !bashResult.ok) {
		throw new Error(`Command failed (${bashResult.code}): ${command}\n${bashResult.stderr || bashResult.stdout}`);
	}
	return bashResult;
}

// ask(question, options?) devuelve la respuesta humana vía ctx.ui. Es seguro al reanudar: cachea por
// defecto y journaliza por (key, occ) con método "ask", para que un run reanudado REPRODUZCA la respuesta
// grabada y nunca vuelva a preguntar. La cancelación reutiliza el puente de señal por llamada de race():
// el dispatcher envuelve ask en callSignal ALS, así un abort-call (perdedor de race) o run-abort descarta
// el diálogo vía { signal }, y el guard post-abort lanza SIN journalizar (deja un hueco, consistente con race).

// Resolución + validación pura del kind de ask(): deriva kind desde options (select/confirm/input) y
// rechaza combinaciones ambiguas o inválidas con errores accionables. Extraída de runAsk para nombrar
// el contrato y poder caracterizarlo.
export function resolveAskKind(options: AskOptions): {
	kind: "input" | "confirm" | "select";
	hasChoices: boolean;
	hasDefault: boolean;
} {
	const hasChoices = options.choices !== undefined;
	if (options.kind === undefined && hasChoices && typeof options.default === "boolean") {
		throw new Error(
			"ask(): ambiguous kind — both choices and a boolean default were given; pass options.kind explicitly.",
		);
	}
	const kind: "input" | "confirm" | "select" =
		options.kind ?? (hasChoices ? "select" : typeof options.default === "boolean" ? "confirm" : "input");
	if (kind === "select" && (!Array.isArray(options.choices) || options.choices.length === 0)) {
		throw new Error("ask(): kind 'select' requires a non-empty options.choices array.");
	}
	const hasDefault = options.default !== undefined;
	if (kind === "select" && hasDefault && !(options.choices as string[]).includes(options.default as string)) {
		throw new Error("ask(): options.default for a select must be one of options.choices.");
	}
	return { kind, hasChoices, hasDefault };
}

export async function runAsk(
	context: BashAskContext,
	question: string,
	options: AskOptions = {},
): Promise<string | boolean> {
	const { ctx, journal, occurrences, runSignal, log, appendEvent } = context;
	const effectiveSignal = callSignal.getStore() ?? runSignal.signal;
	throwIfAborted(effectiveSignal);
	// Eager validation (cheap synchronous guards inside ask()'s own surface) before any UI/journal:
	const { kind, hasDefault } = resolveAskKind(options);
	const secret = options.secret === true;
	// Una respuesta secreta nunca puede tocar disco: desactiva forzosamente el journal, así no se escribe
	// en journal.jsonl ni se reproduce al reanudar, y se redacta en el event + log vivo de abajo. El valor
	// real se devuelve igualmente al workflow.
	const cacheEnabled = !secret && options.cache !== false;
	const redactedAnswer = secret ? "[redacted]" : undefined;
	const namespace = options.__workflowNamespace;
	const key = computeCallKey("ask", [
		question,
		{
			kind,
			choices: kind === "select" ? (options.choices ?? []) : undefined,
			placeholder: options.placeholder,
			default: options.default,
			...(namespace ? { workflowNamespace: namespace } : {}),
		},
	]);
	const occ = occurrences.next(key);
	if (cacheEnabled) {
		const hit = lookupJournalRecord(journal, key, occ) as AskResult | undefined;
		if (hit && "answer" in hit) {
			context.bumpCachedCalls();
			await appendEvent({
				type: "ask",
				kind: hit.kind,
				question,
				answer: hit.answer,
				state: "cached",
				...(namespace ? { workflowNamespace: namespace } : {}),
			});
			await log(`ask cached: ${question.slice(0, 80)}`, { key: key.slice(0, 12), occ, answer: hit.answer });
			return hit.answer;
		}
	}
	const startedAt = Date.now();
	const dialogOpts = {
		signal: effectiveSignal,
		...(typeof options.timeoutMs === "number" ? { timeout: options.timeoutMs } : {}),
	};
	await log(`ask: ${question.slice(0, 120)}`, { kind, ...(namespace ? { workflowNamespace: namespace } : {}) });

	let answer: string | boolean;
	let dismissed = false;
	let defaulted = false;
	if (!ctx.hasUI) {
		if (!hasDefault) {
			throw new Error(
				`ask() needs a human but no UI is available (mode=${ctx.mode}); pass options.default to proceed headlessly.`,
			);
		}
		answer = options.default as string | boolean;
		defaulted = true;
	} else {
		let res: string | boolean | undefined;
		if (kind === "confirm") {
			res = await ctx.ui.confirm(
				question,
				typeof options.placeholder === "string" ? options.placeholder : "",
				dialogOpts,
			);
		} else if (kind === "select") {
			res = await ctx.ui.select(question, options.choices ?? [], dialogOpts);
		} else {
			res = await ctx.ui.input(question, options.placeholder, dialogOpts);
		}
		// Guard post-abort: un perdedor de race / abort del run descarta el diálogo -> lanzar SIN journalizar.
		throwIfAborted(effectiveSignal);
		if (res === undefined) {
			// confirm never returns undefined; input/select return undefined on dismiss/timeout.
			if (!hasDefault)
				throw new Error(`ask() was dismissed and no options.default was provided: ${question.slice(0, 80)}`);
			answer = options.default as string | boolean;
			dismissed = true;
			defaulted = true;
		} else {
			answer = res;
		}
	}
	throwIfAborted(effectiveSignal);
	const result: AskResult = {
		kind,
		answer,
		...(dismissed ? { dismissed: true } : {}),
		...(defaulted ? { defaulted: true } : {}),
		elapsedMs: Date.now() - startedAt,
	};
	await appendEvent({
		type: "ask",
		kind,
		question,
		answer: redactedAnswer ?? answer,
		...(dismissed ? { dismissed: true } : {}),
		...(defaulted ? { defaulted: true } : {}),
		...(namespace ? { workflowNamespace: namespace } : {}),
	});
	if (cacheEnabled) {
		await appendJournalRecord(
			context.runDir,
			makeJournalRecord({ key, occ, method: "ask", codeHash: context.getCodeHash(), result }),
		);
	}
	await log(`ask answered: ${question.slice(0, 80)}`, { answer: redactedAnswer ?? answer, defaulted });
	return answer;
}
