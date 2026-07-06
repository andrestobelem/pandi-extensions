// Tests del motor genérico de doc mirrors de pandi-docs (sync-doc-mirrors.mjs).
// Contrato fijado acá: entries {source, out?, kicker?, tokens?, artifact?} renderizados
// con el conversor pandi, escritura solo-si-cambió (recordatorio de redeploy solo cuando
// el contenido cambió de verdad), modo check sin writes, reescritura de links .md dentro
// del set hacia sus mirrors .html, reescritura de asset srcs cuando el out vive en otro
// directorio, poda de huérfanos en pruneDirs, y guard de hrefs .html con gemelo .md.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRIPT = path.join(REPO, "extensions", "pandi-docs", "scripts", "sync-doc-mirrors.mjs");

const { syncDocMirrors, loadManifest } = await import(pathToFileURL(SCRIPT).href);

function makeRoot(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pandi-mirrors-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	return root;
}

function cleanup(root) {
	fs.rmSync(root, { recursive: true, force: true });
}

test("sibling mode: writes .html next to each source, only-on-change, redeploy only when changed", () => {
	const root = makeRoot({
		"docs/a.md": "# A\n\nCuerpo A.\n",
		"docs/b.md": "# B\n\nCuerpo B.\n",
	});
	try {
		const entries = [
			{ source: "docs/a.md", artifact: { url: "https://claude.ai/x", favicon: "🚦" } },
			{ source: "docs/b.md" },
		];
		const first = syncDocMirrors(root, { entries });
		assert.deepEqual(first.written.sort(), ["docs/a.html", "docs/b.html"]);
		assert.equal(first.redeploys.length, 1);
		assert.equal(first.redeploys[0].source, "docs/a.md");
		assert.match(fs.readFileSync(path.join(root, "docs", "a.html"), "utf8"), /<title>A<\/title>/);

		const second = syncDocMirrors(root, { entries });
		assert.deepEqual(second.written, []);
		assert.deepEqual(second.unchanged.sort(), ["docs/a.html", "docs/b.html"]);
		assert.deepEqual(second.redeploys, [], "re-sync sin cambios no repite el recordatorio");

		fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n\nCuerpo A v2.\n");
		const third = syncDocMirrors(root, { entries });
		assert.deepEqual(third.written, ["docs/a.html"]);
		assert.equal(third.redeploys.length, 1);
	} finally {
		cleanup(root);
	}
});

test("check mode: reports stale without touching disk", () => {
	const root = makeRoot({ "docs/a.md": "# A\n\nx\n" });
	try {
		const entries = [{ source: "docs/a.md" }];
		const check = syncDocMirrors(root, { entries, check: true });
		assert.deepEqual(check.stale, ["docs/a.html"]);
		assert.ok(!fs.existsSync(path.join(root, "docs", "a.html")), "check nunca escribe");

		syncDocMirrors(root, { entries });
		const clean = syncDocMirrors(root, { entries, check: true });
		assert.deepEqual(clean.stale, []);
	} finally {
		cleanup(root);
	}
});

test("mirror-dir mode: in-set .md links rewritten to .html, asset srcs remapped, orphans pruned", () => {
	const root = makeRoot({
		"README.md": "# Home\n\nVer [a](docs/a.md) y ![img](docs/img.png)\n",
		"docs/a.md": "# A\n\nVolver a [home](../README.md#top) o [externo](https://x.md)\n",
		"docs/html/orphan.html": "<html>stale</html>",
	});
	try {
		const entries = [
			{ source: "README.md", out: "docs/html/index.html" },
			{ source: "docs/a.md", out: "docs/html/a.html" },
		];
		const report = syncDocMirrors(root, { entries, pruneDirs: ["docs/html"] });
		assert.deepEqual(report.deleted, ["orphan.html"]);

		const home = fs.readFileSync(path.join(root, "docs", "html", "index.html"), "utf8");
		assert.match(home, /href="a\.html"/, "link .md dentro del set apunta al mirror");
		assert.match(home, /src="\.\.\/img\.png"/, "asset relativo remapeado desde el out");

		const a = fs.readFileSync(path.join(root, "docs", "html", "a.html"), "utf8");
		assert.match(a, /href="index\.html#top"/, "anchor preservado en la reescritura");
		assert.match(a, /href="https:\/\/x\.md"/, "URL externa intacta");
	} finally {
		cleanup(root);
	}
});

test("bad source hrefs: an .html link with an in-set .md twin is reported", () => {
	const root = makeRoot({
		"docs/a.md": "# A\n\nMal: [b](b.html)\n",
		"docs/b.md": "# B\n\nx\n",
	});
	try {
		const entries = [{ source: "docs/a.md" }, { source: "docs/b.md" }];
		const report = syncDocMirrors(root, { entries, check: true });
		assert.equal(report.badHrefs.length, 1);
		assert.equal(report.badHrefs[0].file, "docs/a.md");
		assert.equal(report.badHrefs[0].twin, "docs/b.md");
	} finally {
		cleanup(root);
	}
});

test("per-entry css replaces the entire stylesheet for that mirror", () => {
	const root = makeRoot({
		"docs/a.md": "# A\n\nx\n",
		"docs/b.md": "# B\n\nx\n",
		"brand.css": "body { color: teal; }\n",
	});
	try {
		syncDocMirrors(root, { entries: [{ source: "docs/a.md", css: "brand.css" }, { source: "docs/b.md" }] });
		const a = fs.readFileSync(path.join(root, "docs", "a.html"), "utf8");
		assert.match(a, /body \{ color: teal; \}/);
		assert.doesNotMatch(a, /--bg:\s*#242526/, "el css propio reemplaza tokens y body css pandi");
		const b = fs.readFileSync(path.join(root, "docs", "b.html"), "utf8");
		assert.match(b, /--bg:\s*#242526/, "las entries sin css conservan el default pandi");
	} finally {
		cleanup(root);
	}
});

test("per-entry tokens css overrides the default pandi palette", () => {
	const root = makeRoot({
		"docs/a.md": "# A\n\nx\n",
		"brand.css": ":root { --bg: #010203; }\n",
	});
	try {
		syncDocMirrors(root, { entries: [{ source: "docs/a.md", tokens: "brand.css" }] });
		const html = fs.readFileSync(path.join(root, "docs", "a.html"), "utf8");
		assert.match(html, /--bg:\s*#010203/);
		assert.doesNotMatch(html, /--bg:\s*#242526/);
	} finally {
		cleanup(root);
	}
});

test("kicker flows through to the rendered header", () => {
	const root = makeRoot({ "docs/a.md": "# A\n\nx\n" });
	try {
		syncDocMirrors(root, { entries: [{ source: "docs/a.md", kicker: "proyecto · Docs" }] });
		assert.match(fs.readFileSync(path.join(root, "docs", "a.html"), "utf8"), />proyecto · Docs</);
	} finally {
		cleanup(root);
	}
});

test("missing sources are skipped and reported, not fatal", () => {
	const root = makeRoot({ "docs/a.md": "# A\n\nx\n" });
	try {
		const report = syncDocMirrors(root, { entries: [{ source: "docs/a.md" }, { source: "docs/gone.md" }] });
		assert.deepEqual(report.written, ["docs/a.html"]);
		assert.deepEqual(report.skipped, ["docs/gone.md"]);
	} finally {
		cleanup(root);
	}
});

test("loadManifest merges mirrors.json with an optional sibling mirrors.local.json", () => {
	const root = makeRoot({
		"mirrors.json": JSON.stringify({ mirrors: [{ source: "docs/a.md", kicker: "K" }] }),
		"mirrors.local.json": JSON.stringify({ mirrors: [{ source: ".notes/p.md" }] }),
	});
	try {
		const entries = loadManifest(path.join(root, "mirrors.json"));
		assert.deepEqual(
			entries.map((e) => e.source),
			["docs/a.md", ".notes/p.md"],
		);
	} finally {
		cleanup(root);
	}
});
