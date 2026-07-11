#!/usr/bin/env node
/**
 * Unit tests for the PURE read-only-gate helpers in extensions/pandi-plan/gate.ts.
 *
 * The existing plan-gate.test.mjs drives the gate through the full extension + tool
 * events; this suite pins the pure decision logic directly (isMutatingBash, blockedReason,
 * and the read-only dynamic_workflow allowlist) so the security-critical classification is
 * covered at the cheapest level. Gaps surfaced by the coverage audit:
 *   - isMutatingBash: git mutations incl. `git branch -D` and plain `git branch <name>` creation.
 *   - blockedReason: write/edit and unknown tools blocked; known read-only tools allowed;
 *     bash blocked only when mutating; dynamic_workflow blocked unless its action is read-only;
 *     submit_plan/enter_plan_mode allowed.
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
		"git tag v1.2.3",
		"git pull",
		"git clone https://example.com/x.git",
		"git fetch origin",
		"git diff -- file && rm -rf x",
		"rg pattern | tee out.txt",
		"gh issue close 51 2>/dev/null",
		"gh project item-edit 4 --id X --field-id Y --single-select-option-id Z 2>/dev/null",
		"curl -o out.txt https://example.com/file.txt",
		"wget -O out.txt https://example.com/file.txt",
		'eval "rm -rf generated"',
		"printf 'generated\\n' | xargs rm",
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
		"git branch --show-current",
		"git diff",
		"git show --stat --oneline b8ae471 4a77745 2>/dev/null",
		"git diff -- extensions/pandi-dynamic-workflows/run-report-collector.ts .claude/scripts/lib/run-merge.mjs",
		"git tag --sort=-v:refname | sed -n '1,80p'",
		"cat file.txt",
		"grep -rn foo .",
		"grep -rln 'README.md' extensions/*/tests/integration/ scripts/ 2>/dev/null",
		'grep -rn "len(x) > 0" .',
		"ls -la",
		"wc -l AGENTS.md CLAUDE.md 2>/dev/null",
		"ls extensions/pandi-dynamic-workflows/scaffolds/ | wc -l && ls .claude/workflows 2>/dev/null | wc -l",
		"echo 2>&1", // fd-dup, not a file redirect
		"node --version",
		"rg pattern",
		"rg -ln \"expected|assert.*includes|match\" extensions/pandi-goal/tests/integration/goal-helpers.test.mjs extensions/pandi-plan/tests/integration --glob '*.mjs' --max-count 1",
		'rg "phaseTotal|phaseIndex|phaseId" -n extensions/pandi-dynamic-workflows .pi/workflows/runs 2>/dev/null | head -80',
		"gh issue view 51 --repo andrestobelem/pandi-extensions --json title,body,labels,state 2>/dev/null || true",
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
	for (const name of ["read", "grep", "rg", "glob", "find", "ls", "web_search", "ask_choice", "ask_confirm"]) {
		check(`blockedReason allows ${name}`, blockedReason(ev(name)) === undefined, name);
	}
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
	for (const action of ["list", "scaffold", "read", "check", "graph", "runs", "view"]) {
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

	// --- blockedReason: unknown tools are denied by default ---
	for (const name of ["some_mutating_tool", "mcp__unknown__mutate"]) {
		const reason = blockedReason(ev(name));
		check(
			`blockedReason blocks unknown tool ${name}`,
			typeof reason === "string" && reason.includes(name) && /solo lectura/i.test(reason),
			reason,
		);
	}
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
