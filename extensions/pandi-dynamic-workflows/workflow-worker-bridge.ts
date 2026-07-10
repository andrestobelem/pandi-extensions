/**
 * Puente host↔worker para la ejecución de dynamic-workflows.
 *
 * Instancia el Worker (`eval: true`), despacha llamadas al API de runtime del host y
 * propaga abort/race vía señales por-llamada. Extraído de workflow-engine.ts sin cambio
 * de comportamiento: el engine construye el API y este módulo solo orquesta el worker.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { abortReasonMessage, type CombinedSignal, combineSignal, throwIfAborted } from "./concurrency-primitives.js";
import type { RunLimits, WorkflowDefinition } from "./types.js";
import { WORKFLOW_WORKER_SOURCE } from "./worker-source.js";
import { transformWorkflowCode } from "./workflow-transform.js";

/**
 * Superficie mínima que el bridge invoca en el host. El engine pasa su WorkflowRuntimeApi
 * completo; tipado estructural (solo métodos despachables + cwd/runId/runDir).
 */
export interface WorkflowWorkerHostApi {
	cwd: string;
	runId: string;
	runDir: string;
	log(message: string, details?: unknown): Promise<void>;
	phase(label: string): Promise<void>;
	agent(...args: unknown[]): Promise<unknown>;
	agents(...args: unknown[]): Promise<unknown>;
	workflow(...args: unknown[]): Promise<unknown>;
	ask(...args: unknown[]): Promise<unknown>;
	bash(...args: unknown[]): Promise<unknown>;
	readFile(...args: unknown[]): Promise<unknown>;
	writeFile(...args: unknown[]): Promise<unknown>;
	appendFile(...args: unknown[]): Promise<unknown>;
	listFiles(...args: unknown[]): Promise<unknown>;
	writeArtifact(...args: unknown[]): Promise<unknown>;
	appendArtifact(...args: unknown[]): Promise<unknown>;
	sleep(...args: unknown[]): Promise<unknown>;
}

// Canaliza un AbortSignal por-llamada del despachador del worker hacia el cierre del agente sin
// tocar WorkflowRuntimeApi. runSubagent lo captura de forma síncrona en la entrada para que sobreviva al
// occAssignMutex/semaphore awaits; el contexto ALS es por cadena async, así que las llamadas agent() concurrentes
// nunca se cross-talk. Se establece solo para llamadas method==="agent"; todo lo demás ve undefined y vuelve
// a la señal de ejecución.
export const callSignal = new AsyncLocalStorage<AbortSignal>();

export async function executeWorkflowCode(
	workflowDefinition: WorkflowDefinition,
	code: string,
	api: WorkflowWorkerHostApi,
	input: unknown,
	limits: Readonly<RunLimits>,
	signal: AbortSignal,
): Promise<unknown> {
	throwIfAborted(signal);
	const allowedMethods = new Set<keyof WorkflowWorkerHostApi>([
		"log",
		"phase",
		"agent",
		"agents",
		"workflow",
		"ask",
		"bash",
		"readFile",
		"writeFile",
		"appendFile",
		"listFiles",
		"writeArtifact",
		"appendArtifact",
		"sleep",
	]);
	const worker = new Worker(WORKFLOW_WORKER_SOURCE, {
		eval: true,
		workerData: {
			workflowName: workflowDefinition.name,
			filePath: workflowDefinition.path,
			code: transformWorkflowCode(code),
			input,
			cwd: api.cwd,
			runId: api.runId,
			runDir: api.runDir,
			limits,
		},
	});

	return await new Promise<unknown>((resolve, reject) => {
		let settled = false;
		// Manijos de aborción por-llamada para llamadas agent() en vuelo, codificadas por id de mensaje del worker. Un
		// mensaje abort-call (un perdedor de race()) aborta exactamente uno; cleanup desecha el resto.
		const callControllers = new Map<number, CombinedSignal>();

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			worker.removeAllListeners();
			void worker.terminate();
			// Aborta cada señal combinada de llamada en vuelo ANTES de desecharla. onAbort (en la
			// señal de ejecución) se dispara antes de los listeners abortFromParent por-llamada registrados después en la
			// misma señal, así que desechar aquí (que elimina esos listeners) los varaía y
			// dejaría hijos subagente ejecutándose hasta agentTimeoutMs. Abortar primero dispara cada
			// SIGTERM del hijo de forma síncrona; combineSignal.abort es idempotente.
			for (const c of callControllers.values()) {
				c.abort(new Error(abortReasonMessage(signal)));
				c.dispose();
			}
			callControllers.clear();
		};

		const settle = (fn: (value?: unknown) => void, value?: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		};

		const safePost = (message: unknown) => {
			if (settled) return;
			try {
				worker.postMessage(message);
			} catch {
				// El worker puede haberse salido entre una llamada host asíncrona y la respuesta.
			}
		};

		const onAbort = () => settle(reject, new Error(abortReasonMessage(signal)));
		signal.addEventListener("abort", onAbort, { once: true });

		worker.on("message", (message: any) => {
			if (!message || typeof message !== "object") return;
			if (message.type === "result") {
				settle(resolve, message.result);
				return;
			}
			if (message.type === "error") {
				settle(reject, new Error(message.error || "Workflow failed."));
				return;
			}
			if (message.type === "abort-call") {
				callControllers.get(message.id)?.abort(new Error("Call cancelled (race lost)."));
				return;
			}
			if (message.type !== "call") return;

			void (async () => {
				if (settled || signal.aborted) {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: abortReasonMessage(signal),
					});
					return;
				}
				const method = message.method as keyof WorkflowWorkerHostApi;
				if (!allowedMethods.has(method) || typeof api[method] !== "function") {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: `Unsupported workflow API method: ${String(method)}`,
					});
					return;
				}
				try {
					if (method === "agent" || method === "ask" || method === "agents") {
						// Per-call signal: aborts on run abort OR an abort-call (race loser). timeoutMs 0
						// => parent-only. Registered synchronously before any await, so an abort-call
						// can never arrive before its controller exists. The store is read by
						// runSubagent/runAsk and by runAgents' fan-out (so an agents() race loser is
						// cancelled at race-loss, not only at run end).
						const combined = combineSignal(signal, 0);
						callControllers.set(message.id, combined);
						try {
							const result = await callSignal.run(combined.signal, () =>
								(api[method] as any)(...(message.args ?? [])),
							);
							safePost({ type: "response", id: message.id, ok: true, result });
						} finally {
							combined.dispose();
							callControllers.delete(message.id);
						}
					} else {
						const result = await (api[method] as any)(...(message.args ?? []));
						safePost({ type: "response", id: message.id, ok: true, result });
					}
				} catch (err) {
					safePost({
						type: "response",
						id: message.id,
						ok: false,
						error: err instanceof Error ? err.stack || err.message : String(err),
					});
				}
			})();
		});

		worker.on("error", (err) => settle(reject, err));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) settle(reject, new Error(`Workflow worker exited with code ${code}.`));
		});
	});
}
