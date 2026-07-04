// Unit tests for scripts/sync-docs-html.mjs — committed pandi HTML mirror of the docs.
// Contract: pure mapping (outPathFor) + link rewriting (rewriteHrefs) + an end-to-end
// sync over a temp tree (idempotent writes, orphan removal, non-writing --check).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "sync-docs-html.mjs");
const { outPathFor, rewriteHrefs, syncDocsHtml } = await import(pathToFileURL(SCRIPT).href);

test("outPathFor maps the set and rejects everything else", () => {
	assert.equal(outPathFor("README.md"), "index.html");
	assert.equal(outPathFor("docs/setup.md"), "setup.html");
	assert.equal(outPathFor("docs/README.md"), "README.html");
	assert.equal(outPathFor("docs/research/x.md"), "research/x.html");
	assert.equal(outPathFor("docs/conversaciones/x.md"), null);
	assert.equal(outPathFor("AGENTS.md"), null);
	assert.equal(outPathFor("extensions/pandi-bg/README.md"), null);
});

test("rewriteHrefs rewrites in-set relative .md links, preserves anchors, leaves the rest", () => {
	const set = new Set(["README.md", "docs/README.md", "docs/setup.md", "docs/research/x.md"]);
	// From the root README (out: index.html at mirror root).
	let html = '<a href="docs/setup.md">s</a> <a href="docs/research/x.md#sec">r</a>';
	assert.equal(rewriteHrefs(html, "README.md", set), '<a href="setup.html">s</a> <a href="research/x.html#sec">r</a>');
	// From docs/README.md (out: README.html at mirror root): ./, ../ and bare relatives.
	html = '<a href="./setup.md">a</a> <a href="../README.md">b</a> <a href="research/x.md">c</a>';
	assert.equal(
		rewriteHrefs(html, "docs/README.md", set),
		'<a href="setup.html">a</a> <a href="index.html">b</a> <a href="research/x.html">c</a>',
	);
	// From a nested file (out: research/x.html): needs an upward relative.
	html = '<a href="../setup.md">up</a>';
	assert.equal(rewriteHrefs(html, "docs/research/x.md", set), '<a href="../setup.html">up</a>');
	// External URLs and out-of-set targets stay untouched.
	html = '<a href="https://x.io/a.md">e</a> <a href="../AGENTS.md">o</a>';
	assert.equal(rewriteHrefs(html, "docs/README.md", set), html);
});

function makeTree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-sync-"));
	fs.writeFileSync(path.join(root, "README.md"), "# Root\n\nSee [setup](docs/setup.md).\n");
	fs.mkdirSync(path.join(root, "docs", "research"), { recursive: true });
	fs.mkdirSync(path.join(root, "docs", "conversaciones"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "setup.md"), "# Setup\n\nBack to [root](../README.md).\n");
	fs.writeFileSync(path.join(root, "docs", "research", "x.md"), "# X\n\nNada.\n");
	fs.writeFileSync(path.join(root, "docs", "conversaciones", "c.md"), "# C\n\nTransient.\n");
	return root;
}

test("syncDocsHtml writes the mirror, is idempotent, removes orphans, and check never writes", () => {
	const root = makeTree();
	try {
		// First pass: writes the three in-set files (conversaciones excluded).
		const first = syncDocsHtml(root, {});
		assert.deepEqual(first.written.sort(), ["index.html", "research/x.html", "setup.html"]);
		const mirror = path.join(root, "docs", "html");
		const index = fs.readFileSync(path.join(mirror, "index.html"), "utf8");
		assert.match(index, /<title>Root<\/title>/);
		assert.match(index, /href="setup\.html"/); // link rewritten
		assert.ok(!fs.existsSync(path.join(mirror, "conversaciones")));

		// Second pass: nothing to do.
		const second = syncDocsHtml(root, {});
		assert.equal(second.written.length, 0);
		assert.equal(second.deleted.length, 0);

		// Orphan html gets removed; check mode reports but never writes/deletes.
		fs.writeFileSync(path.join(mirror, "orphan.html"), "zombie");
		fs.rmSync(path.join(root, "docs", "setup.md"));
		const check = syncDocsHtml(root, { check: true });
		assert.ok(check.stale.length >= 2, "check must report the orphan and the removed source");
		assert.ok(fs.existsSync(path.join(mirror, "orphan.html")), "check must not delete");
		assert.ok(fs.existsSync(path.join(mirror, "setup.html")), "check must not delete");

		const fix = syncDocsHtml(root, {});
		assert.ok(!fs.existsSync(path.join(mirror, "orphan.html")));
		assert.ok(!fs.existsSync(path.join(mirror, "setup.html")));
		assert.ok(fix.deleted.length >= 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
