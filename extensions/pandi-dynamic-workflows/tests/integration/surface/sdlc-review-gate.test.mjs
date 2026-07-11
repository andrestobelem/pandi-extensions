import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test, { before } from "node:test";
import * as vm from "node:vm";

import { buildDwfExtension, REPO_ROOT } from "../dwf-test-support.mjs";

const WORKFLOW_PATH = path.join(REPO_ROOT, ".pi", "workflows", "sdlc.js");
const blockingFinding = (file) => ({
	severity: "blocking",
	file,
	line: `${file}:1`,
	rationale: `bloqueo en ${file}`,
	suggestedFix: `corregir ${file}`,
});

let compiledWorkflow;

before(async () => {
	const [{ url }, source] = await Promise.all([
		buildDwfExtension({ name: "pi-dwf-sdlc-review-gate" }),
		fs.readFile(WORKFLOW_PATH, "utf8"),
	]);
	const mod = await import(url);
	compiledWorkflow = mod.transformWorkflowCode(source);
});

function loadWorkflow(globals) {
	const module = { exports: {} };
	const context = vm.createContext({ module, exports: module.exports, ...globals });
	vm.runInContext(compiledWorkflow, context, { filename: ".pi/workflows/sdlc.js", timeout: 1000 });
	return module.exports;
}

async function runScenario({ findings, fixResult }) {
	const logs = [];
	const artifacts = new Map();
	const understanding = {
		authOk: true,
		issueFound: true,
		issueOpen: true,
		title: "P1-08",
		acceptanceCriteria: ["el waiver no resuelve un finding blocking"],
		criteriaSource: "issue-explicit",
		relevantFiles: [{ path: ".pi/workflows/sdlc.js", why: "contiene el gate" }],
		failReason: "",
		summary: "fixture",
	};
	const plan = {
		isDocOnly: false,
		pinningCheckDescription: "gate de revisión",
		pinningCheckCommand: "node --test sdlc-review-gate.test.mjs",
		filesToTouch: [".pi/workflows/sdlc.js"],
		doNotTouch: [],
		commitMessage: "fix(sdlc): keep waived blockers unresolved\n\nCloses #108",
		redGreenNarrative: "RED/GREEN",
	};
	const implementResult = {
		redEvidence: "1 test failed",
		greenEvidence: "3 tests passed",
		refactorNarration: "Nada que cambiar.",
		filesChanged: [".pi/workflows/sdlc.js"],
		green: true,
	};
	const agent = async (_prompt, options) => {
		switch (options?.label) {
			case "understand":
				return understanding;
			case "planner":
				return plan;
			case "implementer":
				return implementResult;
			case "fixer":
				return fixResult;
			default:
				throw new Error(`agent inesperado: ${options?.label}`);
		}
	};
	const agents = async (specs) =>
		specs.map((_, index) => {
			const reviewerFindings = findings[index] ?? [];
			return {
				data: {
					verdict: reviewerFindings.some((finding) => finding.severity === "blocking") ? "block" : "approve",
					findings: reviewerFindings,
					summary: reviewerFindings.length ? "hay findings" : "sin findings",
				},
			};
		});
	const bash = async (command) => {
		if (command === "git rev-parse HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
		if (command.startsWith("git diff --")) return { code: 0, stdout: "diff --git a/sdlc.js b/sdlc.js\n", stderr: "" };
		if (/^git (add|commit)\b/.test(command)) throw new Error(`mutación inesperada: ${command}`);
		return { code: 0, stdout: "", stderr: "" };
	};
	const workflow = loadWorkflow({
		args: { issue: 108, markInProgress: false, reviewers: 2 },
		limits: { concurrency: 2 },
		runDir: "/tmp/sdlc-review-gate",
		agent,
		agents,
		bash,
		phase: () => {},
		log: (...parts) => logs.push(parts.map(String).join(" ")),
		writeArtifact: async (name, value) => artifacts.set(name, value),
		writeFile: async () => {},
		ask: async () => false,
	});

	return { result: await workflow(), logs, artifacts };
}

test("un finding blocking solo waived mantiene canCommit=false", async () => {
	const { result, logs, artifacts } = await runScenario({
		findings: [[blockingFinding("waived.js")], []],
		fixResult: {
			addressed: [],
			waived: [{ id: "f1", justification: "riesgo aceptable" }],
			greenAfterFix: true,
			reGreenEvidence: "ok",
		},
	});

	assert.equal(result.phases.commit.canCommit, false);
	assert.equal(result.phases.review.waivedBlocking.map((finding) => finding.id).join(","), "f1");
	assert.equal(result.phases.review.unresolvedBlocking.map((finding) => finding.id).join(","), "f1");
	assert.match(artifacts.get("commit-decision.md"), /aprobación independiente/i);
	assert.ok(logs.some((line) => /waivedBlocking|dispensados.*bloqueando/i.test(line)));
});

test("un finding blocking addressed puede dejar reviewGreen=true", async () => {
	const { result } = await runScenario({
		findings: [[blockingFinding("addressed.js")], []],
		fixResult: {
			addressed: [{ id: "f1", resolution: "corregido" }],
			waived: [],
			greenAfterFix: true,
			reGreenEvidence: "ok",
		},
	});

	assert.equal(result.phases.commit.canCommit, true);
	assert.equal(result.phases.review.waivedBlocking.length, 0);
	assert.equal(result.phases.review.unresolvedBlocking.length, 0);
	assert.match(result.phases.commit.commitDecisionMd, /reviewGreen=true/);
});

test("una mezcla addressed/waived conserva el waived como bloqueo", async () => {
	const { result } = await runScenario({
		findings: [[blockingFinding("addressed.js"), blockingFinding("waived.js")], []],
		fixResult: {
			addressed: [{ id: "f1", resolution: "corregido" }],
			waived: [{ id: "f2", justification: "riesgo aceptable" }],
			greenAfterFix: true,
			reGreenEvidence: "ok",
		},
	});

	assert.equal(result.phases.commit.canCommit, false);
	assert.equal(result.phases.review.waivedBlocking.map((finding) => finding.id).join(","), "f2");
	assert.equal(result.phases.review.unresolvedBlocking.map((finding) => finding.id).join(","), "f2");
	assert.match(result.phases.commit.commitDecisionMd, /reviewGreen=false/);
});
