import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPicanteInvocation, resolvePicanteScript, runPicante } from "../../dev-picante.mjs";

test("buildPicanteInvocation targets the sibling checkout and forwards args", () => {
	const invocation = buildPicanteInvocation({
		repoRoot: "/workspace/pandi-extensions",
		args: ["-p", "hello"],
		env: {
			KEEP_ME: "yes",
			PANDI_EXTENSIONS_ROOT: "/stale/checkout",
			npm_execpath: "/opt/npm-cli.js",
		},
		platform: "darwin",
		nodeExecPath: "/usr/bin/node",
	});

	assert.equal(invocation.command, "/usr/bin/node");
	assert.deepEqual(invocation.args, ["/opt/npm-cli.js", "run", "dev:picante", "--", "-p", "hello"]);
	assert.equal(invocation.cwd, "/workspace/pi-cante");
	assert.equal(invocation.env.KEEP_ME, "yes");
	assert.equal(invocation.env.PANDI_EXTENSIONS_ROOT, "/workspace/pandi-extensions");
});

test("buildPicanteInvocation resolves absolute and relative PI_CANTE_ROOT values", () => {
	const absoluteInvocation = buildPicanteInvocation({
		repoRoot: "/workspace/pandi-extensions",
		env: { PI_CANTE_ROOT: "/custom/pi-cante" },
	});
	const relativeInvocation = buildPicanteInvocation({
		repoRoot: "/workspace/pandi-extensions",
		env: { PI_CANTE_ROOT: "../custom-picante" },
	});

	assert.equal(absoluteInvocation.cwd, "/custom/pi-cante");
	assert.equal(relativeInvocation.cwd, "/workspace/custom-picante");
});

test("resolvePicanteScript delegates smoke scripts from their npm lifecycle", () => {
	for (const picanteScript of ["smoke:picante", "smoke:picante:tui"]) {
		assert.equal(resolvePicanteScript({ npm_lifecycle_event: picanteScript }), picanteScript);
		const invocation = buildPicanteInvocation({
			repoRoot: "/workspace/pandi-extensions",
			env: { npm_execpath: "/opt/npm-cli.js", npm_lifecycle_event: picanteScript },
			nodeExecPath: "/usr/bin/node",
		});
		assert.deepEqual(invocation.args, ["/opt/npm-cli.js", "run", picanteScript, "--"]);
	}
	assert.equal(resolvePicanteScript({ npm_lifecycle_event: "test:unit" }), "dev:picante");
});

test("buildPicanteInvocation runs npm through Node on Windows", () => {
	const invocation = buildPicanteInvocation({
		repoRoot: "C:\\workspace\\pandi-extensions",
		env: { npm_execpath: "C:\\npm\\npm-cli.js" },
		platform: "win32",
		nodeExecPath: "C:\\node\\node.exe",
	});

	assert.equal(invocation.command, "C:\\node\\node.exe");
	assert.deepEqual(invocation.args, ["C:\\npm\\npm-cli.js", "run", "dev:picante", "--"]);
	assert.equal(invocation.shell, undefined);
});

test("buildPicanteInvocation rejects direct execution on Windows", () => {
	assert.throws(
		() =>
			buildPicanteInvocation({
				repoRoot: "C:\\workspace\\pandi-extensions",
				env: {},
				platform: "win32",
			}),
		/run this command through npm run dev:picante/,
	);
});

test("runPicante validates the target manifest and returns the child status", () => {
	const calls = [];
	const options = {
		repoRoot: "/workspace/pandi-extensions",
		args: ["status"],
		env: { npm_execpath: "/opt/npm-cli.js" },
		platform: "darwin",
		nodeExecPath: "/usr/bin/node",
		exists: (path) => path === "/workspace/pi-cante/package.json",
		readFile: () => JSON.stringify({ scripts: { "dev:picante": "node scripts/dev-pandi.mjs" } }),
		spawn(command, args, spawnOptions) {
			calls.push({ command, args, spawnOptions });
			return { status: 7 };
		},
	};

	assert.equal(runPicante(options), 7);
	assert.deepEqual(calls[0], {
		command: "/usr/bin/node",
		args: ["/opt/npm-cli.js", "run", "dev:picante", "--", "status"],
		spawnOptions: {
			cwd: "/workspace/pi-cante",
			env: {
				npm_execpath: "/opt/npm-cli.js",
				PANDI_EXTENSIONS_ROOT: "/workspace/pandi-extensions",
			},
			stdio: "inherit",
		},
	});
	assert.throws(() => runPicante({ ...options, exists: () => false }), /No pi-cante checkout found/);
	assert.throws(
		() => runPicante({ ...options, readFile: () => JSON.stringify({ scripts: {} }) }),
		/does not declare a dev:picante script/,
	);
});

test("runPicante reports spawn failures with Picante context", () => {
	const spawnError = new Error("spawn failed");
	assert.throws(
		() =>
			runPicante({
				repoRoot: "/workspace/pandi-extensions",
				env: { npm_execpath: "/opt/npm-cli.js" },
				nodeExecPath: "/usr/bin/node",
				exists: () => true,
				readFile: () => JSON.stringify({ scripts: { "dev:picante": "node scripts/dev-pandi.mjs" } }),
				spawn: () => ({ error: spawnError, status: null }),
			}),
		(error) => {
			assert.match(error.message, /Failed to start Picante/);
			assert.equal(error.cause, spawnError);
			return true;
		},
	);
});
