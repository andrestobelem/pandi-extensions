#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const { check, counts } = createChecker();
const built = await buildExtension({
	name: "pandi-face-style-storage",
	src: path.join(root, "extensions/pandi/face-style-storage.ts"),
	outName: "storage.mjs",
});
try {
	const storage = await loadModule(built.url);
	await fs.chmod(built.outDir, 0o555);
	check("saveFaceStyle reports failure when its storage is unwritable", storage.saveFaceStyle("gatuno") === false);
} finally {
	await fs.chmod(built.outDir, 0o755).catch(() => {});
	await fs.rm(built.outDir, { recursive: true, force: true });
}
console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed) process.exit(1);
