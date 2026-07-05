// pandi-auto-compact recoverable-compaction snapshots: the raw entries about to be
// summarized are persisted BEFORE the lossy summary replaces them, so compaction is
// recoverable rather than destructive. Snapshots live under <cwd>/<configDir>/<SNAPSHOT_DIR>/
// <sessionId>/ (gitignored) — deliberately NOT in the memory folder, which is for curated,
// injected facts, not bulky raw transcripts. Pure path/shape/prune helpers; re-exported
// from index.ts so the built bundle keeps exporting the names the integration suite uses.

import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const SNAPSHOT_DIR = "compaction-snapshots";

// Replace anything outside a safe file-name set so a session id / timestamp / reason
// can never escape the snapshot directory. Leading/trailing `._-` are trimmed and an
// all-dots result (e.g. "." or "..", which would traverse) falls back to `fallback`.
const safeSegment = (raw: string, fallback: string): string => {
	const cleaned = (raw ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
	return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
};

/** Per-session snapshot directory: <cwd>/<configDir>/compaction-snapshots/<sessionId>/. Pure. */
export const snapshotDirFor = (cwd: string, sessionId: string): string =>
	join(cwd, CONFIG_DIR_NAME, SNAPSHOT_DIR, safeSegment(sessionId, "session"));

/** Snapshot file name. Timestamp-prefixed so a lexicographic sort is chronological. Pure. */
export const snapshotFileName = (createdAtIso: string, reason: string): string =>
	`${safeSegment(createdAtIso, "snapshot")}-${safeSegment(reason, "compact")}.json`;

export interface CompactionSnapshot {
	version: 1;
	sessionId: string;
	createdAt: string;
	reason: string;
	willRetry: boolean;
	entryCount: number;
	entries: unknown[];
	/** The lossy summary that replaced `entries`, patched in after compaction completes. */
	summary?: string;
}

/** Build the serializable snapshot object from the raw entries being compacted. Pure. */
export const buildSnapshot = (opts: {
	sessionId: string;
	createdAt: string;
	reason: string;
	willRetry: boolean;
	entries: unknown[];
}): CompactionSnapshot => {
	const entries = Array.isArray(opts.entries) ? opts.entries : [];
	return {
		version: 1,
		sessionId: opts.sessionId,
		createdAt: opts.createdAt,
		reason: opts.reason,
		willRetry: opts.willRetry,
		entryCount: entries.length,
		entries,
	};
};

// Given snapshot file names (any order), return the OLDEST beyond `keep`. Names are
// timestamp-prefixed so a lexicographic sort is chronological. keep<=0 prunes all.
// The snapshot files in a directory listing: .json only, oldest-first (lexical sort ==
// chronological since names are timestamp-prefixed). Shared by prune selection and the
// `snapshots` listing so both define "a snapshot file" identically.
export const sortedSnapshotNames = (fileNames: string[]): string[] =>
	fileNames.filter((n) => n.endsWith(".json")).sort();

export const selectSnapshotsToPrune = (fileNames: string[], keep: number): string[] => {
	const snaps = sortedSnapshotNames(fileNames);
	if (keep <= 0) return snaps;
	return snaps.slice(0, Math.max(0, snaps.length - keep));
};
