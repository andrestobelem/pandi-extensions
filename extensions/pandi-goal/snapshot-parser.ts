import {
	DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
	DEFAULT_VERIFIER_TIMEOUT_MS,
	DEFAULT_VERIFIER_TOOLS,
} from "./constants.js";
import type { GoalAssessment, GoalDecision, GoalState, GoalStatus } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "pursuing" ||
		value === "verifying" ||
		value === "verifying-independent" ||
		value === "done" ||
		value === "blocked" ||
		value === "stopped" ||
		value === "stale"
	);
}

function isGoalDecision(value: unknown): value is GoalDecision {
	return value === "continue" || value === "done" || value === "blocked";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return isNonNegativeInteger(value) && value > 0;
}

function isContextPercentCap(value: unknown): value is number {
	return isPositiveInteger(value) && value <= 100;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function decodeTimestamp(value: unknown): number | undefined {
	if (isFiniteNumber(value)) return value;
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isTimestampString(value: unknown): value is string {
	return isNonBlankString(value) && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === "boolean";
}

function decodeAssessment(value: unknown): GoalAssessment | undefined {
	if (!isRecord(value)) return undefined;
	if (!isNonNegativeInteger(value.iteration) || !isGoalDecision(value.status)) return undefined;
	if (typeof value.assessment !== "string" || !isOptionalString(value.nextStep) || typeof value.at !== "string") {
		return undefined;
	}
	const assessment: GoalAssessment = {
		iteration: value.iteration,
		status: value.status,
		assessment: value.assessment,
		at: value.at,
	};
	if (value.nextStep !== undefined) assessment.nextStep = value.nextStep;
	return assessment;
}

function decodeAssessments(value: unknown): GoalAssessment[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const assessments: GoalAssessment[] = [];
	for (const item of value) {
		const assessment = decodeAssessment(item);
		if (!assessment) return undefined;
		assessments.push(assessment);
	}
	return assessments;
}

function decodeVerifierTools(value: unknown): string[] | undefined {
	if (value === undefined) return [...DEFAULT_VERIFIER_TOOLS];
	if (
		!Array.isArray(value) ||
		!value.every(
			(tool): tool is string =>
				typeof tool === "string" && (DEFAULT_VERIFIER_TOOLS as readonly string[]).includes(tool),
		)
	) {
		return undefined;
	}
	return [...value];
}

/** Extrae identidad antes de decodificar para que un último snapshot inválido retire al anterior. */
export function persistedGoalStateId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.goalId === "string" ? value.goalId : undefined;
}

/** Decodifica y normaliza solamente la frontera JSONL; el estado runtime recibe una shape válida. */
export function decodeGoalStateSnapshot(value: unknown): GoalState | undefined {
	if (!isRecord(value)) return undefined;
	if (!isNonBlankString(value.goalId) || !isNonBlankString(value.objective)) return undefined;
	if (!isOptionalString(value.successCriteria) || !isOptionalString(value.derivedCriteria)) return undefined;
	if (!isOptionalBoolean(value.ultracode) || !isOptionalString(value.lastReason)) return undefined;
	if (!isNonNegativeInteger(value.iteration) || !isPositiveInteger(value.maxIterations)) return undefined;
	if (!isContextPercentCap(value.contextPercentCap) || !isGoalStatus(value.gstatus)) return undefined;

	const assessments = decodeAssessments(value.assessments);
	const verifierTools = decodeVerifierTools(value.verifierTools);
	if (!assessments || !verifierTools) return undefined;

	const verifyAttempts = value.verifyAttempts === undefined ? 0 : value.verifyAttempts;
	const independentVerifyAttempts =
		value.independentVerifyAttempts === undefined ? 0 : value.independentVerifyAttempts;
	const maxIndependentVerifications =
		value.maxIndependentVerifications === undefined
			? DEFAULT_MAX_INDEPENDENT_VERIFICATIONS
			: value.maxIndependentVerifications;
	const verifierTimeoutMs =
		value.verifierTimeoutMs === undefined ? DEFAULT_VERIFIER_TIMEOUT_MS : value.verifierTimeoutMs;
	if (!isNonNegativeInteger(verifyAttempts) || !isNonNegativeInteger(independentVerifyAttempts)) return undefined;
	if (!isPositiveInteger(maxIndependentVerifications) || !isPositiveInteger(verifierTimeoutMs)) return undefined;

	const startedAt = decodeTimestamp(value.startedAt);
	if (startedAt === undefined) return undefined;
	if (value.nextFireAt !== null && !isFiniteNumber(value.nextFireAt)) return undefined;
	if (!isTimestampString(value.updatedAt)) return undefined;

	const state: GoalState = {
		goalId: value.goalId,
		objective: value.objective,
		iteration: value.iteration,
		maxIterations: value.maxIterations,
		contextPercentCap: value.contextPercentCap,
		assessments,
		verifyAttempts,
		independentVerifyAttempts,
		maxIndependentVerifications,
		verifierTimeoutMs,
		verifierTools,
		gstatus: value.gstatus,
		startedAt,
		nextFireAt: value.nextFireAt,
		updatedAt: value.updatedAt,
	};
	if (value.successCriteria !== undefined) state.successCriteria = value.successCriteria;
	if (value.derivedCriteria !== undefined) state.derivedCriteria = value.derivedCriteria;
	if (value.ultracode !== undefined) state.ultracode = value.ultracode;
	if (value.lastReason !== undefined) state.lastReason = value.lastReason;
	return state;
}
