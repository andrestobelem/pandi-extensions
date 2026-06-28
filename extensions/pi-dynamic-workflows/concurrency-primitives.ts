/**
 * Concurrency / abort primitives for pi-dynamic-workflows.
 *
 * A pure, dependency-free leaf: bounded-parallelism (mapLimit), a fair semaphore
 * (createSemaphore), abort-aware sleep, parent+timeout signal combination, and
 * abort-reason formatting. Depends only on Web/Node globals (AbortController,
 * AbortSignal, setTimeout). Imported one-way by index.ts (no cycle).
 *
 * Extracted byte-identically from index.ts.
 */

interface CombinedSignal {
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
	fn: (item: T, index: number) => Promise<R>,
	options?: { onError?: "throw" },
): Promise<R[]>;
export async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number) => Promise<R>,
	options: { onError: "null" },
): Promise<Array<R | null>>;
export async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	fn: (item: T, index: number) => Promise<R>,
	options: { onError?: "throw" | "null" } = {},
): Promise<Array<R | null>> {
	const results = new Array<R | null>(items.length);
	const onError = options.onError ?? "throw";
	let next = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				throwIfAborted(signal);
				const index = next++;
				if (index >= items.length) return;
				try {
					results[index] = await fn(items[index], index);
				} catch (err) {
					if (signal.aborted || onError === "throw") throw err;
					results[index] = null;
				}
			}
		}),
	);
	return results;
}

export function createSemaphore(limit: number, signal: AbortSignal) {
	let active = 0;
	let disposed = false;
	const queue: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void }> =
		[];

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
