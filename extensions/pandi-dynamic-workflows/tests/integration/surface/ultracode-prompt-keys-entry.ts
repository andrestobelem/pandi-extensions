/**
 * Entry de harness: reexporta prompts ultracode + la línea canónica de keys sin
 * arrastrar surface/index ni el resto del paquete.
 */

export { formatWorkflowPatternKeyList } from "../../../surface/pattern-format.js";
export { makeAlwaysOnUltracodeSystemPrompt, makeUltracodePrompt } from "../../../ultracode/router.js";
