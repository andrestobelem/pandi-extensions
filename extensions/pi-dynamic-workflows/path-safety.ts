/**
 * Path safety — containment checks + resolution that keep agent file access sandboxed inside a
 * run/cwd root, rejecting path escapes (including through symlinks via realpath). A pure leaf used
 * by the engine (agent cwd + artifact paths) and workflow-resolve.ts. Extracted byte-identically.
 */
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

function isInsidePath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

export function resolveInsideRoot(
	rootInput: string,
	resolvedInput: string,
	displayPath: string,
	label: string,
): string {
	const root = path.resolve(rootInput);
	const resolved = path.resolve(resolvedInput);
	if (!isInsidePath(root, resolved)) throw new Error(`Path escapes ${label}: ${displayPath}`);

	const realRoot = realpathSync(root);
	let existing = resolved;
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	const realExisting = realpathSync(existing);
	if (!isInsidePath(realRoot, realExisting)) throw new Error(`Path escapes ${label} through symlink: ${displayPath}`);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function resolveCwdPath(cwd: string, filePath: string): string {
	const root = path.resolve(cwd);
	const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
	return resolveInsideRoot(root, resolved, filePath, "workflow cwd");
}

export function resolveArtifactPath(runDir: string, name: string): string {
	const normalized = name.trim().replaceAll("\\", "/");
	if (!normalized) throw new Error("Artifact name is required.");
	if (path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
		throw new Error("Artifact names must stay inside the workflow run directory.");
	}
	return resolveInsideRoot(runDir, path.join(runDir, normalized), normalized, "workflow run directory");
}
