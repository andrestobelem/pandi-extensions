# Investigación: ultracode always-on

Fecha: 2026-06-25

## Pedido

El usuario pidió que Pi evalúe por defecto cada tarea y decida si conviene resolverla mediante un workflow dinámico, inspirado en el modo `ultracode` de Claude Code, y que quede siempre activo.

## Hallazgos sobre Claude Code

Según documentación pública de Claude Code y Anthropic:

- Los dynamic workflows son scripts JavaScript que Claude escribe/ejecuta para orquestar subagentes en paralelo.
- Se usan para auditorías grandes, migraciones, investigación profunda, verificación cruzada y tareas con ramas independientes.
- Se pueden disparar pidiendo un workflow o usando la palabra `ultracode`.
- El modo `/effort ultracode` hace que Claude Code decida automáticamente si una tarea sustantiva debería transformarse en workflows dinámicos.
- `ultracode` no es solamente un nivel de esfuerzo del modelo: combina razonamiento alto (`xhigh`) con orquestación automática de workflows.
- Los workflows tienen coste potencialmente alto, por lo que la documentación recomienda límites explícitos, revisión de workflows y uso consciente.

Fuentes consultadas:

- Claude Code Docs — Dynamic workflows: https://code.claude.com/docs/en/workflows
- Claude Code Docs — Model configuration / effort ultracode: https://code.claude.com/docs/en/model-config
- Anthropic Blog — Introducing dynamic workflows in Claude Code: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Claude Code Docs — Subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code Settings: https://docs.anthropic.com/en/docs/claude-code/settings

## Decisión de implementación para Pi

Implementamos un router always-on en la extensión `pi-dynamic-workflows`:

- Se inyecta una sección de system prompt en `before_agent_start`.
- La inyección ocurre solo si el tool `dynamic_workflow` está activo.
- El router pide evaluar silenciosamente cada tarea sustantiva antes de decidir enfoque.
- Para tareas simples, Pi debe proceder normalmente.
- Para tareas complejas, Pi debe crear/reusar/ejecutar workflows con límites explícitos.
- Para trabajos largos, debe preferir background (`start`) y luego inspeccionar con `runs/view`.

## Archivos modificados

- `extensions/dynamic-workflows.ts`
- `README.md`
- `skills/dynamic-workflows/SKILL.md`
- `docs/README.md`
- `docs/memoria.md`
- `docs/conversaciones/2026-06-25-revisar-estado-actual.md`

## Comandos nuevos

```text
/ultracode-mode status
/ultracode-mode off
/ultracode-mode on
```

## Validaciones realizadas

Se comprobó que Pi puede inicializar la extensión explícitamente sin enviar un prompt al modelo:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
```

Resultado: exit code `0`.

Se comprobó que el comando nuevo está registrado y responde en modo print:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

Resultado:

```text
Ultracode always-on is enabled.
```

Limitación de validación: el repo no tiene TypeScript instalado ni scripts de `typecheck`; `npx tsc` no estuvo disponible.

## Nota de alcance

Esta implementación replica el comportamiento de ruteo automático. No fuerza por ahora el nivel de thinking a `xhigh` para evitar cambiar coste/modelo de forma sorpresiva; el criterio principal pedido fue decidir por defecto si usar workflow.
