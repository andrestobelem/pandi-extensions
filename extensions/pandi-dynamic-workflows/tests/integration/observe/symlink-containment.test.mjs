/**
 * run-report-symlink-containment — las lecturas bounded del collector deben quedar
 * contenidas por realpath dentro del run dir. Symlinks de archivo o directorio no pueden
 * incorporar contenido externo; archivos internos e inexistentes conservan su contrato.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

const FILE_SENTINEL = "EXTERNAL-FILE-SENTINEL-8d21";
const DIR_SENTINEL = "EXTERNAL-DIR-SENTINEL-c407";
const TAIL_SENTINEL = "EXTERNAL-TAIL-SENTINEL-35ba";
const INPUT_SENTINEL = "EXTERNAL-INPUT-SENTINEL-a94f";

async function buildModule(relPath, outName, name) {
	const { url } = await buildDwfModule({ name, relPath, outName });
	return await import(url);
}

async function main() {
	const io = await buildModule("observe/io.ts", "observe-io.mjs", "pi-run-report-symlink-io");
	const collector = await buildModule(
		"observe/collector.ts",
		"run-report-collector.mjs",
		"pi-run-report-symlink-collector",
	);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "run-report-symlink-"));
	const runDir = path.join(tmp, "run");
	const externalDir = path.join(tmp, "external");

	try {
		await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
		await fs.mkdir(externalDir, { recursive: true });

		const internalFile = path.join(runDir, "internal.txt");
		const externalFile = path.join(externalDir, "external-agent.md");
		const externalDirFile = path.join(externalDir, "dir-agent.md");
		const externalTail = path.join(externalDir, "external.stderr.log");
		const externalInput = path.join(externalDir, "input.json");
		await fs.writeFile(internalFile, "internal-content");
		await fs.writeFile(externalFile, `# agent\n\n## Prompt\n\n${FILE_SENTINEL}\n`);
		await fs.writeFile(externalDirFile, `# agent\n\n## Prompt\n\n${DIR_SENTINEL}\n`);
		await fs.writeFile(externalTail, `${"x".repeat(200)}\n${TAIL_SENTINEL}\n`);
		await fs.writeFile(externalInput, INPUT_SENTINEL);

		const fileLink = path.join(runDir, "agents", "0001-file-link.md");
		const tailLink = path.join(runDir, "agents", "0001-file-link.stderr.log");
		const dirLink = path.join(runDir, "linked");
		await fs.symlink(externalFile, fileLink);
		await fs.symlink(externalTail, tailLink);
		await fs.symlink(externalDir, dirLink, "dir");
		await fs.symlink(externalInput, path.join(runDir, "input.json"));

		check(
			"bounded read preserves internal files",
			(await io.readBounded(internalFile, 1_000, runDir)) === "internal-content",
		);
		check(
			"bounded read tolerates missing files",
			(await io.readBounded(path.join(runDir, "missing.txt"), 1_000, runDir)) === undefined,
		);
		check("bounded read rejects file symlink escape", (await io.readBounded(fileLink, 1_000, runDir)) === undefined);
		check(
			"bounded read rejects directory symlink escape",
			(await io.readBounded(path.join(dirLink, "dir-agent.md"), 1_000, runDir)) === undefined,
		);
		check("tail read rejects file symlink escape", (await io.readTail(tailLink, 1_000, runDir)) === undefined);
		check(
			"tail read rejects directory symlink escape",
			(await io.readTail(path.join(dirLink, "external.stderr.log"), 1_000, runDir)) === undefined,
		);

		const status = {
			workflow: "symlink-containment",
			scope: "project",
			file: path.join(runDir, "workflow.js"),
			runId: "run-symlink-containment",
			runDir,
			state: "failed",
			background: true,
			active: false,
			startedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
			endedAt: "2026-01-01T00:00:01.000Z",
			elapsedMs: 1_000,
			agentCount: 2,
			logs: [],
		};
		await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status));
		await fs.writeFile(
			path.join(runDir, "events.jsonl"),
			`${[
				{
					type: "agent",
					id: 1,
					name: "file-link",
					ok: false,
					state: "failed",
					artifactPath: fileLink,
				},
				{
					type: "agent",
					id: 2,
					name: "dir-link",
					ok: true,
					state: "completed",
					artifactPath: path.join(dirLink, "dir-agent.md"),
				},
			]
				.map(JSON.stringify)
				.join("\n")}\n`,
		);

		const report = await collector.collectRunReport(runDir, { generatedAt: "2026-01-02T00:00:00.000Z" });
		const serialized = JSON.stringify(report);
		for (const sentinel of [FILE_SENTINEL, DIR_SENTINEL, TAIL_SENTINEL, INPUT_SENTINEL]) {
			check(`report excludes ${sentinel}`, !serialized.includes(sentinel));
		}
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}

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
