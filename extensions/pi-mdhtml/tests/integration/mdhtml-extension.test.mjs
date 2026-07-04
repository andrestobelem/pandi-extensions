#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-mdhtml/index.ts:
 * the `/mdhtml` COMMAND (human) and the `markdown_to_html` TOOL (model).
 *
 * Contract pinned here:
 * - both surfaces are registered (command with an HTML-aware description; tool with a
 *   `path` parameter)
 * - converting a .md writes a sibling .html styled with the pandi tokens
 * - `-o` (command) / `out` (tool) override the output path, creating parent dirs
 * - `--kicker` (command) / `kicker` (tool) set the header kicker
 * - multiple command inputs each write a sibling .html; `-o` with several inputs errors
 * - missing input / empty path return a bounded error (notify error / details.isError),
 *   and nothing is written
 *
 * Self-bootstrapping (same pattern as the pi-mdview suites): esbuilds the CURRENT
 * index.ts into an OS tempdir and copies the vendored skills/ dir next to the bundle,
 * because index.ts resolves pandi-tokens.css relative to import.meta.url.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildMdhtml() {
	return await buildExtension({
		name: "pi-mdhtml-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-mdhtml", "index.ts"),
		outName: "mdhtml.mjs",
		// No typebox stub: bundle the real one so tool.parameters keeps a real JSON schema
		// (.properties), same as the pi-mdview suites.
		copyDirs: { skills: path.join(REPO_ROOT, "extensions", "pi-mdhtml", "skills") },
	});
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
	};
}

function makeCtx({ cwd, mode = "tui" } = {}) {
	const notes = [];
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		ui: { notify: (msg, type) => notes.push({ msg, type }) },
		_notes: notes,
	};
}

async function loadSurfaces(url) {
	const extension = await loadDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { command: commands.get("mdhtml"), tool: tools.get("markdown_to_html") };
}

async function tmpCwd(name) {
	return await fs.mkdtemp(path.join(os.tmpdir(), `pi-mdhtml-${name}-`));
}

async function scenarioRegistered(url) {
	const { command, tool } = await loadSurfaces(url);
	check("command /mdhtml registered", !!command, String(!!command));
	check("command describes HTML conversion", /html/i.test(command?.description || ""), command?.description);
	check("tool markdown_to_html registered", !!tool, String(!!tool));
	check("tool describes Markdown → HTML", /markdown/i.test(tool?.description || ""), tool?.description);
	const props = tool?.parameters?.properties || {};
	check("tool has a `path` parameter", "path" in props, JSON.stringify(Object.keys(props)));
	check("tool execute is a function", typeof tool?.execute === "function");
}

async function scenarioCommandConverts(url) {
	const cwd = await tmpCwd("cmd");
	await fs.writeFile(path.join(cwd, "informe.md"), "# Informe demo\n\nCuerpo del informe.\n", "utf8");
	const { command } = await loadSurfaces(url);
	const ctx = makeCtx({ cwd });

	await command.handler("informe.md", ctx);
	const html = await fs.readFile(path.join(cwd, "informe.html"), "utf8");
	check("command: writes the sibling .html", /<title>Informe demo<\/title>/.test(html), html.slice(0, 200));
	check("command: output embeds the pandi tokens", /--bg:\s*#242526/.test(html));
	check("command: output keeps the body", /Cuerpo del informe\./.test(html));
	const note = ctx._notes.find((n) => n.type === "info");
	check("command: notifies the written path", /informe\.html/.test(note?.msg || ""), JSON.stringify(ctx._notes));
}

async function scenarioCommandOutAndKicker(url) {
	const cwd = await tmpCwd("out");
	await fs.writeFile(path.join(cwd, "doc.md"), "# T\n\nx\n", "utf8");
	const { command } = await loadSurfaces(url);
	const ctx = makeCtx({ cwd });

	await command.handler('doc.md -o out/custom.html --kicker "Informe demo"', ctx);
	const html = await fs.readFile(path.join(cwd, "out", "custom.html"), "utf8");
	check("command -o: writes to the custom path (parent dirs created)", /<title>T<\/title>/.test(html));
	check("command --kicker: sets the kicker", />Informe demo</.test(html), html.match(/kicker[^<]*<[^>]*>[^<]*/)?.[0]);
}

async function scenarioCommandMultipleInputs(url) {
	const cwd = await tmpCwd("multi");
	await fs.writeFile(path.join(cwd, "a.md"), "# A\n\na\n", "utf8");
	await fs.writeFile(path.join(cwd, "b.md"), "# B\n\nb\n", "utf8");
	const { command } = await loadSurfaces(url);
	const ctx = makeCtx({ cwd });

	await command.handler("a.md b.md", ctx);
	const a = await fs.readFile(path.join(cwd, "a.html"), "utf8").catch(() => "");
	const b = await fs.readFile(path.join(cwd, "b.html"), "utf8").catch(() => "");
	check("command multi: converts every input", /<title>A<\/title>/.test(a) && /<title>B<\/title>/.test(b));

	const ctx2 = makeCtx({ cwd });
	await command.handler("a.md b.md -o single.html", ctx2);
	const err = ctx2._notes.find((n) => n.type === "error");
	check("command multi + -o: rejected with an error", !!err, JSON.stringify(ctx2._notes));
	const single = await fs
		.stat(path.join(cwd, "single.html"))
		.then(() => true)
		.catch(() => false);
	check("command multi + -o: writes nothing", !single);
}

async function scenarioCommandErrors(url) {
	const cwd = await tmpCwd("err");
	const { command } = await loadSurfaces(url);

	const ctx = makeCtx({ cwd });
	await command.handler("missing.md", ctx);
	const err = ctx._notes.find((n) => n.type === "error");
	check("command missing file: notifies an error", !!err, JSON.stringify(ctx._notes));
	check("command missing file: error names the file", /missing\.md/.test(err?.msg || ""), err?.msg);

	const ctx2 = makeCtx({ cwd });
	await command.handler("", ctx2);
	const usage = ctx2._notes[0];
	check("command no args: shows usage", /usage/i.test(usage?.msg || ""), JSON.stringify(ctx2._notes));
}

async function scenarioToolConverts(url) {
	const cwd = await tmpCwd("tool");
	await fs.writeFile(path.join(cwd, "doc.md"), "# Tool doc\n\nTOOL_BODY_42\n", "utf8");
	const { tool } = await loadSurfaces(url);
	const ctx = makeCtx({ cwd, mode: "print" });

	const result = await tool.execute("call-1", { path: "doc.md" }, undefined, undefined, ctx);
	const html = await fs.readFile(path.join(cwd, "doc.html"), "utf8");
	check("tool: writes the sibling .html", /<title>Tool doc<\/title>/.test(html));
	check("tool: output embeds the pandi tokens", /--bg:\s*#242526/.test(html));
	const text = result?.content?.[0]?.text || "";
	check("tool: ack mentions the output path", /doc\.html/.test(text), text);
	check(
		"tool: details carry the output path",
		/doc\.html$/.test(result?.details?.output || ""),
		JSON.stringify(result?.details),
	);
	check("tool: not an error", !result?.details?.isError, JSON.stringify(result?.details));

	const result2 = await tool.execute(
		"call-2",
		{ path: "doc.md", out: "nested/informe.html", kicker: "Informe tool" },
		undefined,
		undefined,
		ctx,
	);
	const html2 = await fs.readFile(path.join(cwd, "nested", "informe.html"), "utf8");
	check("tool out: writes to the custom path", /<title>Tool doc<\/title>/.test(html2));
	check("tool kicker: sets the kicker", />Informe tool</.test(html2));
	check("tool out: not an error", !result2?.details?.isError, JSON.stringify(result2?.details));
}

async function scenarioToolErrors(url) {
	const cwd = await tmpCwd("tool-err");
	const { tool } = await loadSurfaces(url);
	const ctx = makeCtx({ cwd, mode: "print" });

	const missing = await tool.execute("call-3", { path: "missing.md" }, undefined, undefined, ctx);
	check(
		"tool missing file: returns a tool error",
		missing?.details?.isError === true,
		JSON.stringify(missing?.details),
	);
	check(
		"tool missing file: error names the file",
		/missing\.md/.test(missing?.content?.[0]?.text || ""),
		missing?.content?.[0]?.text,
	);

	const empty = await tool.execute("call-4", { path: "" }, undefined, undefined, ctx);
	check("tool empty path: returns a tool error", empty?.details?.isError === true, JSON.stringify(empty?.details));
}

async function main() {
	const { url } = await buildMdhtml();
	await scenarioRegistered(url);
	await scenarioCommandConverts(url);
	await scenarioCommandOutAndKicker(url);
	await scenarioCommandMultipleInputs(url);
	await scenarioCommandErrors(url);
	await scenarioToolConverts(url);
	await scenarioToolErrors(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
