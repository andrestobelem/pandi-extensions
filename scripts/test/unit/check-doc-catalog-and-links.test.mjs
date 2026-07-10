import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "check-doc-catalog-and-links.mjs");
const { checkDocCatalogAndLinks, extractMarkdownLinks, stripCodeSpans } = await import(pathToFileURL(SCRIPT).href);

function writeFile(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function makeDocsRoot({
	readmeLink = "docs/setup.md",
	headlineCount = 1,
	includeCatalogRow = true,
	agents = "# Agents\n",
} = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-catalog-"));
	writeFile(
		path.join(root, "package.json"),
		`${JSON.stringify({ pi: { extensions: ["./extensions/pandi-foo/index.ts"] } })}\n`,
	);
	// La fuente de verdad del catálogo es el dir extensions/pandi-foo (package.json ya no se lee).
	writeFile(path.join(root, "extensions", "pandi-foo", ".keep"), "");
	writeFile(path.join(root, "AGENTS.md"), agents);
	writeFile(
		path.join(root, "README.md"),
		[
			"# README",
			"",
			`**A suite of ${headlineCount} extensions for [Pi]`,
			"",
			"All 1 extensions load by default from the `pi.extensions` field",
			"",
			includeCatalogRow ? "**pandi-foo**" : "No catalog row here",
			"",
			`See [setup](${readmeLink}).`,
			"",
		].join("\n"),
	);
	writeFile(path.join(root, "docs", "setup.md"), "# Setup\n\nBack to [root](../README.md).\n");
	return root;
}

test("extractMarkdownLinks ignores code spans and fenced code while keeping local image targets", () => {
	const text = [
		"See [setup](docs/setup.md) and ![image](docs/image.png).",
		"Inline `code [skip](missing.md)` stays inert.",
		"```",
		"[skip fenced](missing.md)",
		"```",
		'A [titled](docs/titled.md "Title") link remains visible.',
	].join("\n");
	assert.equal(stripCodeSpans("a `b [x](y)` c"), "a  c");
	assert.deepEqual(extractMarkdownLinks(text), [
		{ href: "docs/setup.md", line: 1 },
		{ href: "docs/image.png", line: 1 },
		{ href: "docs/titled.md", line: 6 },
	]);
});

test("checkDocCatalogAndLinks passes a minimal in-sync tree", () => {
	const root = makeDocsRoot();
	try {
		assert.deepEqual(checkDocCatalogAndLinks(root), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("checkDocCatalogAndLinks reports catalog drift, stale text, and broken local links", () => {
	const root = makeDocsRoot({
		readmeLink: "docs/missing.md",
		headlineCount: 2,
		includeCatalogRow: false,
		agents: "# Agents\n\ntests/<extension>/integration/\n",
	});
	try {
		const failures = checkDocCatalogAndLinks(root);
		assert.ok(failures.includes("README headline says 2 extensions, extensions dir has 1"));
		assert.ok(failures.includes("README catalog missing row for pandi-foo"));
		assert.ok(
			failures.includes(
				"AGENTS.md still references tests/<extension>/integration/ instead of extensions/<extension>/tests/integration/",
			),
		);
		assert.ok(failures.includes("README.md:9 broken relative link: docs/missing.md"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
