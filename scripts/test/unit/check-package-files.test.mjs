import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findPackageFilesViolations } from "../../check-package-files.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function writeJson(root, relativePath, value) {
	writeFile(root, relativePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function writeFile(root, relativePath, content = "") {
	const fullPath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
	return fullPath;
}

test("findPackageFilesViolations reports root TypeScript files omitted from package files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-package-files-"));
	writeJson(root, "extensions/pandi-manual/package.json", {
		name: "@pandi-coding-agent/pandi-manual",
		files: ["index.ts", "README.md"],
	});
	writeFile(root, "extensions/pandi-manual/index.ts");
	writeFile(root, "extensions/pandi-manual/helper.ts");
	writeFile(root, "extensions/pandi-manual/README.md");

	const violations = findPackageFilesViolations({ root, extensionsDir: path.join(root, "extensions") });

	assert.deepEqual(
		violations.map((violation) => violation.relativePath),
		["helper.ts"],
	);
	assert.equal(violations[0].packageDir, "pandi-manual");
});

test("findPackageFilesViolations accepts globs and shipped support directories", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-package-files-"));
	writeJson(root, "extensions/pandi-glob/package.json", {
		name: "@pandi-coding-agent/pandi-glob",
		files: ["*.ts", "scripts/*.mjs", "scripts/*.d.mts", "skills", "README.md"],
	});
	writeFile(root, "extensions/pandi-glob/index.ts");
	writeFile(root, "extensions/pandi-glob/helper.ts");
	writeFile(root, "extensions/pandi-glob/README.md");
	writeFile(root, "extensions/pandi-glob/scripts/run.mjs");
	writeFile(root, "extensions/pandi-glob/scripts/run.d.mts");
	writeFile(root, "extensions/pandi-glob/skills/example/SKILL.md");
	writeFile(root, "extensions/pandi-glob/tests/fixture.ts");

	assert.deepEqual(findPackageFilesViolations({ root, extensionsDir: path.join(root, "extensions") }), []);
});

test("repo extension package files cover shippable source files", () => {
	assert.deepEqual(findPackageFilesViolations({ root: REPO, extensionsDir: path.join(REPO, "extensions") }), []);
});
