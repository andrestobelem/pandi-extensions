import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_SESSION_HEARTBEAT_MS = 5_000;
// Período de gracia tras SIGTERM antes de escalar a SIGKILL para procesos hijo creados.
export const PROCESS_KILL_GRACE_MS = 2_000;
export const MAX_AGENT_OUTPUT_IN_RESULT = 24_000;

/** Root del paquete de extensión, usado para resolver bins vendorizados. */
export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runs resumibles: diario de cache content-address.
export const JOURNAL_FILE = "journal.jsonl";
// Mantiene stdout/stderr en el journal por debajo del límite de resultado de tool.
export const MAX_JOURNALED_STREAM = 200_000;
