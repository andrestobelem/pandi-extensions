/**
 * Flujos de trabajo dinámicos estilo Claude para Pi.
 *
 * Esta extensión añade:
 * - herramienta `dynamic_workflow` para que el modelo liste/lea/escriba/ejecute scripts de flujos de trabajo
 * - comandos `/workflow` y `/workflows` para usuarios
 * - comandos de enrutamiento `/dynamic-workflow` y `/deep-research`
 * - un pequeño motor de ejecución de flujos de trabajo JavaScript con subagentes Pi paralelos y artefactos
 *
 * Los flujos de trabajo son código de confianza. Se ejecutan dentro del proceso Pi (no en una
 * caja de arena de seguridad) y pueden consumir llamadas de modelo creando subagentes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { activateDynamicWorkflowsExtension } from "./workflow-extension-activation.js";

export * from "./workflow-public-api.js";

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	activateDynamicWorkflowsExtension(pi);
}
