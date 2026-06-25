# pi-dynamic-workflows

Implementación para **Pi** de workflows dinámicos estilo Claude Code: scripts JavaScript que orquestan subagentes de Pi en paralelo, guardan artefactos fuera del contexto del chat y devuelven una síntesis coordinada.

## Instalación

Desde este repo, global para tu usuario:

```bash
pi install ./
```

Instalación local al proyecto actual:

```bash
pi install -l ./
```

Probar sin instalar:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts
# o cargar el paquete entero:
pi --no-extensions -e .
```

Para usar workflows de proyecto en `.pi/workflows/`, confía el proyecto con `/trust` y reinicia o ejecuta `/reload`.

## Uso

Comandos humanos:

```text
/workflows                              # dashboard TUI interactivo (tabs Workflows/Runs/Activity)
Ctrl+Alt+W                              # shortcut para abrir el dashboard
/workflow dashboard                     # alias del dashboard TUI
/workflow list
/workflow graph bug-hunt                # vista estática Mermaid del workflow
/workflow runs                          # runs recientes
/workflow view latest                   # timeline + artifacts del último run
/workflow new bug-hunt
/workflow edit bug-hunt
/workflow run bug-hunt {"maxFiles":40,"concurrency":6,"maxAgents":16}
/workflow start bug-hunt {"maxFiles":40,"concurrency":4,"maxAgents":16}   # background
/workflow bg bug-hunt {"maxFiles":40}                                      # alias
/workflow resume latest                 # reanuda un run interrumpido (stale/failed/cancelled)
/workflow resume <runId> --background    # reanuda en background
/workflow resume <runId> --force         # reanuda incluso un run completado
/workflow cancel latest
/workflows
/ultracode revisa todo el repo buscando bugs de concurrencia
/deep-research investiga opciones para migrar X a Y
/ultracode-mode status                 # muestra si el router always-on está activo
/ultracode-mode off                    # desactiva el router en esta sesión
/ultracode-mode on                     # vuelve a activarlo
```

También puedes empezar un mensaje con `ultracode ...` o `dynamic workflow ...` y la extensión lo transforma en una petición orientada a workflows.

### Ultracode always-on

La extensión activa por defecto un router estilo Claude Code `/effort ultracode`: en cada tarea sustantiva Pi evalúa si conviene resolver normalmente o crear/ejecutar un workflow dinámico. No fuerza workflows para tareas simples; solo añade criterio de ruteo al system prompt cuando el tool `dynamic_workflow` está disponible. Por ahora no cambia automáticamente el thinking level a `xhigh` para evitar modificar coste/modelo sin una decisión explícita.

Úsalo sin prefijos: pide una tarea y Pi decidirá. Para controlar el modo durante la sesión:

```text
/ultracode-mode status
/ultracode-mode off
/ultracode-mode on
```

Tool para el modelo: `dynamic_workflow` con acciones `list`, `template`, `read`, `write`, `run`, `start`, `resume`, `cancel`, `delete`, `graph`, `runs`, `view`. `run` bloquea hasta terminar; `start` (o `run` con `background:true`) devuelve enseguida con un `runId`. `resume` reanuda un run interrumpido reutilizando las llamadas ya completadas (ver "Runs reanudables").

Los workflows se guardan en:

- Proyecto: `.pi/workflows/*.js`
- Global: `~/.pi/agent/workflows/*.js`

Los resultados/artifacts se guardan en `.pi/workflow-runs/<run-id>/` cuando el proyecto está trusted. En proyectos no confiados se usa un directorio global bajo `~/.pi/agent/workflow-runs/<hash>/`.

Durante ejecuciones foreground (comando `/workflow run` o tool `dynamic_workflow action=run`), Pi muestra el workflow activo en la status line (`▶/✓/✗ wf ... /workflows ↑↓`) y un widget live con progreso: workflow, agentes completados, comandos bash y últimos logs. En modo interactivo, `/workflows` o `Ctrl+Alt+W` abre un dashboard TUI con tabs para workflows, runs y Activity; desde ahí navegas con ↑↓ para abrir graphs, ejecutar workflows, inspeccionar timelines/artifacts o ver actividad reciente en vivo. Después de cualquier ejecución puedes usar `/workflow view latest`.

Para probar ejemplos, copia uno a `.pi/workflows/`:

```bash
mkdir -p .pi/workflows
cp examples/workflows/repo-bug-hunt.js .pi/workflows/repo-bug-hunt.js
```

Luego:

```text
/workflow run repo-bug-hunt {"maxFiles":40,"concurrency":4,"maxAgents":20}
```

## Background runs

Para investigaciones o auditorías largas en una sesión persistente TUI/RPC, usa background:

```text
/workflow start repo-bug-hunt {"maxFiles":40,"concurrency":4,"maxAgents":20}
/workflow runs
/workflow view <runId>
/workflow cancel <runId>
```

Desde el tool del modelo:

```json
{ "action": "start", "name": "repo-bug-hunt", "input": { "maxFiles": 40 }, "concurrency": 4, "maxAgents": 20 }
```

Notas:

- `start` devuelve inmediatamente `runId`, `status.json` y directorio de artifacts.
- Al completar o fallar, el background workflow despierta al agente con un follow-up automático para inspeccionar `dynamic_workflow action=view name=<runId>` y continuar la tarea.
- El run continúa solo mientras viva la sesión actual de Pi; al reiniciar, un run incompleto se ve como `stale`. Puedes reanudarlo con `/workflow resume <runId>` (ver "Runs reanudables").
- Monitorea con `/workflow runs`, `/workflow view <runId>` o el tab `Activity` del dashboard; cancela con `/workflow cancel <runId>` o `dynamic_workflow action=cancel`.
- Sigue gastando llamadas/modelos en background: usa límites explícitos.

## Runs reanudables (idempotentes)

Cuando un run queda interrumpido (la sesión de Pi murió y queda `stale`, o terminó como `failed`/`cancelled`), puedes reanudarlo sin volver a ejecutar los subagentes ya completados (cada subagente es un `pi -p`, caro):

```text
/workflow resume latest
/workflow resume <runId>               # foreground (bloquea)
/workflow resume <runId> --background  # en background
/workflow resume <runId> --force       # incluso si el run ya está completed
```

Desde el tool del modelo:

```json
{ "action": "resume", "name": "<runId>", "background": true, "force": false }
```

Cómo funciona:

- El run se reanuda **in-place**: mismo `runId` y mismo directorio. Estados reanudables: `stale`, `failed`, `cancelled`. Un run `completed` requiere `force:true`.
- Cada run mantiene un `journal.jsonl` host-side con las llamadas completadas. La clave de caché es **content-address**: `sha256(method + args normalizados)`, con un contador de ocurrencia por clave; es correcta bajo concurrencia (`ctx.agents`) porque no depende de ids host-side no deterministas.
- `ctx.agent()` se cachea **por defecto**; desactívalo por llamada con `ctx.agent(prompt, { cache: false })`.
- `ctx.bash()` se cachea solo **opt-in** con `ctx.bash(cmd, { cache: true })` (úsalo únicamente para comandos deterministas, sin efectos secundarios relevantes).
- `ctx.writeArtifact`/`ctx.writeFile` no se cachean: se re-ejecutan, y reescribir es idempotente. `ctx.log`/`ctx.sleep` nunca se cachean.
- Una llamada cacheada (HIT) **no** gasta `pi -p` ni cuenta contra `maxAgents`.
- Una llamada que estaba **en vuelo** cuando murió la sesión no tiene record en el journal: se re-ejecuta (coste: 1 llamada). Una llamada ya completada nunca se duplica.
- **Determinismo**: el cache de una llamada depende exactamente de sus argumentos. Si construyes el prompt o el comando con `Date.now()` o `Math.random()`, esa llamada cambia de argumentos en cada intento y se re-ejecuta al reanudar (cache miss). Es una degradación segura: nunca devuelve un resultado incorrecto, solo re-corre.
- Se guarda un `codeHash` del workflow (sobre el código transformado) en `status.json`/`result.json` y en cada record del journal. Si el código del workflow cambió desde el run original, `/workflow view` y el resume avisan: las llamadas cuyos argumentos cambiaron se re-ejecutan (miss); las que no, siguen cacheadas.
- `/workflow runs` marca los runs reanudables con `resumable` y muestra `cached:N`; `/workflow view <runId>` añade una línea `Resume: /workflow resume <runId>`, el `codeHash`, el número de llamadas cacheadas y el aviso si el código cambió.
- Atomicidad: `status.json`/`result.json` se escriben con temp+rename para no quedar corruptos ante un crash.

## Ejemplo mínimo

```js
module.exports = async function workflow(ctx, input) {
  await ctx.log("start", { input });

  const reviews = await ctx.agents([
    { name: "a", prompt: "Review src/a.ts", tools: ["read", "grep", "find", "ls"] },
    { name: "b", prompt: "Review src/b.ts", tools: ["read", "grep", "find", "ls"] },
  ], { concurrency: Math.min(input?.concurrency ?? ctx.limits.concurrency, ctx.limits.concurrency) });

  await ctx.writeArtifact("reviews.json", reviews);
  return ctx.compact(reviews, 20000);
};
```

## API del workflow

- `ctx.agent(prompt, opts)` — ejecuta un subagente Pi (`pi -p --no-session`). Se cachea por defecto para resume; desactívalo con `{ cache: false }`.
- `ctx.agents(items, opts)` — ejecuta muchos subagentes con concurrencia limitada.
- `ctx.bash(command, opts)` — ejecuta shell. Opt-in al cache de resume con `{ cache: true }` (solo comandos deterministas).
- `ctx.readFile/writeFile/appendFile/listFiles` — helpers de archivos confinados al cwd del workflow.
- `ctx.writeArtifact/appendArtifact` — persiste datos en el directorio del run (idempotente; no se cachea, se reescribe al reanudar).
- `ctx.log` — progreso visible y `events.jsonl`.
- `ctx.compact/json` — serializa y trunca resultados grandes.
- `ctx.limits` — límites efectivos del run (`concurrency`, `maxAgents`, timeouts); es read-only.

Opciones habituales de subagente:

```js
{
  name: "review-auth",
  tools: ["read", "grep", "find", "ls"],
  timeoutMs: 300000,
  thinking: "high"
}
```

## Patrones de prompts recomendados

Los workflows funcionan mejor cuando cada prompt declara explícitamente el patrón:

- **Fan-out independiente**: cada subagente debe producir un reporte útil aunque otros fallen.
- **Contrato de evidencia**: pedir archivo/línea, URL, comando observado o `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Formato fijo**: `Veredicto`, `Hallazgos`, `Evidencia`, `Riesgos`, `Fix`, `Verificación`.
- **Synthesis-as-judge**: el agente final deduplica, descarta claims sin evidencia, preserva incertidumbre y elige una ruta concreta.
- **Crítica adversarial**: reviewers con objetivo explícito de encontrar edge cases, reducir scope y marcar riesgos aceptados.
- **Fallas parciales visibles**: la síntesis debe mencionar agentes fallidos, vacíos, cancelados o con timeout.
- **Seguridad por defecto**: en auditorías, prompts con “no edites archivos” y tools read-only.

## Seguridad y coste

**Workflows son código confiable, no un sandbox de seguridad.** Pueden ejecutar JavaScript, usar `fetch`, llamar `ctx.bash`, leer/escribir archivos del cwd y disparar muchas llamadas a modelos mediante subagentes.

Buenas prácticas:

- Usa límites explícitos: `concurrency`, `maxAgents`, `timeoutMs`, `agentTimeoutMs`.
- Para auditorías, limita subagentes a tools read-only: `tools: ["read", "grep", "find", "ls"]`.
- Evita `bash` salvo que el workflow realmente lo necesite.
- Revisa workflows antes de ejecutarlos, especialmente si vienen de terceros.

Mira `examples/workflows/` para ejemplos de bug hunt, deep research y revisión adversarial.
