/**
 * Primitivas de concurrency / abort para pandi-dynamic-workflows.
 *
 * Hoja pura y sin dependencias: paralelismo acotado (mapLimit), un semáforo justo
 * (createSemaphore), sleep consciente de abort, combinación de señales parent+timeout y
 * formato de abort-reason. Depende solo de globals Web/Node (AbortController,
 * AbortSignal, setTimeout). Importada en una sola dirección por index.ts (sin ciclo).
 *
 * Extraído byte-idéntico desde index.ts.
 */

export interface CombinedSignal {
	signal: AbortSignal;
	abort(reason?: unknown): void;
	dispose(): void;
}

export function abortReasonMessage(signal: AbortSignal): string {
	const reason = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.trim()) return reason;
	return "Workflow aborted.";
}

export function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): CombinedSignal {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const abort = (reason?: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};
	const abortFromParent = () => abort(parent?.reason);
	if (parent?.aborted) abort(parent.reason);
	parent?.addEventListener("abort", abortFromParent, { once: true });
	if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
		timeout = setTimeout(
			() => abort(new Error(`Workflow timed out after ${Math.round(timeoutMs / 1000)}s.`)),
			timeoutMs,
		);
	}
	return {
		signal: controller.signal,
		abort,
		dispose() {
			if (timeout) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error(abortReasonMessage(signal));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(abortReasonMessage(signal)));
			return;
		}
		const timeout = setTimeout(done, ms);
		function abort() {
			clearTimeout(timeout);
			reject(new Error(abortReasonMessage(signal)));
		}
		function done() {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

export async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	options?: { onError?: "throw" },
): Promise<R[]>;
export async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	options: { onError: "null" },
): Promise<(R | null)[]>;
export async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	options: { onError?: "throw" | "null" } = {},
): Promise<(R | null)[]> {
	const results = new Array<R | null>(items.length);
	const onError = options.onError ?? "throw";
	// Fan-out estructurado fail-fast (onError "throw"): el PRIMER rechazo aborta una
	// señal scoped — entregada a fn como tercer argumento — para que los siblings en vuelo
	// puedan cancelarse y ningún item en cola llegue a arrancar. Antes los siblings seguían corriendo
	// (y los workers idle seguían tomando items NUEVOS) como huérfanos no observados. El
	// error original se relanza después de que todos los workers se apagaron.
	const scoped = combineSignal(signal, 0);
	let failed = false;
	let firstError: unknown;
	let next = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
	try {
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (true) {
					throwIfAborted(signal);
					if (failed) return;
					const index = next++;
					if (index >= items.length) return;
					try {
						results[index] = await fn(items[index], index, scoped.signal);
					} catch (err) {
						if (signal.aborted) throw err;
						if (onError === "throw") {
							if (!failed) {
								failed = true;
								firstError = err;
								scoped.abort(err instanceof Error ? err : new Error(String(err)));
							}
							return;
						}
						results[index] = null;
					}
				}
			}),
		);
	} finally {
		scoped.dispose();
	}
	if (failed) throw firstError;
	return results;
}

export function createSemaphore(limit: number, signal: AbortSignal) {
	let active = 0;
	let disposed = false;
	const queue: { resolve: (release: () => void) => void; reject: (error: Error) => void }[] = [];

	const makeRelease = () => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active = Math.max(0, active - 1);
			drain();
		};
	};

	const abortQueued = () => {
		const error = new Error(abortReasonMessage(signal));
		for (const waiter of queue.splice(0)) waiter.reject(error);
	};

	const drain = () => {
		if (disposed || signal.aborted) {
			abortQueued();
			return;
		}
		while (active < limit && queue.length > 0) {
			const waiter = queue.shift()!;
			active++;
			waiter.resolve(makeRelease());
		}
	};

	const onAbort = () => abortQueued();
	signal.addEventListener("abort", onAbort, { once: true });

	return {
		async acquire(): Promise<() => void> {
			if (disposed || signal.aborted) throw new Error(abortReasonMessage(signal));
			if (active < limit) {
				active++;
				return makeRelease();
			}
			return await new Promise<() => void>((resolve, reject) => {
				queue.push({ resolve, reject });
			});
		},
		dispose(): void {
			disposed = true;
			signal.removeEventListener("abort", onAbort);
			abortQueued();
		},
	};
}

// Serializa secciones async solapadas: cada runExclusive espera a que la anterior se asiente.
export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
