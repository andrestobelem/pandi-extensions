import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-project-settings.mjs");
const { deriveProjectSettingsPackages, syncProjectSettings } = await import(pathToFileURL(SCRIPT).href);

function writePackage(root, dir, pkg) {
	const file = path.join(root, "extensions", dir, "package.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("deriveProjectSettingsPackages uses extension manifests and disables vendored skills in-repo", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-settings-"));
	try {
		writePackage(root, "pandi-alpha", { pi: { extensions: ["./index.ts"] } });
		writePackage(root, "pandi-skillful", { pi: { extensions: ["./index.ts"], skills: ["./skills"] } });
		writePackage(root, "pandi-theme", { pi: { themes: ["./themes"] } });
		writePackage(root, "not-pandi", { pi: { extensions: ["./ignored.ts"] } });

		assert.deepEqual(deriveProjectSettingsPackages(root, ["pandi-skillful"]), [
			{ source: "../extensions/pandi-skillful", skills: [] },
			"../extensions/pandi-alpha",
			"../extensions/pandi-theme",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("syncProjectSettings check detects drift and write mode preserves non-generated fields", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-settings-"));
	try {
		writePackage(root, "pandi-alpha", { pi: { extensions: ["./index.ts"] } });
		writePackage(root, "pandi-skillful", { pi: { extensions: ["./index.ts"], skills: ["./skills"] } });
		writePackage(root, "pandi-theme", { pi: { themes: ["./themes"] } });
		writeJson(path.join(root, ".pi", "settings.json"), {
			packages: ["../extensions/pandi-alpha"],
			extensions: [],
			custom: "keep me",
		});
		writeJson(path.join(root, ".pi", "settings.json.example"), {
			$comment: "keep this prose",
			packages: ["../extensions/stale"],
			extensions: [],
			theme: { light: "panda-syntax-light", dark: "panda-syntax-dark" },
		});

		const checkOnly = await syncProjectSettings({ repoRoot: root, checkOnly: true, loadOrder: ["pandi-skillful"] });
		assert.equal(checkOnly.ok, false);
		assert.equal(readJson(path.join(root, ".pi", "settings.json")).custom, "keep me", "check mode must not write");

		const written = await syncProjectSettings({ repoRoot: root, checkOnly: false, loadOrder: ["pandi-skillful"] });
		assert.equal(written.ok, true);
		assert.equal(written.wrote, 2);
		assert.deepEqual(readJson(path.join(root, ".pi", "settings.json")), {
			packages: [
				{ source: "../extensions/pandi-skillful", skills: [] },
				"../extensions/pandi-alpha",
				"../extensions/pandi-theme",
			],
			extensions: [],
			custom: "keep me",
		});
		assert.deepEqual(readJson(path.join(root, ".pi", "settings.json.example")), {
			$comment: "keep this prose",
			packages: [
				{ source: "../extensions/pandi-skillful", skills: [] },
				"../extensions/pandi-alpha",
				"../extensions/pandi-theme",
			],
			extensions: [],
			theme: { light: "panda-syntax-light", dark: "panda-syntax-dark" },
		});

		const after = await syncProjectSettings({ repoRoot: root, checkOnly: true, loadOrder: ["pandi-skillful"] });
		assert.equal(after.ok, true);
		assert.equal(after.drift, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
