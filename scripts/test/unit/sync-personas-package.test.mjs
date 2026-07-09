import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { syncPersonasPackage } from "../../sync-personas-package.mjs";

function write(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function lines() {
	const out = [];
	return { out, log: (line) => out.push(line), error: (line) => out.push(line) };
}

test("syncPersonasPackage writes canonical persona JSONs and prunes stale files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "personas-package-"));
	try {
		write(path.join(root, ".pi", "personas", "alpha.json"), '{\n\t"thinking": "high"\n}\n');
		write(path.join(root, "extensions", "pandi-personas", "personas", "stale.json"), "{}\n");
		const captured = lines();

		const result = syncPersonasPackage({ repoRoot: root, log: captured.log, error: captured.error });

		assert.equal(result.ok, true);
		assert.equal(
			fs.readFileSync(path.join(root, "extensions", "pandi-personas", "personas", "alpha.json"), "utf8"),
			'{\n\t"thinking": "high"\n}\n',
		);
		assert.equal(fs.existsSync(path.join(root, "extensions", "pandi-personas", "personas", "stale.json")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncPersonasPackage check mode reports drift without writing", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "personas-package-"));
	try {
		write(path.join(root, ".pi", "personas", "alpha.json"), '{"thinking":"high"}\n');
		write(path.join(root, "extensions", "pandi-personas", "personas", "alpha.json"), "stale\n");
		const captured = lines();

		const result = syncPersonasPackage({ repoRoot: root, checkOnly: true, log: captured.log, error: captured.error });

		assert.equal(result.ok, false);
		assert.equal(
			fs.readFileSync(path.join(root, "extensions", "pandi-personas", "personas", "alpha.json"), "utf8"),
			"stale\n",
		);
		assert.match(captured.out.join("\n"), /drift: extensions\/pandi-personas\/personas\/alpha\.json/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
