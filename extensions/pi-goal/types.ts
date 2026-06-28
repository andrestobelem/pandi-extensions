/**
 * Shared type declarations for the `/goal` extension.
 *
 * Pure type/interface declarations extracted from index.ts (zero runtime). The goal
 * state machine, scheduling, persistence, and verifier that USE these types stay in
 * index.ts; this module is an import-free leaf so any sibling can depend on it.
 */

export type GoalStatus = "pursuing" | "verifying" | "verifying-independent" | "done" | "blocked" | "stopped" | "stale";
export type GoalDecision = "continue" | "done" | "blocked";

export interface GoalAssessment {
	iteration: number;
	status: GoalDecision;
	assessment: string;
	nextStep?: string;
	at: string;
}

export interface GoalState {
	goalId: string;
	objective: string;
	/** Success criteria supplied by the user via `-- <criteria>`, if any. */
	successCriteria?: string;
	/** Criteria DERIVED by the model in iteration 1 when the user gave none (S2). */
	derivedCriteria?: string;
	iteration: number;
	maxIterations: number;
	/** Best-effort context-usage percent cap. */
	contextPercentCap: number;
	/** Bounded history of self-assessments (sliced to PROGRESS_LOG_KEEP at persist). */
	assessments: GoalAssessment[];
	/** Count of completeness checks that FAILED (verifying → continue). Caps verify ping-pong. */
	verifyAttempts: number;
	/** P1: count of INDEPENDENT verifications that returned FAIL. Caps the independent ping-pong. */
	independentVerifyAttempts: number;
	/** P1: max FAILED independent verifications tolerated before blocking (config, default 2). */
	maxIndependentVerifications: number;
	/** P1: wall-clock budget (ms) for one independent verification subagent (config). */
	verifierTimeoutMs: number;
	/** P1: read-only tools handed to the verifier subagent (config). */
	verifierTools: string[];
	gstatus: GoalStatus;
	startedAt: number;
	nextFireAt: number | null;
	lastReason?: string;
	/** ISO timestamp of the last write; used to resolve JSONL-vs-sidecar conflicts. */
	updatedAt: string;
}

export interface ActiveGoal extends GoalState {
	timer: ReturnType<typeof setTimeout> | null;
	controller: AbortController;
	/** True once a wake was (re)armed in the current turn; reset on each fire. */
	rearmedThisTurn: boolean;
	/** P1: true while an independent verifier subagent is in flight (debounces re-launch). */
	verifierInFlight: boolean;
}
