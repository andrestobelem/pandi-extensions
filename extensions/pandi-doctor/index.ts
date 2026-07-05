/**
 * pi-doctor — a thin in-session `/doctor` command that runs the repo's read-only
 * environment check (scripts/doctor.mjs) and shows the report.
 *
 * It is a convenience wrapper around `npm run doctor`: it locates scripts/doctor.mjs
 * (walking up from the session cwd, then an extension-relative fallback) and spawns
 * `node` on it (argv, never a shell). It does NOT import the script — that would
 * break standalone loading — so outside the repo it degrades to a friendly hint.
 *
 * Pure helpers + the spawn seam live in ./doctor.ts and are re-exported so the
 * integration suite can drive them with an injected fake runner.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDoctor, runDoctorCheck } from "./doctor.js";
import { notify } from "./notify.js";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export type { DoctorResult, RunDoctor, RunDoctorOptions } from "./doctor.js";
// Re-exported so the integration suite can unit-test the pure helpers + the seam.
export { formatDoctorOutput, resolveDoctorScript, runDoctor, runDoctorCheck } from "./doctor.js";

export default function doctorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("doctor", {
		description: "Run the pandi-extensions environment check (scripts/doctor.mjs) and show the report",
		handler: async (_args, ctx) => {
			const result = await runDoctorCheck(runDoctor, { cwd: process.cwd(), extDir: EXT_DIR });
			notify(ctx, result.text, result.type);
		},
	});
}
