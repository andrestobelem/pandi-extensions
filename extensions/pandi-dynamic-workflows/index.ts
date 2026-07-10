/**
 * Workflows dinámicos estilo Claude para Pi.
 *
 * Esta extensión añade:
 * - herramienta `dynamic_workflow` para que el modelo liste/lea/escriba/ejecute scripts de workflows
 * - comandos `/workflow` y `/workflows` para usuarios
 * - comandos de enrutamiento `/dynamic-workflow` y `/deep-research`
 * - un pequeño motor de ejecución de workflows JavaScript con subagentes Pi paralelos y artifacts
 *
 * Los workflows son código de confianza. Se ejecutan dentro del proceso Pi (no en una
 * caja de arena de seguridad) y pueden consumir llamadas de modelo creando subagentes.
 */

export { dynamicWorkflowsExtension as default } from "./workflow-extension-activation.js";
export * from "./workflow-public-api.js";
