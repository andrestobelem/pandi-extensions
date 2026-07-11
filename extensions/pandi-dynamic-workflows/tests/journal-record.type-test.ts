import { makeJournalRecord } from "../runtime/journal.js";
import type { AskResult, BashResult, JournalRecord, SubagentResult } from "../types.js";

declare const agentResult: SubagentResult;
declare const bashResult: BashResult;
declare const askResult: AskResult;

const persistedFields = {
	v: 4,
	key: "call-key",
	occ: 0,
	codeHash: "code-hash",
	ts: "2026-07-11T00:00:00.000Z",
} as const;

const inputFields = {
	key: persistedFields.key,
	occ: persistedFields.occ,
	codeHash: persistedFields.codeHash,
} as const;

const validAgent = { ...persistedFields, method: "agent", result: agentResult } satisfies JournalRecord;
const validBash = { ...persistedFields, method: "bash", result: bashResult } satisfies JournalRecord;
const validAsk = { ...persistedFields, method: "ask", result: askResult } satisfies JournalRecord;

// @ts-expect-error method agent solo admite SubagentResult.
const invalidAgent: JournalRecord = { ...persistedFields, method: "agent", result: bashResult };
// @ts-expect-error method bash solo admite BashResult.
const invalidBash: JournalRecord = { ...persistedFields, method: "bash", result: askResult };
// @ts-expect-error method ask solo admite AskResult.
const invalidAsk: JournalRecord = { ...persistedFields, method: "ask", result: agentResult };

const madeAgent = makeJournalRecord({ ...inputFields, method: "agent", result: agentResult });
const madeBash = makeJournalRecord({ ...inputFields, method: "bash", result: bashResult });
const madeAsk = makeJournalRecord({ ...inputFields, method: "ask", result: askResult });

const inferredAgentResult: SubagentResult = madeAgent.result;
const inferredBashResult: BashResult = madeBash.result;
const inferredAskResult: AskResult = madeAsk.result;

// @ts-expect-error makeJournalRecord preserva la correlación entre method y result.
makeJournalRecord({ ...inputFields, method: "agent", result: askResult });

void [
	validAgent,
	validBash,
	validAsk,
	invalidAgent,
	invalidBash,
	invalidAsk,
	inferredAgentResult,
	inferredBashResult,
	inferredAskResult,
];
