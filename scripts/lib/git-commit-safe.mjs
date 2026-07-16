import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ejecuta un hook versionado; falla cerrado si el hook no pasa. */
export function runGitHook(root, hookPath, ...hookArgs) {
	const result = spawnSync("sh", [hookPath, ...hookArgs], {
		cwd: root,
		encoding: "utf8",
		stdio: "pipe",
	});
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	if ((result.status ?? 1) !== 0) {
		throw new Error(`${hookPath} failed (exit ${result.status ?? 1}):\n${output}`);
	}
	return output;
}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	if ((result.status ?? 1) !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${result.status ?? 1}):\n${output}`);
	}
	return (result.stdout || "").trim();
}

/**
 * Crea un commit con commit-tree para evitar trailers Co-authored-by que algunos
 * hosts inyectan en `git commit`. Corre pre-commit y commit-msg antes de escribir.
 */
export function createVerifiedCommit({ root, message, parent = "HEAD", hooksDir = "scripts/git-hooks" }) {
	const msgFileDir = mkdtempSync(join(tmpdir(), "git-commit-msg-"));
	const msgFile = join(msgFileDir, "COMMIT_MSG");
	const normalized = message.endsWith("\n") ? message : `${message}\n`;
	try {
		writeFileSync(msgFile, normalized, "utf8");
		runGitHook(root, join(root, hooksDir, "pre-commit"));
		runGitHook(root, join(root, hooksDir, "commit-msg"), msgFile);

		const tree = git(root, ["write-tree"]);
		const parentSha = git(root, ["rev-parse", parent]);
		return git(root, ["commit-tree", tree, "-F", msgFile, "-p", parentSha]);
	} finally {
		rmSync(msgFileDir, { recursive: true, force: true });
	}
}

export function updateGitRef(root, ref, commitSha) {
	git(root, ["update-ref", ref, commitSha]);
}
