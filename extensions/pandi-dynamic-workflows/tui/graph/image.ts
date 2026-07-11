/**
 * Stats de fan-out, dimensionado PNG y render mmdc para workflow-graph.
 * Import dinámico de renderWorkflowGraphMermaidLines evita ciclo estático con workflow-graph-render.js.
 */
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import type { WorkflowGraphFanoutInfo, WorkflowGraphFanoutUnit, WorkflowGraphModel } from "../../lib/graph/types.js";
import { ensureDir, getGraphRoot, slugify } from "../../lib/paths.js";
import type { ProcessResult } from "../../runtime/index.js";
import { EXTENSION_ROOT, runProcess } from "../../runtime/index.js";

export interface WorkflowGraphImageRender {
	base64: string;
	pngPath: string;
	mmdPath: string;
	command: string;
	elapsedMs: number;
	width: number;
	height: number;
	scale: number;
}

export interface WorkflowGraphImageAttempt {
	image?: WorkflowGraphImageRender;
	warning?: string;
}

function workflowGraphSingularUnit(unit: WorkflowGraphFanoutUnit): string {
	if (unit === "agents") return "agent";
	if (unit === "branches") return "branch";
	return "lane";
}

export function workflowGraphVisibleFanoutSlots(fanout: WorkflowGraphFanoutInfo): string[] {
	const unit = workflowGraphSingularUnit(fanout.unit);
	if (fanout.count !== undefined) {
		if (fanout.count <= 0) return [`no ${fanout.unit}`];
		if (fanout.count <= 6) return Array.from({ length: fanout.count }, (_, index) => `${unit} ${index + 1}`);
		return [`${unit} 1`, `${unit} 2`, `${unit} 3`, "…", `${unit} ${fanout.count}`];
	}
	return [`${unit} 1`, `${unit} 2`, "…", `${unit} n`];
}

export function workflowGraphStats(model: WorkflowGraphModel): {
	steps: number;
	fanoutSlots: number;
	orchestrationGroups: number;
	subworkflows: number;
} {
	let steps = model.steps.length;
	let fanoutSlots = 0;
	let orchestrationGroups = 0;
	let subworkflows = 0;
	for (const step of model.steps) {
		if (step.fanout) {
			fanoutSlots += workflowGraphVisibleFanoutSlots(step.fanout).length;
			orchestrationGroups++;
		}
		if (step.subworkflow) {
			subworkflows++;
			const child = workflowGraphStats(step.subworkflow);
			steps += child.steps;
			fanoutSlots += child.fanoutSlots;
			orchestrationGroups += child.orchestrationGroups;
			subworkflows += child.subworkflows;
		}
	}
	return { steps, fanoutSlots, orchestrationGroups, subworkflows };
}

function displayPathFromCwd(cwd: string, file: string): string {
	const relative = path.relative(cwd, file).replaceAll(path.sep, "/");
	return relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative) ? relative : file;
}

function clampWorkflowGraphNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function workflowGraphImageOptions(model: WorkflowGraphModel): {
	width: number;
	height: number;
	scale: number;
	maxWidthCells: number;
	maxHeightCells: number;
} {
	const stats = workflowGraphStats(model);
	return {
		width: clampWorkflowGraphNumber(2200 + stats.fanoutSlots * 120 + stats.subworkflows * 220, 2200, 3800),
		height: clampWorkflowGraphNumber(
			1300 + stats.steps * 130 + stats.orchestrationGroups * 180 + stats.subworkflows * 220,
			1300,
			3200,
		),
		scale: 2,
		maxWidthCells: 320,
		maxHeightCells: clampWorkflowGraphNumber(
			54 + stats.orchestrationGroups * 8 + stats.subworkflows * 8 + Math.floor(stats.steps / 2),
			54,
			96,
		),
	};
}

function mmdcBinName(): string {
	return process.platform === "win32" ? "mmdc.cmd" : "mmdc";
}

function resolveMmdcInvocation(cwd: string): {
	command: string;
	argsPrefix: string[];
	display: string;
} {
	const bin = mmdcBinName();
	const candidates = [
		path.join(cwd, "node_modules", ".bin", bin),
		path.join(process.cwd(), "node_modules", ".bin", bin),
		path.join(EXTENSION_ROOT, "node_modules", ".bin", bin),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate))
			return { command: candidate, argsPrefix: [], display: displayPathFromCwd(cwd, candidate) };
	}
	return { command: "mmdc", argsPrefix: [], display: "mmdc" };
}

function formatMmdcFailure(command: string, result: ProcessResult): string {
	const details = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
	const hint = /Could not find Chrome|Chrome.*not found|browser/i.test(details)
		? "\nHint: run `npx puppeteer browsers install chrome-headless-shell` if the Puppeteer browser was not installed."
		: "";
	const code = result.code === null ? "spawn" : `exit ${result.code}`;
	return `mmdc failed (${code}) via ${command}.${hint}${details ? `\n${details}` : ""}`;
}

export async function renderWorkflowGraphImage(
	ctx: ExtensionContext,
	model: WorkflowGraphModel,
): Promise<WorkflowGraphImageAttempt> {
	if (!getCapabilities().images)
		return {
			warning: "Terminal image protocol is not available, so inline PNG rendering is disabled.",
		};
	const root = getGraphRoot(ctx);
	await ensureDir(root);
	const { renderWorkflowGraphMermaidLines } = await import("./render.js");
	const mermaid = `${renderWorkflowGraphMermaidLines(model).join("\n")}\n`;
	const pathHash = crypto.createHash("sha1").update(model.workflow.path).digest("hex").slice(0, 8);
	const sourceHash = crypto.createHash("sha1").update(mermaid).digest("hex").slice(0, 12);
	const base = `${slugify(model.workflow.name)}-${pathHash}-${sourceHash}`;
	const mmdPath = path.join(root, `${base}.mmd`);
	const pngPath = path.join(root, `${base}.png`);
	await fs.writeFile(mmdPath, mermaid, "utf8");

	const invocation = resolveMmdcInvocation(ctx.cwd);
	const imageOptions = workflowGraphImageOptions(model);
	const args = [
		...invocation.argsPrefix,
		"-q",
		"-i",
		mmdPath,
		"-o",
		pngPath,
		"-e",
		"png",
		"-t",
		"dark",
		"-b",
		"transparent",
		"-w",
		String(imageOptions.width),
		"-H",
		String(imageOptions.height),
		"-s",
		String(imageOptions.scale),
	];
	const started = Date.now();
	const result = await runProcess(invocation.command, args, { cwd: ctx.cwd, timeoutMs: 60_000 });
	if (!result.ok) return { warning: formatMmdcFailure(invocation.display, result) };
	try {
		const base64 = await fs.readFile(pngPath, "base64");
		return {
			image: {
				base64,
				pngPath,
				mmdPath,
				command: invocation.display,
				elapsedMs: Date.now() - started,
				width: imageOptions.width,
				height: imageOptions.height,
				scale: imageOptions.scale,
			},
		};
	} catch (err) {
		return {
			warning: `mmdc reported success but the PNG could not be read: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
