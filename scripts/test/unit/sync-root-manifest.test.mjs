import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-root-manifest.mjs");
const { BUNDLED_EXTENSION_ENTRIES, deriveRootManifest, orderedExtensionDirs, sameList } = await import(
	pathToFileURL(SCRIPT).href
);

function writePackage(root, dir, pkg) {
	const file = path.join(root, "extensions", dir, "package.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
}

test("deriveRootManifest orders known dirs first and appends unknown dirs alphabetically", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-manifest-"));
	try {
		writePackage(root, "pandi-zed", { pi: { extensions: ["./zed.ts"] } });
		writePackage(root, "pandi-alpha", { pi: { extensions: ["./alpha.ts"], themes: ["./theme.json"] } });
		writePackage(root, "not-pandi", { pi: { extensions: ["./ignored.ts"] } });

		assert.deepEqual(orderedExtensionDirs(root, ["pandi-zed"]), {
			ordered: ["pandi-zed", "pandi-alpha"],
			unknown: ["pandi-alpha"],
		});
		assert.deepEqual(deriveRootManifest(root, ["pandi-zed"]).derived, {
			extensions: [
				"./extensions/pandi-zed/zed.ts",
				"./extensions/pandi-alpha/alpha.ts",
				...BUNDLED_EXTENSION_ENTRIES,
			],
			themes: ["./extensions/pandi-alpha/theme.json"],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("deriveRootManifest appends explicit bundled external extension entrypoints", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-manifest-bundled-"));
	try {
		writePackage(root, "pandi-core", { pi: { extensions: ["./index.ts"] } });
		assert.deepEqual(BUNDLED_EXTENSION_ENTRIES, [
			"./node_modules/pi-codex-web-search/src/index.ts",
			"./node_modules/pi-mcp-adapter/index.ts",
		]);
		assert.deepEqual(deriveRootManifest(root, ["pandi-core"]).derived.extensions, [
			"./extensions/pandi-core/index.ts",
			...BUNDLED_EXTENSION_ENTRIES,
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("sameList is order-sensitive", () => {
	assert.equal(sameList(["a", "b"], ["a", "b"]), true);
	assert.equal(sameList(["a", "b"], ["b", "a"]), false);
	assert.equal(sameList(["a"], ["a", "b"]), false);
});
