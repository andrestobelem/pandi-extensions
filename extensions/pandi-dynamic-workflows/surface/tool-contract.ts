import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HARD_MAX_AGENTS, HARD_MAX_CONCURRENCY } from "../config.js";
import type { DynamicWorkflowAction } from "../types.js";
import { formatWorkflowCompositionPromptSummary, formatWorkflowPatternKeyList } from "./pattern-scaffolds.js";

export const TOOL_ACTIONS = [
	"list",
	"scaffold",
	"read",
	"check",
	"write",
	"run",
	"start",
	"resume",
	"cancel",
	"delete",
	"graph",
	"runs",
	"view",
	"report",
] as const satisfies readonly DynamicWorkflowAction[];
const WORKFLOW_SCOPE_INPUTS = ["auto", "project", "global"] as const;

export const workflowToolSchema = Type.Object({
	action: StringEnum(TOOL_ACTIONS, {
		description:
			"Operación de workflow a realizar: list/scaffold/read/check/write/run/start/resume/cancel/delete/graph/runs/view/report. check valida un workflow y su input antes de crear un run. scaffold sin name lista el catálogo de patterns; scaffold con name=<key> devuelve un pattern scaffold. resume vuelve a correr un run interrumpido (stale/failed/cancelled) in-place, reutilizando llamadas completas de subagente/bash cacheadas para no reejecutarlas. report renderiza un run (default: latest) en un <runDir>/report.html autocontenido; pasá watch=true para regenerarlo mientras el run sigue corriendo.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Nombre/path del workflow relativo al directorio de workflows (.js se agrega si se omite), run id para view/cancel/resume (en resume el default es latest), o pattern key para action=scaffold.",
		}),
	),
	scope: Type.Optional(
		StringEnum(WORKFLOW_SCOPE_INPUTS, {
			description: `Usá ${CONFIG_DIR_NAME}/workflows del proyecto, workflows globales del agent-dir o resolución auto.`,
		}),
	),
	code: Type.Optional(Type.String({ description: "Fuente JavaScript del workflow para action=write." })),
	input: Type.Optional(
		Type.Any({
			description: "Input JSON-serializable que se pasa a action=run/start workflow(ctx, input).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Flag de compatibilidad para action=run/resume. En sesiones TUI/RPC persistentes, los workflows siempre arrancan en background; el modo print/json cae a foreground porque no existe una sesión de background que quede viva.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Para action=resume, permite reanudar un run ya completado (solo reejecuta llamadas no cacheadas).",
		}),
	),
	watch: Type.Optional(
		Type.Boolean({
			description:
				"Para action=report, seguí regenerando <runDir>/report.html mientras el run esté corriendo; el reporte final quita el auto-refresh del navegador.",
		}),
	),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_CONCURRENCY,
			description: "Concurrency default de subagentes.",
		}),
	),
	maxAgents: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_AGENTS,
			description: "Máximo de subagentes que un workflow puede lanzar.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 1_000, description: "Timeout total del workflow en milisegundos." }),
	),
	agentTimeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			description: "Timeout default de cada subagente en milisegundos.",
		}),
	),
});

export function makeWorkflowPromptGuidelines(): string[] {
	return [
		"Paso cero antes de orquestar: decidí si el prompt de la tarea necesita mejora. Si la ambigüedad bloquea el routing o la implementación, inferí criterios de éxito concisos cuando sea seguro o hacé solo preguntas bloqueantes. Usá ese prompt mejorado para la decisión de routing/scouting.",
		"Decidí en tres pasos antes de orquestar. (1) Gate trivial: si la tarea es conversacional, de un solo paso o resoluble con unas pocas tool calls directas, respondé normal; NO construyas un workflow. (2) Scout inline primero: si puede ser grande, hacé una probe barata inline (git ls-files, leer el diff, grep/glob de candidatos) para descubrir la work-list real y su tamaño. (3) Orquestá solo por exhaustividad (muchos ítems independientes), confianza (perspectivas independientes + verificación adversarial) o escala (más contexto que una ventana: migraciones, auditorías, sweeps amplios).",
		"Escalá effort a la tarea. 'Find some' / 'quick check' -> fan-out chico (~3-5) + síntesis liviana. 'Review this plan' -> unos pocos reviewers con perspectivas diversas + synthesis-as-judge. 'Audit thoroughly' / 'be exhaustive' -> pool más grande, checks adversariales por hallazgo, síntesis y otra ronda solo si siguen apareciendo hallazgos nuevos.",
		"Escalá el paralelismo según la work-list descubierta y las restricciones. Subí concurrency/maxAgents por encima de defaults bajos para muchas ramas independientes, read-only y de bajo riesgo cuando los límites globales y el presupuesto/rate limits del provider lo permitan; mantenelos bajos para efectos laterales, modelos caros, ediciones con estado compartido, dependencias secuenciales o rate limits inciertos. Logueá concurrency solicitada/efectiva, maxAgents y cualquier clamp de límites.",
		"Escribí un workflow solo con GLOBALS inyectadas — sin ctx, sin import/require: `export const meta = { name, description, phases }` opcional más `export default async function main()` (o un script top-level que termine en `return <value>`). Leé el input vía la global `args` (JSON-stringified; parseá a la defensiva). Globals: agent, agents, parallel, pipeline, workflow, phase, log, args, bash, readFile/writeFile/appendFile/listFiles, writeArtifact, sleep, json, compact y los límites read-only limits/runId/runDir/cwd. NUNCA nombres tu función como una global (usá main); llamarla `workflow` sombrea el helper de composición workflow() y recursa sobre sí misma.",
		formatWorkflowPatternKeyList(),
		formatWorkflowCompositionPromptSummary(),
		"Elegí primitives por dependencia de datos. Usá agents(items,{concurrency}) para un paso independiente por ítem. Usá pipeline(items,...stages) por default para >=2 etapas dependientes por ítem sin merge entre ítems; incluí un id/index estable del ítem en los prompts generados dentro de las etapas. Usá agents(items,{concurrency,settle:true}) para fan-out ancho o paneles de reviewers donde una rama fallida debe devolver null. Usá parallel([()=>...]) solo para una barrera real en la que un paso posterior necesita todos los resultados juntos (dedup/merge, early-exit si total=0, ranking cross-branch). Usá workflow(name,args) para subpasos reutilizables sin gate de decisión; secuenciá runs separados cuando una decisión dependa de la salida previa.",
		"Usá agent(prompt,{schema}) cuando un subagente deba devolver JSON: agent() retorna directamente el objeto parseado con {schema} (o el texto, en otro caso) y null si el subagente falla. Los plurales agents()/parallel()/pipeline() retornan objetos/arreglos de resultado (leé .output/.data; null por rama fallida bajo settle). Usá agentType:'explore'|'reviewer'|'planner'|'architect'|'implementer'|'researcher' para defaults de persona; las opciones explícitas pisan la persona. Acotá el acceso de cada subagente con tools/excludeTools, skills/includeSkills, extensions/includeExtensions y keys/env cuando necesite capacidades específicas; nunca pongas secretos en prompts. Los subagentes reciben web_search vía pi-codex-web-search y context7-cli cuando están instalados; incluí web_search en allowlists read-only cuando puedan servir web/docs/evidencia actual, y usá includeExtensions:false/includeSkills:false solo como opt-out explícito.",
		"Decidí model y effort por llamada como dos diales independientes, no como un slider barato↔profundo: pasá model ('haiku'|'sonnet'|'opus' o un 'provider/id' completo) y effort (low|medium|high|xhigh|max) en llamadas agent/agents/pipeline o en cualquier spec por ítem (el helper node(role,extra) propaga input.models/efforts/toolsByRole por rol). model multiplica el precio de cada token; effort solo limita thinking (low~2k/medium~8k/high~16k) y el presupuesto no usado es gratis: no acoples modelo barato con thinking barato. Mantené low para nodos mecánicos (un comando/read pineado, schema plano, output transcripto literalmente, verificado downstream) y para scouts de ranking chicos y nítidos cuyos misses son baratos y visibles; subí effort>=medium para output ambiguo, juicio difuso, contexto largo, alto costo de omisión o ranking difícil. Si un A/B local muestra que effort no ayuda pero modelos más fuertes sí, subí model en cambio. Usá un modelo fuerte + high/xhigh solo para síntesis final, verificación adversarial, planning y razonamiento difícil. SIEMPRE seteá model en nodos de fan-out ancho: si lo omitís hereda el modelo del orquestador (una sesión opus cobra cada rama como opus); si omitís effort hereda el reasoning level crudo de la sesión salvo que una persona agentType lo eleve (reviewer/planner/architect/researcher=high, explore/implementer=medium), y las opciones explícitas ganan. model y effort forman parte de la cache key, así que cambiarlos reejecuta esa llamada al reanudar.",
		"Hacé visible la falla parcial: filtrá nulls de agents/pipeline/parallel con settle, logueá cuántas ramas fallaron y hacé que los prompts de síntesis mencionen ramas fallidas, vacías, canceladas o timed-out en vez de esconderlas. En prompts de synthesis/judge, reafirmá la tarea + criterios de éxito al PRINCIPIO y al FINAL (después del bloque de evidencia), con los hallazgos más importantes primero, para contrarrestar lost-in-the-middle.",
		"Nunca limites cobertura en silencio. Siempre que un workflow use slice/head/top-N/sampling/no-retry, ajuste concurrency a limits.concurrency o baje maxAgents por debajo de la work-list descubierta, log() exactamente qué quedó excluido, demorado o clampeado.",
		`Al crear un workflow, inspeccioná primero el catálogo de patterns (opcionalmente action=scaffold name=<key> para un scaffold), reutilizá un workflow existente solo cuando calce exactamente con la tarea; si no, escribí un draft de proyecto claro y gitignored en ${CONFIG_DIR_NAME}/workflows/drafts/<task-slug>.js y lanzalo en background con límites explícitos (action=start en TUI/RPC persistente; action=run solo como fallback print/no persistente). Si un workflow se justifica para diseño complejo de workflow/prompt/contract, usá el scaffold workflow-factory para que un workflow genere y revise el workflow específico de la tarea. Después de un run útil, decile a la persona usuaria la ruta y ofrecé conservarlo/promoverlo a un nombre estable de workflow.`,
		"Los workflows en sesiones TUI/RPC persistentes siempre corren en background: usá dynamic_workflow action=start (o action=run, que la extensión manda a background ahí), luego inspeccioná con action=runs/view y detenelo con action=cancel si hace falta.",
		"NO busy-pollees un run en background (nada de sleep/loop re-chequeando status.json ni action=view repetido): el harness ya lo sigue e inyecta una notificación de finalización cuando termina, así que dejá que reporte y miralo UNA sola vez cuando avise (o cuando lo pida la persona usuaria). Mientras corre, hacé otro trabajo útil en vez de vigilarlo.",
		"Si un run fue interrumpido (state stale/failed/cancelled), usá dynamic_workflow action=resume name=<runId> para continuarlo in-place; las llamadas completas de subagente/bash se reutilizan desde el run journal y no se reejecutan, así que reanudar es barato. La salida de agent() se cachea por default (opt-out con {cache:false}); bash() solo se cachea con {cache:true}. Las llamadas cuyos argumentos dependen de Date.now()/Math.random() no se cachearán y se reejecutarán al reanudar.",
		"Construí prompts de subagentes con un prefijo estable: poné PRIMERO el framing compartido/estable (rol, tarea, criterios de éxito, formato de salida) y empujá al FINAL el contenido volátil por ítem (texto del ítem, ids, snippets recuperados), así los prefijos idénticos reutilizan la prompt/KV cache del provider entre llamadas. Evitá Date.now()/Math.random() u otros valores no determinísticos dentro de prompts: rompen esa cache y hacen que el journal de resume falle y reejecute la llamada.",
		"Los scripts de workflow son código confiable. Mantené los prompts de subagentes acotados, usá listas read-only de tools para tareas de auditoría/investigación y persistí outputs intermedios con writeArtifact().",
		"Usá dynamic_workflow action=graph para explicar un workflow antes de correrlo, y action=view/runs para inspeccionar timelines de ejecución y artifacts después de correrlo.",
	];
}
