import assert from "node:assert/strict";
import { test } from "node:test";
import registerGondolin from "../../../.pi/tools-local/gondolin/index.ts";
import { VM } from "../../../.pi/tools-local/gondolin/node_modules/@earendil-works/gondolin/dist/src/index.js";
import { isSupportedPlatform, nodeVersionSupportsGondolin, npmInstallEnv, platformKey } from "../../setup-gondolin.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fakeVm(id, closeDone = Promise.resolve()) {
	const closeCalled = deferred();
	let closeCalls = 0;
	return {
		id,
		async exec() {
			return { stdout: "/bin/bash\n" };
		},
		close() {
			closeCalls++;
			closeCalled.resolve();
			return closeDone;
		},
		get closeCalls() {
			return closeCalls;
		},
		closeCalled: closeCalled.promise,
	};
}

test("platform helpers preserve the supported Gondolin host allowlist", () => {
	assert.equal(platformKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
	assert.equal(isSupportedPlatform("darwin-arm64"), true);
	assert.equal(isSupportedPlatform("linux-x64"), true);
	assert.equal(isSupportedPlatform("linux-arm64"), false);
});

test("nodeVersionSupportsGondolin matches the Node >= 23.6.0 guard", () => {
	assert.equal(nodeVersionSupportsGondolin("22.19.0"), false);
	assert.equal(nodeVersionSupportsGondolin("23.5.9"), false);
	assert.equal(nodeVersionSupportsGondolin("23.6.0"), true);
	assert.equal(nodeVersionSupportsGondolin("24.0.0"), true);
});

test("npmInstallEnv strips npm_config_* keys case-insensitively", () => {
	assert.deepEqual(npmInstallEnv({ PATH: "/bin", npm_config_allow_scripts: "true", NPM_CONFIG_CACHE: "x" }), {
		PATH: "/bin",
	});
});

test("shutdown invalidates a pending Gondolin VM start without clearing the next generation", async (t) => {
	const starts = [deferred(), deferred()];
	let startCount = 0;
	t.mock.method(VM, "create", () => {
		const start = starts[startCount++];
		assert.ok(start, "unexpected VM start");
		return start.promise;
	});

	const handlers = new Map();
	registerGondolin({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerTool() {},
	});
	const context = {
		ui: {
			notify() {},
			setStatus() {},
			theme: { fg: (_color, text) => text },
		},
	};
	const sessionStart = handlers.get("session_start");
	const sessionShutdown = handlers.get("session_shutdown");
	assert.equal(typeof sessionStart, "function");
	assert.equal(typeof sessionShutdown, "function");

	const firstStart = sessionStart({}, context);
	let firstShutdownSettled = false;
	const firstShutdown = sessionShutdown({}, context).then(() => {
		firstShutdownSettled = true;
	});
	const secondStart = sessionStart({}, context);
	assert.equal(startCount, 2);
	assert.equal(firstShutdownSettled, false);

	const firstCloseDone = deferred();
	const firstVm = fakeVm("first-vm", firstCloseDone.promise);
	starts[0].resolve(firstVm);
	await firstVm.closeCalled;
	assert.equal(firstVm.closeCalls, 1);
	assert.equal(firstShutdownSettled, false, "shutdown must wait for the pending VM to close");

	const firstStartCancelled = assert.rejects(firstStart, /shutdown/i);
	firstCloseDone.resolve();
	await Promise.all([firstShutdown, firstStartCancelled]);
	assert.equal(firstShutdownSettled, true);

	let sameSecondStartSettled = false;
	const sameSecondStart = sessionStart({}, context).then(() => {
		sameSecondStartSettled = true;
	});
	assert.equal(startCount, 2, "the old start cleanup must not erase the newer start promise");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sameSecondStartSettled, false, "the cancelled VM must not be published");

	const secondVm = fakeVm("second-vm");
	starts[1].resolve(secondVm);
	await Promise.all([secondStart, sameSecondStart]);
	assert.equal(firstVm.closeCalls, 1);

	await sessionShutdown({}, context);
	assert.equal(secondVm.closeCalls, 1);
});
