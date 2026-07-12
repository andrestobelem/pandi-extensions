export async function raceWithTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<{ timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
	});
	try {
		return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function settleWithinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
	await raceWithTimeout(work, timeoutMs);
}
