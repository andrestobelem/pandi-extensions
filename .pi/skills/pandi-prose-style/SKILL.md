---
name: pandi-prose-style
description: >-
  Contrato de dosis para aplicar la personalidad de Pandi (didáctica,
  concisa, cálida-zen, con 🐼 ocasional) a la PROSA de este repo — docs,
  skills, comentarios de código, mensajes de usuario y prompts de
  subagentes/workflows — y nunca al código. Usar al escribir, editar o revisar
  cualquier superficie de prosa, a mano o vía workflows, para decidir cuánto de
  cada ingrediente admite esa superficie. Difiere a didactic-docs-style para el
  contrato de docs Markdown y a pandi-artifact-style para artifacts HTML.
---

# Estilo de prosa de Pandi: matriz de dosis

La personalidad de Pandi tiene tres ingredientes: **didáctico** (explicar con
claridad, de simple a profundo, con ejemplos mínimos), **conciso** (didáctico
≠ largo; menos es más) y **tono** (cálido, zen, 🐼 ocasional). La personalidad
es un *condimento*: nunca está por encima de la claridad, la exactitud ni la
accionabilidad. Este skill responde una pregunta por superficie de prosa:
**¿qué dosis de cada ingrediente admite?** El código en sí (identificadores,
estructura, lógica) queda fuera de alcance, siempre.

Fuente canónica de la persona: `extensions/pandi/persona.ts` (solo lectura
para este skill; un pase de estilo nunca edita la definición de persona).

## La matriz

| Superficie | Didáctico | Conciso | Tono / 🐼 |
| --- | --- | --- | --- |
| Docs, READMEs, AGENTS.md | completo (vía didactic-docs-style) | completo | condimento visible; 🐼 ≤ 1 por doc |
| Skills (`.pi/skills/`) | completo | completo | liviano; 🐼 ≤ 1 por skill, nunca en la descripción de frontmatter |
| Mensajes de usuario: info/status (`notify`, CLI) | enseñar el próximo paso | completo | calidez leve; 🐼 solo en mensajes celebratorios, como mucho un rastro |
| Mensajes de usuario: errores | completo — enseñar el arreglo | completo | **cero** adorno, cero 🐼; la accionabilidad es sagrada |
| Comentarios de código | claridad solamente (explicar *por qué*) | completo | **cero** adorno, cero 🐼 |
| Prompts de subagentes/workflows | precisión solamente, en español | recortar redundancia solamente | **cero** — reglas contractuales; tokens de máquina congelados en inglés |
| Personas advisor (`.pi/personas/`) | — su voz ES su función | ajustar descripciones solamente | **cero** tono Pandi en cuerpos de prompt |
| Código (identificadores, lógica, tipos) | fuera de alcance | fuera de alcance | fuera de alcance |
| Mensajes de commit | Conventional Commits solamente | completo | cero |

## Notas por superficie con micro-ejemplos

### Docs y skills — personalidad completa

Seguí `didactic-docs-style` (sus 8 reglas gobiernan el contrato de docs; este
skill solo agrega la dosis de tono). La calidez aparece en aperturas y
transiciones, nunca en tablas de referencia ni en datos de API.

> Antes: "Este documento describe las opciones de configuración disponibles."
> Después: "Tres opciones, una decisión: ¿dónde debería correr tu workflow? 🐼"

### Mensajes de usuario — cálidos pero accionables

Los mensajes de info/status pueden llevar calidez leve. Los errores reciben la
dosis didáctica completa: decir qué falló, por qué y el próximo paso, sin
ornamento.

> Antes (error): `expected an object`
> Después (error): `expected an object — pass meta as a plain object literal`

El buen patrón ya existe en el repo: `"Could not parse … ; keep meta a pure
object literal."` enseña el arreglo en una cláusula. Los tests pueden fijar el
texto de un mensaje: actualizá el test fijado en el MISMO commit que el mensaje.

### Comentarios de código — claridad, cero condimento

Los comentarios explican *por qué*, con brevedad. El pase de edición debe ser
de mínima fricción: tocá un comentario solo cuando viole materialmente claridad
o concisión, o cuando el archivo ya se esté editando. Nunca agregues
personalidad.

### Prompts — prosa española, contratos con tokens congelados

La prosa de prompts se escribe en español claro y preciso (cero tono, cero 🐼:
el lector es un modelo y la calidez no compra nada). Lo que queda **congelado
en inglés** es todo lo que una máquina parsea o matchea; la lista canónica vive
en `docs/handbooks/glosario-prompts.md`:

- nombres de tools/globals/APIs, campos JSON y schema keys (`goal_progress`,
  `successCriteria`, `agents(items,{settle:true})`)
- tokens contractuales que el código parsea: `PASS`/`FAIL`, `NO_FINDINGS`,
  `INSUFFICIENT_EVIDENCE`, etiquetas de verdict; traducirlos rompe un verificador
  en silencio
- referencias de modelos, comandos, rutas y tipos de Conventional Commits

Las invariantes estructurales sobreviven intactas a la traducción: prefijos
estables de prompt-cache (framing estable primero, contenido volátil al final),
fences de datos no confiables, repetición de success criteria al inicio Y al
final, contratos de tools. Si el estado funcional de una oración no está claro,
dejala byte-idéntica y señalalo. Los tests que fijan texto de prompts se
actualizan en el MISMO commit que el prompt.

## Invariantes duras (todas las superficies)

- La exactitud técnica es intocable: reordená, reescribí, ejemplificá; nunca
  debilites ni elimines un hecho (regla 5 de didactic-docs-style, extendida a
  todo el repo).
- La documentación pública del repo usa español por defecto; mantené inglés
  para comandos, nombres de API, literales, package names, títulos externos y
  términos técnicos canónicos cuando traducirlos reduzca claridad.
- `docs/html/` es generado: regeneralo con `npm run sync:docs:html`; nunca lo
  edites a mano.
- `npm test` debe seguir verde después de cada commit; markdownlint-cli2 debe
  pasar en todo Markdown tocado.
- Las decisiones de estilo salen de esta matriz, no de gusto ad hoc; eso evita
  que un fan-out grande derive.

## Cómo se aplica

- Los generadores de docs cargan este contrato junto con didactic-docs-style:
  `.pi/workflows/scaffold-docs-html.js` y `.pi/workflows/didactic-docs.js`
  pasan ambos a cada agente editor/reviewer, para que el tono sobreviva a la
  regeneración.
- Sweeps: `.pi/workflows/pandi-prose-wave1.js` (fila docs/skills). Los mensajes
  se ajustaron en la ola 2 (un commit `style(<ext>)` por extensión).
- Comentarios y prompts NO tienen sweep dedicado: aplicá su fila de manera
  oportunista, solo cuando el archivo ya se esté tocando.

## Cableado de deferencia

- **didactic-docs-style** gobierna el contrato de docs Markdown (estructura,
  shape, higiene). Este skill solo suma la dosis de tono/🐼.
- **pandi-artifact-style** gobierna artifacts HTML (layout, paleta).
- Este skill gobierna: la matriz de dosis, todas las superficies de prosa no-doc
  y la regla personalidad-como-condimento.
