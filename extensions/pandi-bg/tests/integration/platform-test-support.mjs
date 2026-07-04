export function withPlatform(value, fn) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
}

export function withKill(impl, fn) {
	const original = process.kill;
	process.kill = impl;
	try {
		return fn();
	} finally {
		process.kill = original;
	}
}

export function clearStubs() {
	globalThis.__bgReadFileSync = undefined;
	globalThis.__bgSpawnSync = undefined;
}
