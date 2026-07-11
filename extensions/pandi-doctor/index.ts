/**
 * pandi-doctor — un comando `/doctor` liviano dentro de la sesión que corre el chequeo
 * read-only de entorno del repo (`scripts/doctor.mjs`) y muestra el reporte.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDoctorCommand } from "./command-handler.js";

export type { DoctorResult, RunDoctor, RunDoctorOptions } from "./doctor.js";
export { formatDoctorOutput, parseTimeoutMs, resolveDoctorScript, runDoctor, runDoctorCheck } from "./doctor.js";

export default function doctorExtension(pi: ExtensionAPI): void {
	registerDoctorCommand(pi);
}
