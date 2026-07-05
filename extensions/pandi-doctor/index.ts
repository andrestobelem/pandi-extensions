/**
 * pi-doctor — un comando `/doctor` liviano dentro de la sesión que corre el chequeo
 * read-only de entorno del repo (`scripts/doctor.mjs`) y muestra el reporte.
 *
 * Es un wrapper de conveniencia sobre `npm run doctor`: ubica `scripts/doctor.mjs`
 * (subiendo desde el cwd de la sesión y, si no, con un fallback relativo a la
 * extensión) y le hace spawn con `node` (argv, nunca shell). NO importa el script
 * — eso rompería la carga independiente — así que fuera del repo se degrada a una
 * sugerencia amigable.
 *
 * Los helpers puros + el punto de inyección del spawn viven en `./doctor.ts` y se
 * reexportan para que la suite de integración los maneje con un runner falso inyectado.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDoctor, runDoctorCheck } from "./doctor.js";
import { notify } from "./notify.js";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export type { DoctorResult, RunDoctor, RunDoctorOptions } from "./doctor.js";
// Reexportado para que la suite de integración pueda probar unitariamente los helpers puros + el punto de inyección.
export { formatDoctorOutput, resolveDoctorScript, runDoctor, runDoctorCheck } from "./doctor.js";

export default function doctorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("doctor", {
		description: "Ejecuta el chequeo de entorno de pandi-extensions (scripts/doctor.mjs) y muestra el reporte",
		handler: async (_args, ctx) => {
			const result = await runDoctorCheck(runDoctor, { cwd: process.cwd(), extDir: EXT_DIR });
			notify(ctx, result.text, result.type);
		},
	});
}
