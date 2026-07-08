---
name: empirical-software-design
description: >-
  Aplicá diseño empírico de software al estilo Kent Beck al conducir el ritmo
  fino de TDD (test list, fake it, triangulate, step-size gears), separar
  cambios de estructura de cambios de comportamiento, decidir el timing del
  tidying como first/after/later/never según la economía local, aplicar las
  four rules of simple design, ajustar prácticas a las fases
  explore/expand/extract, o supervisar un agente de coding con los guardrails
  de Beck para augmented coding. Usalo para dimensionar el próximo paso,
  decidir cuándo el tidying se paga solo y mantener las decisiones de diseño
  apoyadas en feedback y reversibilidad.
---

# Diseño empírico de software

Usá este skill para afinar decisiones de diseño dentro del loop de coding: elegir el próximo paso de TDD, decidir si conviene tidy first/after/later/never, separar estructura de comportamiento y mantener a un agente de coding dentro de un loop de feedback corto.

Este skill se basa en la investigación del proyecto destilada de _Test-Driven Development: By Example_, _Tidy First?_, Canon TDD, el modelo 3X y los textos de Kent Beck sobre augmented coding. Ver `references/kent-beck-empirical-software-design.md` para el resumen compacto de fuentes.

Aporta el micro-rhythm y la economía de diseño de Beck dentro de los loops que definen los otros lens skills. `modern-software-engineering` establece TDD como loop de feedback por defecto del repo para cambios de comportamiento y fija la forma de respuesta del repo; este skill gobierna el step size y los movimientos de diseño dentro de ese loop. `ai-assisted-engineering` decide la delegación a IA y la apuesta prototype-vs-production; este skill solo agrega los practice patterns de Beck una vez tomada esa decisión.

## Lente central

1. **Software value = comportamiento hoy + opciones sobre comportamiento futuro.** Los cambios de comportamiento entregan valor ahora (money now beats money later); los cambios de estructura compran opciones para cambios futuros (_Tidy First?_ Part III).
2. **Estructura y comportamiento son bienes económicos distintos.** No los mezcles en un mismo cambio; mantené los tidyings en commits/PRs separados, con la menor cantidad posible por PR, para que cada uno sea barato de revisar para humanos y barato de revertir (_Tidy First?_ ch. 16, 28).
3. **Coupling es el driver de costo.** El coupling es relativo a un cambio probable concreto: que un elemento cambie obliga a cambiar otro (ch. 29, paráfrasis). Cohesion: poné juntos los elementos que cambian juntos (ch. 32). El tidying paga cuando reduce coupling en caminos que realmente cambiás.
4. **Step size es una perilla, no un dogma.** Preferí el paso más chico que produzca feedback verificable; achicalo cuando haya sorpresas y agrandalo cuando haya confianza.
5. **El timing del diseño es una decisión económica local, no un ideal de limpieza.** "Later" y "never" son respuestas legítimas.
6. **La IA cambia costos, no corrección.** Los experimentos baratos se vuelven abundantes; la corrección sigue viniendo de loops de feedback chicos e inspeccionables ("Exploring AI", 2024).

## El micro-ritmo (Canon TDD)

Para un cambio de comportamiento guiado test-first, usá los pasos de Canon TDD de Beck:

1. **Escribí una test list** con las variantes de comportamiento esperadas antes de codear.
2. **Convertí exactamente un ítem en un test concreto, ejecutable y en rojo.**
3. **Hacé pasar todos los tests**, actualizando la lista a medida que aprendés. Elegí un gear de green bar: **Obvious Implementation** (escribí el código real cuando está claro y es rápido), **Fake It** (devolvé una constante y luego reemplazá constantes por variables) o **Triangulate** (generalizá solo cuando dos o más ejemplos te obligan). Bajá de gear cada vez que un red bar te sorprenda.
4. **Refactor opcionalmente.** Canon TDD marca este paso como opcional; el loop por defecto de este repo (Farley lane) exige narrar la decisión de Refactor. Seguí la regla del repo y usá los tidyings y las four rules de abajo para decidir qué hacer dentro de ese paso.
5. **Repetí hasta vaciar la test list.**

Calibrá la profundidad de tests por confianza, no por ritual de coverage: testeá más donde los errores son probables (condicionales complicados, patrones de fallo conocidos del equipo) y menos donde una clase de errores empíricamente no ocurre (respuesta de Beck en Stack Overflow, 2008, paráfrasis).

**TCR (`test && commit || revert`)** es el extremo del dial de step size: green commits y red reverts al último estado que pasa. Beck lo planteó como un experimento para forzar incrementos más chicos (2018); Thoughtworks Radar lo clasifica como "Trial". Usalo solo como experimento deliberado de step size con pasos diminutos y tests rápidos y deterministas; nunca como default, y no combinado con agent automation (no hay vínculo documentado entre ambos).

## Estructura vs. comportamiento: tidyings y momento

1. **Clasificá primero cada cambio:** estructura (tidying) o comportamiento. Un solo tipo por commit/PR.
2. **Elegí tidyings del catálogo de Beck** de 15 movimientos chicos que preservan comportamiento (guard clauses, dead code, explaining variables, extract helper, reading order, etc.; la lista completa está en el archivo de referencias).
3. **Definí el timing del tidying — first, after, later o never:**
   - **First** cuando baja el costo o el riesgo del cambio inmediato de comportamiento, o cuando lo necesitás para entender el código.
   - **After** cuando vas a tocar de nuevo esa misma zona pronto.
   - **Later** cuando el beneficio es real pero diferible y el equipo puede trackear ese trabajo diferido.
   - **Never** cuando ese código no va a cambiar otra vez.
4. **Aplicá el test económico** (paráfrasis de ch. 21): tidy first cuando cost(tidying) + cost(change after tidying) < cost(change without tidying).
5. **Preparatory-change rule** — tweet de Beck de 2012: "for each desired change, make the change easy (warning: this may be hard), then make the easy change."

## Cuatro reglas del diseño simple

Usalas como desempate durante el refactoring, en orden de prioridad:

- **Rule 1 (stable): pasa todos los tests.**
- **Rules 2–3: revela intención / no tiene lógica duplicada.** Los propios recuentos de Beck discrepan sobre cuál va segunda (el shorthand de Fowler revisado por Beck vs. _XP Explained_ 1st ed. p. 57 las invierten); nombrá la fuente si importa el orden del medio. No presentes un orden intermedio como canónico.
- **Rule 4 (stable): la menor cantidad posible de elementos** (classes y methods).

## Explorar / Expandir / Extraer

Ajustá la práctica a la fase; cada fase tiene herramientas y sistemas de valor distintos, y no conviene mezclarlos:

- **Explore** (payoff unknown): muchos experimentos baratos, chicos y no correlacionados; optimizá velocidad de aprendizaje; tolerá código descartable.
- **Expand** (growth found): foco singular en el próximo bottleneck para el crecimiento.
- **Extract** (value known): optimizá margen, confiabilidad y repetibilidad mediante standardization y automation.

Beck no publica una tabla de prácticas por fase: derivá las prácticas a partir del objetivo de la fase en vez de inventar un mapping enlatado.

## Patrones de práctica para augmented coding

Una vez tomada la decisión de delegación (ver `ai-assisted-engineering`), aplicá los patterns de Beck para trabajar con un "genie" de IA:

1. **Augmented, no vibe:** seguí prestando atención a complejidad, tests, coverage y tidy design aunque la IA escriba; la responsabilidad de diseño sigue siendo humana.
2. **Persistent prompt guardrails:** reglas recurrentes como no code without a failing test, only enough code to pass, green before commit, never delete tests.
3. **Failure-mode watchlist como hard stops:** loops, scope no pedido, tests o assertions borrados, fake implementations.
4. **Mantené corriendo de forma constante una test suite grande y rápida** para detectar regresiones en el momento.
5. **Reducí primero la complejidad del problema:** por ejemplo, implementá en un lenguaje más simple y después hacé que el agente traduzca tests y código (copy-from-simpler-language).
6. **Optimizá outcomes, no orchestration:** los developers quieren resultados, no gestión de agent swarms por sí misma ("Genie Lessons").

## Forma de respuesta requerida al usar este skill

Para guía de coding, refactoring o review, incluí estos puntos salvo que sean claramente irrelevantes:

- **Clasificación del cambio:** estructura o comportamiento, y cómo los commits los mantienen separados.
- **Test list:** las variantes de comportamiento a cubrir, una por vez.
- **Step-size gear:** obvious implementation, fake it o triangulate, y qué dispara el downshift.
- **Tidy timing:** first/after/later/never, con la razón económica local.
- **Chequeo de simplicidad:** las four rules (con la salvedad sobre el orden cuando importe el orden del medio).
- **Reversibilidad:** cómo este paso se mantiene barato de revisar y revertir.

## Cómo aplicarlo

1. Clasificá el cambio (estructura vs. comportamiento) antes de tocar código.
2. Escribí la test list y elegí exactamente un ítem.
3. Elegí el gear más chico que produzca feedback verificable; bajá de gear ante una sorpresa.
4. Decidí el tidy timing con criterio económico; si hacés tidy first, justificá la decisión con la preparatory-change rule.
5. Refactorizá contra las four rules; frená en la menor cantidad de elementos, sin gold-plating.
6. Mantené cada paso reversible: commits separados, pocos tidyings por PR, green entre pasos.
7. Antes de exigir el micro-rhythm, chequeá las degradation conditions que Beck enumera: tests lentos, fallas con muchas causas posibles, tests acoplados a la implementación y entornos de test de baja fidelidad ("Is TDD Dead?", 2014).

## Checklist de revisión

- ¿Algún commit mezcla cambios de estructura y de comportamiento?
- ¿Hubo una test list antes del código y llegó cada test de a uno?
- ¿La generalización surgió por triangulation con al menos dos ejemplos, o se adivinó desde uno?
- ¿El tidy timing está explicitado (first/after/later/never) con una razón económica, o lo empuja un ideal de limpieza?
- ¿El refactor frena en las four rules, o agrega elementos más allá de los mínimos necesarios?
- ¿La profundidad de tests se justifica por confianza, o por un porcentaje fijo de coverage?
- ¿Las indirections (mocks, adapters, layers) responden a una decisión de diseño, o solo a velocidad de test isolation (test-induced design damage)?
- Para diffs producidos por agentes: ¿hay assertions borradas o debilitadas, fake implementations, scope no pedido o loops?

## Guía para workflows dinámicos

Para Pi Dynamic Workflows en particular:

- En trabajo de fase Explore, preferí muchas ramas baratas, chicas y no correlacionadas antes que una sola gran orchestration; optimizá el workflow para velocidad de aprendizaje.
- Dale a los subagentes implementadores el micro-rhythm como contrato: test list primero, un test por vez, separación de estructura/comportamiento en los diffs que devuelven.
- Codificá los persistent-prompt guardrails de Beck en los prompts de workers (no code without a failing test; never delete tests) y tratá la failure-mode watchlist como stop conditions a nivel rama.
- Persistí la test list, las decisiones de gear y las de tidy timing como artifacts para que el razonamiento de diseño sobreviva a la compaction.
- Juzgá el workflow por outcomes, no por cuánto ejercita la orchestration de agentes.

## Antipatrones a señalar

- Mezclar tidyings y cambios de comportamiento en un mismo commit o PR.
- Hacer tidying por ideales de limpieza, sin preguntarse nunca si "later" o "never" son la respuesta correcta.
- Generalizar a partir de un solo ejemplo en vez de triangular.
- Test-induced design damage: agregar indirection solo para conseguir tests aislados y rápidos; la respuesta de Beck es culpar al juicio de diseño, no a TDD.
- Fijar objetivos de coverage en lugar de profundidad de tests basada en confianza.
- Presentar TCR como práctica default, o correrlo sobre tests lentos o flaky.
- Aceptar output de agentes que borra o debilita tests, finge implementaciones o expande scope sin pedirlo.
- Citar las four rules con un único orden fijo en el medio como si fuera canónico.

## Límites de seguridad

- Parafraseá el wording de los libros de Beck; la única cita textual con licencia es el tweet de preparatory change de 2012.
- Chequeá las TDD degradation conditions antes de prescribir el micro-rhythm; si se cumplen, primero arreglá el feedback (velocidad, determinismo, fidelidad de tests).
- No mezcles sistemas de valor de fases 3X; nombrá la fase antes de elegir prácticas.
- No presentes TCR como default recomendado por Beck, y no combines TCR con agent automation como si fueran una sola práctica: las fuentes de investigación solo los vinculan por separado.
- Deferile a `modern-software-engineering` si TDD aplica o no, y la forma de respuesta del repo; deferile a `ai-assisted-engineering` la decisión de delegación a IA.
- El costado humano/social acá queda limitado a lo que está documentado: PRs chicos y separados abaratan la review para personas, y la orientación a outcomes supera la gestión de agent swarms. No extrapoles desde ahí un método social más amplio.
