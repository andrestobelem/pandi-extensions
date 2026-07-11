#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker, loadModule, STUB_SOURCES } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

function makeModel(workflowPath, label, notes = []) {
	return {
		workflow: {
			name: "same-workflow",
			scope: "project",
			path: workflowPath,
			relativePath: "same-workflow.js",
		},
		steps: [
			{
				index: 1,
				method: "agent",
				kind: "agent",
				symbol: "◆",
				title: "Subagent",
				label,
				line: 1,
				children: [],
			},
		],
		notes,
	};
}

async function installFakeMmdc(project) {
	const binDir = path.join(project, "node_modules", ".bin");
	await fs.mkdir(binDir, { recursive: true });
	const bin = path.join(binDir, process.platform === "win32" ? "mmdc.cmd" : "mmdc");
	const source =
		process.platform === "win32"
			? "@node -e \"const fs=require('fs');const a=process.argv.slice(1);fs.writeFileSync(a[a.indexOf('-o')+1],Buffer.from('png'))\" %*\r\n"
			: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("-o") + 1], Buffer.from("png"));
`;
	await fs.writeFile(bin, source, "utf8");
	if (process.platform !== "win32") await fs.chmod(bin, 0o755);
}

async function main() {
	const imageTuiStub = STUB_SOURCES.tui.replace(
		"export function getCapabilities() { return { images: false }; }",
		"export function getCapabilities() { return { images: true }; }",
	);
	check("test stub enables terminal images", imageTuiStub !== STUB_SOURCES.tui);

	const { url } = await buildDwfModule({
		name: "pi-dwf-graph-image-cache-key",
		relPath: "tui/graph/image.ts",
		outName: "graph-image.mjs",
		stubs: { tui: imageTuiStub },
	});
	const { renderWorkflowGraphImage } = await loadModule(url);

	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-graph-image-key-"));
	await installFakeMmdc(project);
	const workflowPath = path.join(project, ".pi", "workflows", "same-workflow.js");
	const ctx = { cwd: project, isProjectTrusted: () => true };

	const [first, second] = await Promise.all([
		renderWorkflowGraphImage(ctx, makeModel(workflowPath, "first Mermaid model")),
		renderWorkflowGraphImage(ctx, makeModel(workflowPath, "second Mermaid model")),
	]);
	check("first model renders an image", !!first.image, first.warning);
	check("second model renders an image", !!second.image, second.warning);
	const [firstMermaid, secondMermaid] = await Promise.all([
		first.image ? fs.readFile(first.image.mmdPath, "utf8") : "",
		second.image ? fs.readFile(second.image.mmdPath, "utf8") : "",
	]);
	check("control: the models produce different Mermaid", firstMermaid !== secondMermaid);
	check(
		"same workflow path with different Mermaid gets a different .mmd path",
		first.image?.mmdPath !== second.image?.mmdPath,
		`${first.image?.mmdPath}\n${second.image?.mmdPath}`,
	);
	check(
		"same workflow path with different Mermaid gets a different .png path",
		first.image?.pngPath !== second.image?.pngPath,
		`${first.image?.pngPath}\n${second.image?.pngPath}`,
	);

	const sameMermaid = await renderWorkflowGraphImage(
		ctx,
		makeModel(workflowPath, "second Mermaid model", ["document-only note"]),
	);
	check(
		"cache identity follows Mermaid content, not unrelated model fields",
		sameMermaid.image?.mmdPath === second.image?.mmdPath && sameMermaid.image?.pngPath === second.image?.pngPath,
		`${sameMermaid.image?.mmdPath}\n${second.image?.mmdPath}`,
	);

	const firstAgain = await renderWorkflowGraphImage(ctx, makeModel(workflowPath, "first Mermaid model"));
	check(
		"the content-addressed image paths are deterministic",
		firstAgain.image?.mmdPath === first.image?.mmdPath && firstAgain.image?.pngPath === first.image?.pngPath,
		`${firstAgain.image?.mmdPath}\n${first.image?.mmdPath}`,
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
