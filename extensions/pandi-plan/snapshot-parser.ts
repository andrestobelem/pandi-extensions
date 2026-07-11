import type { PlanState, PlanStatus } from "./state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPlanStatus(value: unknown): value is PlanStatus {
	return (
		value === "planning" || value === "approved" || value === "rejected" || value === "exited" || value === "planned"
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
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

/** Extrae identidad antes de decodificar para preservar last-wins incluso si el último snapshot es inválido. */
export function persistedPlanStateId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.planId === "string" ? value.planId : undefined;
}

/** Decodifica una entrada JSONL a estado interno; cualquier shape inválido se ignora fail-safe. */
export function decodePlanStateSnapshot(value: unknown): PlanState | undefined {
	if (!isRecord(value)) return undefined;
	if (!isNonBlankString(value.planId) || !isNonBlankString(value.task)) return undefined;
	if (typeof value.active !== "boolean" || !isPlanStatus(value.status)) return undefined;
	if (!isNonNegativeInteger(value.submissions) || !isNonNegativeInteger(value.rejections)) return undefined;
	if (!isFiniteNumber(value.startedAt) || !isTimestampString(value.updatedAt)) return undefined;
	if (!isOptionalString(value.lastPlan)) return undefined;
	if (!isOptionalBoolean(value.nonInteractive)) return undefined;
	if (!isOptionalBoolean(value.ultracode)) return undefined;
	if (!isOptionalBoolean(value.ultracodeSteps)) return undefined;
	if (!isOptionalBoolean(value.autoSubmit)) return undefined;

	const state: PlanState = {
		planId: value.planId,
		task: value.task,
		active: value.active,
		status: value.status,
		submissions: value.submissions,
		rejections: value.rejections,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
	};
	if (value.lastPlan !== undefined) state.lastPlan = value.lastPlan;
	if (value.nonInteractive !== undefined) state.nonInteractive = value.nonInteractive;
	if (value.ultracode !== undefined) state.ultracode = value.ultracode;
	if (value.ultracodeSteps !== undefined) state.ultracodeSteps = value.ultracodeSteps;
	if (value.autoSubmit !== undefined) state.autoSubmit = value.autoSubmit;
	return state;
}
