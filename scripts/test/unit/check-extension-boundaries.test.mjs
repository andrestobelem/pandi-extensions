import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findRuntimeBoundaryViolations } from "../../check-extension-boundaries.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function writeFile(root, relativePath, content) {
	const fullPath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
	return fullPath;
}

test("findRuntimeBoundaryViolations flags runtime imports that escape an extension", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-boundaries-"));
	writeFile(root, "extensions/pandi-a/index.ts", "export const a = 1;\n");
	writeFile(root, "extensions/pandi-b/index.ts", "import { a } from '../pandi-a/index';\nexport const b = a;\n");
	writeFile(root, "extensions/pandi-c/nested/index.ts", "import { c } from '../local';\nexport { c };\n");
	writeFile(root, "extensions/pandi-c/nested/local.ts", "export const c = 1;\n");
	writeFile(root, "extensions/pandi-d/tests/helper.ts", "import { a } from '../../pandi-a/index';\n");

	const violations = findRuntimeBoundaryViolations({ root, extensionsDir: path.join(root, "extensions") });

	assert.deepEqual(
		violations.map((violation) => violation.relativeFile),
		["extensions/pandi-b/index.ts"],
	);
	assert.equal(violations[0].specifier, "../pandi-a/index");
	assert.equal(violations[0].fromPackage, "pandi-b");
	assert.equal(violations[0].toPackage, "pandi-a");
});

test("repo runtime extension TypeScript files do not import across extension boundaries", () => {
	const violations = findRuntimeBoundaryViolations({ root: REPO, extensionsDir: path.join(REPO, "extensions") });
	assert.deepEqual(violations, []);
});
