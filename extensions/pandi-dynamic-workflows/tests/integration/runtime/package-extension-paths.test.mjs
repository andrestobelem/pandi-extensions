import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule, loadModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

const { url, outDir } = await buildDwfModule({
	name: "pi-dw-package-extension-paths",
	relPath: "runtime/package-extension-paths.ts",
	outName: "package-extension-paths.mjs",
});
const { resolvePackageExtensionPaths } = await loadModule(url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-package-extension-paths-"));

try {
	const manifestPackage = path.join(root, "manifest");
	const manifestExtension = path.join(manifestPackage, "custom.ts");
	await fs.mkdir(manifestPackage, { recursive: true });
	await fs.writeFile(
		path.join(manifestPackage, "package.json"),
		JSON.stringify({ pi: { extensions: ["./custom.ts"] } }),
	);
	await fs.writeFile(manifestExtension, "export default {}\n");
	check(
		"package extension paths: resolves manifest extensions",
		JSON.stringify(await resolvePackageExtensionPaths(manifestPackage)) ===
			JSON.stringify([await fs.realpath(manifestExtension)]),
	);

	const fallbackPackage = path.join(root, "fallback");
	const fallbackExtension = path.join(fallbackPackage, "src", "index.ts");
	await fs.mkdir(path.dirname(fallbackExtension), { recursive: true });
	await fs.writeFile(fallbackExtension, "export default {}\n");
	check(
		"package extension paths: falls back to src/index.ts",
		JSON.stringify(await resolvePackageExtensionPaths(fallbackPackage)) ===
			JSON.stringify([await fs.realpath(fallbackExtension)]),
	);

	check(
		"package extension paths: ignores missing packages",
		JSON.stringify(await resolvePackageExtensionPaths(path.join(root, "missing"))) === "[]",
	);
} finally {
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(outDir, { recursive: true, force: true });
}

console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
if (counts.failed > 0) process.exit(1);
