import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_DOCTOR_TIMEOUT_MS,
	parseTimeoutMs,
	resolveHostPiCommand,
	runDoctor,
	runDoctorCheck,
} from "./doctor.js";
import { notify } from "./notify.js";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export function registerDoctorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("doctor", {
		description: "Ejecuta el chequeo de entorno de `pandi-extensions` (`scripts/doctor.mjs`) y muestra el reporte",
		handler: async (_args, ctx) => {
			const hostPiCommand = resolveHostPiCommand(getPackageDir());
			const result = await runDoctorCheck(runDoctor, {
				cwd: ctx.cwd,
				extDir: EXT_DIR,
				signal: ctx.signal ?? undefined,
				timeoutMs: parseTimeoutMs(process.env.PI_DOCTOR_TIMEOUT_MS, DEFAULT_DOCTOR_TIMEOUT_MS),
				agentDir: getAgentDir(),
				configDir: CONFIG_DIR_NAME,
				piCommand: hostPiCommand.command,
				piCommandArgs: hostPiCommand.args,
			});
			notify(ctx, result.text, result.type);
		},
	});
}
