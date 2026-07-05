#!/usr/bin/env node
/**
 * Unit tests for the PURE read-only-gate helpers in extensions/pandi-plan/gate.ts.
 *
 * The existing plan-gate.test.mjs drives the gate through the full extension + tool
 * events; this suite pins the pure decision logic directly (isMutatingBash, blockedReason,
 * and the read-only dynamic_workflow allowlist) so the security-critical classification is
 * covered at the cheapest level. Gaps surfaced by the coverage audit:
 *   - isMutatingBash: git mutations incl. `git branch -D` and plain `git branch <name>` creation.
 *   - blockedReason: write/edit blocked; read/grep allowed; bash blocked only when mutating;
 *     dynamic_workflow blocked unless its action is read-only; submit_plan/enter_plan_mode allowed.
 *
 * Run it:
 *   node extensions/pandi-plan/tests/integration/plan-gate-helpers.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function scenarioGateHelpers(url) {
	const { isMutatingBash, blockedReason, MUTATING_BASH_PATTERNS, DYNAMIC_WORKFLOW_READONLY_ACTIONS } =
		await loadModule(url);

	// --- isMutatingBash: mutations the gate MUST catch ---
	const mutating = [
		"touch a",
		"mkdir x",
		"rm -rf node_modules",
		"mv a b",
		"cp a b",
		"sed -i 's/a/b/' f",
		"echo hi > f",
		"echo hi >> f",
		"git commit -m wip",
		"git push",
		"git reset --hard",
		"git checkout main",
		"git rebase -i HEAD~2",
		"git stash",
		"git branch -D feat",
		"git branch -d feat",
		"git branch feat",
		"git pull",
		"git clone https://example.com/x.git",
		"git fetch origin",
		"npm install",
		"pnpm add lodash",
		"yarn ci",
		"npm uninstall lodash",
		"npm update",
		"pnpm remove x",
		"yarn upgrade",
		"npx -y cowsay hi",
		"pip install requests",
		"make build",
		"kubectl apply -f x.yaml",
		"terraform apply",
		"helm upgrade r c",
	];
	for (const cmd of mutating) check(`isMutatingBash blocks: ${cmd}`, isMutatingBash(cmd) === true, cmd);

	// --- isMutatingBash: read-only commands it must NOT flag ---
	const readOnly = [
		"git ls-files",
		"git status",
		"git log --oneline",
		"git branch",
		"git branch --list feat",
		"git diff",
		"cat file.txt",
		"grep -rn foo .",
		'grep -rn "len(x) > 0" .',
		"ls -la",
		"echo 2>&1", // fd-dup, not a file redirect
		"node --version",
		"rg pattern",
	];
	for (const cmd of readOnly) check(`isMutatingBash allows: ${cmd}`, isMutatingBash(cmd) === false, cmd);

	check(
		"MUTATING_BASH_PATTERNS is a non-empty RegExp array",
		Array.isArray(MUTATING_BASH_PATTERNS) &&
			MUTATING_BASH_PATTERNS.length > 0 &&
			MUTATING_BASH_PATTERNS.every((r) => r instanceof RegExp),
	);

	// --- blockedReason: structured built-ins ---
	const ev = (toolName, input = {}) => ({ toolName, input });
	check("blockedReason blocks write", typeof blockedReason(ev("write", { path: "a", content: "x" })) === "string");
	check("blockedReason blocks edit", typeof blockedReason(ev("edit")) === "string");
	check("blockedReason blocks notebook-edit (defensive)", typeof blockedReason(ev("notebook-edit")) === "string");
	check("blockedReason allows read", blockedReason(ev("read", { path: "a" })) === undefined);
	check("blockedReason allows grep", blockedReason(ev("grep")) === undefined);
	check("blockedReason allows submit_plan", blockedReason(ev("submit_plan")) === undefined);
	check("blockedReason allows enter_plan_mode", blockedReason(ev("enter_plan_mode")) === undefined);

	// --- blockedReason: bash depends on the command ---
	check("blockedReason allows read-only bash", blockedReason(ev("bash", { command: "git status" })) === undefined);
	check("blockedReason blocks mutating bash", typeof blockedReason(ev("bash", { command: "rm -rf x" })) === "string");
	check(
		"blockedReason allows bash with non-string command",
		blockedReason(ev("bash", { command: 123 })) === undefined,
	);

	// --- blockedReason: dynamic_workflow read-only allowlist ---
	for (const action of ["list", "scaffold", "read", "graph", "runs", "view"]) {
		check(
			`blockedReason allows dynamic_workflow ${action}`,
			blockedReason(ev("dynamic_workflow", { action })) === undefined,
			action,
		);
		check(`DYNAMIC_WORKFLOW_READONLY_ACTIONS has ${action}`, DYNAMIC_WORKFLOW_READONLY_ACTIONS.has(action));
	}
	for (const action of ["run", "start", "resume", "write", "cancel", "delete"]) {
		check(
			`blockedReason blocks dynamic_workflow ${action}`,
			typeof blockedReason(ev("dynamic_workflow", { action })) === "string",
			action,
		);
	}
	check(
		"blockedReason blocks dynamic_workflow with missing action",
		typeof blockedReason(ev("dynamic_workflow", {})) === "string",
	);

	// --- blockedReason: unknown tool falls through (allowed, best-effort) ---
	check("blockedReason allows an unknown tool", blockedReason(ev("some_other_tool")) === undefined);
}

async function main() {
	const built = await buildExtension({
		name: "pi-plan-gate-helpers",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "gate.ts"),
		outName: "gate.mjs",
	});
	try {
		await scenarioGateHelpers(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

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
