/**
 * pandi-podman: superficie reducida de Podman para Pi.
 *
 * Dos superficies coherentes:
 *   - `/podman`       comando humano con selector y confirmación destructiva.
 *   - `podman_sandbox` tool explícita para el modelo, sin flags libres.
 *
 * Arquitectura modularizada:
 * - command-handler.ts — `/podman`
 * - tool-handler.ts — `podman_sandbox`
 * - handler-opts.ts / tool-results.ts — opciones y adaptadores compartidos
 *
 * La extensión es portable (Podman en Linux/macOS/Windows) pero en macOS y
 * Windows los contenedores viven dentro de una Podman machine. Por eso expone
 * solo listar/iniciar máquinas, nunca crear, parar ni borrar una VM.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPodmanCommand } from "./command-handler.js";
import { registerPodmanSandboxTool } from "./tool-handler.js";

export { parsePodmanCommand, parseRunOptions } from "./command.js";
export { completePodmanArgs, PODMAN_SELECT_ITEMS, resolvePodmanInput } from "./command-menu.js";
export {
	buildInfoArgs,
	buildListArgs,
	buildMachineListArgs,
	buildMachineStartArgs,
	buildRemoveArgs,
	buildRunArgs,
	buildStopArgs,
	describePodmanError,
	formatContainerList,
	formatMachineList,
	parseContainerList,
	parseInfo,
	parseMachineList,
	parseTimeoutMs,
	runList,
	runMachineList,
	runMachineStart,
	runPodman,
	runRemove,
	runSandbox,
	runStatus,
	runStop,
	validateContainerName,
	validateImageReference,
} from "./podman.js";

export default function podmanExtension(pi: ExtensionAPI): void {
	registerPodmanCommand(pi);
	registerPodmanSandboxTool(pi);
}
