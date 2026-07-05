---
type: "Research Note"
title: "Investigación: ultracode siempre activo"
description: "Investigación sobre activar un router ultracode siempre activo en Pi."
tags: [ultracode, dynamic-workflows, routing, pi]
timestamp: 2026-06-25T00:00:00Z
---

# Investigación: ultracode siempre activo

Fecha: 2026-06-25

## En 30 segundos

Este documento resume una decisión de diseño: si Pi debía revisar cada tarea por defecto para decidir si conviene orquestarla con un dynamic workflow, al estilo de `ultracode` en Claude Code. La conclusión fue habilitar un router siempre activo para esa evaluación, pero sin forzar `xhigh` por ahora. Sirve como registro de la investigación, de las fuentes y de la implementación resultante.

## Pedido

La solicitud fue hacer que Pi evalúe cada tarea por defecto y decida si debe resolverse mediante un dynamic workflow, inspirado en el modo `ultracode` de Claude Code, y mantener ese comportamiento siempre activo.

## Hallazgos sobre Claude Code

Según la documentación pública de Claude Code y Anthropic:

- Los dynamic workflows son scripts de JavaScript que Claude escribe y ejecuta para orquestar subagentes en paralelo.
- Se usan para auditorías grandes, migraciones, investigación profunda, verificación cruzada y tareas con ramas independientes.
- Pueden activarse al pedir un workflow o al usar la palabra `ultracode`.
- El modo `/effort ultracode` hace que Claude Code decida automáticamente si una tarea sustantiva debe convertirse en dynamic workflows.
- `ultracode` combina razonamiento alto (`xhigh`) con orquestación automática de workflows; no es solo un nivel de esfuerzo del modelo.
- Los workflows pueden tener un costo potencialmente alto, así que la documentación recomienda límites explícitos, revisión del workflow y uso consciente.

### Fuentes consultadas

- Claude Code Docs — Dynamic workflows: https://code.claude.com/docs/en/workflows
- Claude Code Docs — Model configuration / effort ultracode: https://code.claude.com/docs/en/model-config
- Anthropic Blog — Introducing dynamic workflows in Claude Code: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Claude Code Docs — Subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code Settings: https://docs.anthropic.com/en/docs/claude-code/settings

## Decisión de implementación en Pi

Implementamos un router always-on en la extensión `pandi-dynamic-workflows`:

- Se inyecta una sección corta del system prompt en `before_agent_start`.
- La extensión intenta habilitar la herramienta `dynamic_workflow` para que el router esté disponible.
- El router le pide a Pi evaluar en silencio cada tarea sustantiva antes de decidir el enfoque.
- Para tareas simples, Pi debe seguir normalmente.
- Para tareas potencialmente amplias, Pi debe hacer primero un scout inline barato antes de orquestar.
- Pi debe crear, reutilizar o ejecutar workflows solo cuando haya una razón clara: completitud, confianza o escala, con límites explícitos.
- Para trabajo de larga duración, debe preferir background (`start`) y luego inspeccionar con `runs/view`.

## Archivos modificados

- `extensions/dynamic-workflows.ts`
- `README.md`
- `.pi/skills/dynamic-workflows/SKILL.md`
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

### Inicialización de la extensión sin prompt del modelo

Verificamos que Pi puede inicializar explícitamente la extensión sin enviar un prompt al modelo:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
```

Resultado: exit code `0`.

### Registro del comando en modo print

Verificamos que el nuevo comando queda registrado y responde en modo print:

```bash
pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

Resultado:

```text
Ultracode always-on is enabled.
```

### Limitación de la validación

El repositorio no tiene TypeScript instalado ni scripts `typecheck`; `npx tsc` no estaba disponible.

## Nota de alcance

Esta implementación replica el comportamiento de enrutamiento automático. Por ahora no fuerza el nivel de pensamiento a `xhigh` para evitar cambios inesperados en costo o comportamiento del modelo; el criterio principal pedido era decidir por defecto si conviene usar un workflow.
