/**
 * pandi-container: administra sandboxes de Apple `container` (micro-VMs Linux) desde Pi.
 *
 * Dos superficies (convención del proyecto; ver pandi-worktree):
 *   - `/container`          comando slash para personas (interactivo, confirma operaciones destructivas)
 *   - `container_sandbox`    tool invocable por el modelo (acciones explícitas, sin borrados sorpresa)
 *
 * Arquitectura modularizada:
 * - command-handler.ts — `/container`
 * - tool-handler.ts — `container_sandbox`
 * - handler-opts.ts / tool-results.ts — opciones y adaptadores compartidos
 *
 * Apple `container` ejecuta cada entorno Linux en su propia VM liviana
 * (Virtualization.framework) y requiere macOS en Apple Silicon, la CLI `container`
 * (`brew install container`), un kernel configurado y un subsistema iniciado.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContainerCommand } from "./command-handler.js";
import { registerContainerSandboxTool } from "./tool-handler.js";

export { parseContainerCommand, parseSizeFlag } from "./command.js";
export { CONTAINER_SELECT_ITEMS, completeContainerArgs, resolveContainerInput } from "./command-menu.js";
// Reexportado para que la suite de integración pueda probar unitariamente las utilidades puras + manejadores
// directamente contra el mismo bundle generado.
export {
	buildEphemeralRunArgs,
	buildMachineCreateArgs,
	buildMachineExecArgs,
	buildMachineListArgs,
	buildRemoveArgs,
	buildStatusArgs,
	buildStopArgs,
	describeMachine,
	describeTiers,
	formatMachineList,
	humanBytes,
	isSupportedPlatform,
	MACHINE_TIER_NAMES,
	parseMachineList,
	parseTimeoutMs,
	resolveSize,
	runContainer,
	runCreate,
	runExec,
	runList,
	runRemove,
	runStatus,
	runStop,
	TIER_NAMES,
	TIER_PRESETS,
	validateMachineName,
} from "./container.js";

export default function containerExtension(pi: ExtensionAPI): void {
	registerContainerCommand(pi);
	registerContainerSandboxTool(pi);
}
