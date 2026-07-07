# Resumen de clean craftsmanship de Robert C. Martin

Investigación fuente: cuatro ramas de investigación sobre Robert C. Martin (mecánica del método, economía de decisiones, riesgos/críticas, aplicación en la era de la IA), basadas en su blog Clean Coder, el paper de 2000 "Design Principles and Design Patterns", *Clean Code*, *The Clean Coder* y entrevistas de 2023–24.

## Tesis

La limpieza es velocidad: el código desprolijo eleva el costo de cada cambio futuro, creando un ciclo de entregas más lentas, presión de cronograma y más desprolijidad — ir bien es la única forma de ir rápido (paráfrasis; "Going Fast", 2007; *Clean Code* cap. 1). Craftsmanship significa negarse a hacer trabajo pobre o generar desorden para cumplir un cronograma (post de 2011). Las disciplinas actúan como restricciones que eliminan la discrecionalidad en escalas de tiempo específicas.

## TDD como disciplina

- Tres leyes (paráfrasis; la página canónica devolvió 502 durante la investigación, redacción textual no verificada): (1) no escribir código de producción salvo para pasar un test que falla; (2) no escribir más test del necesario para que falle — la falla de compilación cuenta; (3) no escribir más código de producción del necesario para pasar (butunclebob.com; "The Cycles of TDD", 2014).
- Jerarquía de ciclos: nano (las tres leyes, segundos) → micro (Red/Green/Refactor, minutos) → milli (tests específicos, código genérico, ~10 min) → primario (chequeo de arquitectura, horas) (2014).
- Transformation Priority Premise (2013): lista ordenada de transformaciones; preferir la más simple; si un test fuerza una transformación de bajo nivel, elegir otro test.

## Reglas a nivel de código

- Reglas de funciones del cap. 3 de *Clean Code* (títulos): pequeñas; hacer una sola cosa; un solo nivel de abstracción por función; la regla del descenso (stepdown rule); argumentos de función; sin efectos secundarios; separación comando–consulta; excepciones en vez de códigos de error; DRY.
- Comentarios: Martin trata los comentarios como fallas al expresar la intención en el código (posición documentada en el repo del debate Ousterhout–Martin).
- Regla del Boy Scout: dejar un módulo más limpio de lo que se lo encontró (*97 Things* cap. 8); dejar el campamento más limpio (*Clean Code* cap. 1, p. 14). Vuelve la limpieza continua y amortizada.

## Diagnóstico de diseño

- Cuatro síntomas de descomposición — rigidez (los cambios se propagan en cascada), fragilidad (rotura de partes no relacionadas), inmovilidad (el código no puede reutilizarse), viscosidad (los parches son más fáciles que los cambios que preservan el diseño; incluye viscosidad del entorno) — todos rastreados a dependencias mal gestionadas; la familia SOLID más los principios de componentes son el tratamiento, aplicado donde aparecen los síntomas (paper de 2000). Defensa continuada en "Solid Relevance" (2020). No hay una fuente que establezca un orden de prioridad canónico entre los principios SOLID.

## Arquitectura

- Dependency Rule (paráfrasis, 2012): las dependencias del código fuente apuntan solo hacia adentro; los círculos internos no saben nada de los externos; se cruzan los límites mediante interfaces propiedad del círculo interno. Los círculos son esquemáticos — las dependencias hacia adentro son el único invariante, cuatro capas no son obligatorias (mismo post).
- Una buena arquitectura mantiene barata la postergación de decisiones de framework/BD/UI como detalles en los bordes ("Clean Architecture", 2011).

## Profesionalismo

- Decir que no en vez de "voy a intentarlo"; "intentarlo" es un compromiso implícito encubierto ("Saying No"; entrevista de InformIT).
- Las estimaciones son distribuciones de probabilidad, los compromisos son promesas; PERT trivariado: media (O + 4M + P) / 6, dispersión (P − O) / 6 (*The Clean Coder* cap. 10; fórmulas verificadas de forma cruzada con resúmenes secundarios, la redacción exacta del libro no fue citada directamente).
- Desorden ≠ deuda: la deuda puede ser un trade-off deliberado y pagable; el desorden es pérdida pura ("A Mess is not a Technical Debt").
- El TDD cumple un rol importante en el comportamiento profesional sin ser la única disciplina admisible ("Professionalism and TDD (Reprise)", 2014). Disciplina de prueba repetible / test de aceptación ("QA no debería encontrar nada"): INSUFFICIENT_EVIDENCE en esta investigación — no se afirma. Estructura del libro *Clean Craftsmanship* (2021): sin fuente directa.

## Salvedades de alcance y críticas

- Concesiones de Martin (Q&A con Muratori): el análisis de rendimiento es esencialmente correcto a nivel de nanosegundos; Clean Code cambia ciclos de programador por ciclos de CPU; puede no encajar en trabajo de GPU/inner-loop; el late binding rinde sobre todo en límites de plugin/librería.
- qntm: los propios ejemplos del libro suelen contradecir su consejo. North (CUPID): crítica letra por letra de SOLID, propiedades por sobre principios. Debate Ousterhout–Martin: desacuerdo documentado sobre longitud de métodos, comentarios y TDD.
- Evidencia de cargo-cult: una app de dos pantallas construida "al pie del libro" produjo 22 módulos (Korolev). Heurística correctiva (Rentea; Ardalis): introducir interfaces/capas solo cuando una segunda implementación, la volatilidad del adaptador o la complejidad del dominio lo justifican.

## Aplicación en la era de la IA

- Entrevista de Duffield (2024, paráfrasis): Martin usa la IA sobre todo como ayuda de preguntas y respuestas / API; le pide a la IA que refactorice solo después de que todos los tests pasan; acepta los resultados únicamente con su propio criterio; espera que la IA genere más trabajo de programación, no que elimine programadores.
- Adaptación de la práctica, no de la escritura de Martin: codificar la Dependency Rule/SOLID como guardrails de agentes en archivos de instrucciones más tests de arquitectura en build-time (NimblePros), motivado por una mayor incidencia de code smells en Java generado por LLMs (arXiv 2025).

## Sources

- https://butunclebob.com/ArticleS.UncleBob.TheThreeRulesOfTdd
- https://blog.cleancoder.com/uncle-bob/2014/12/17/TheCyclesOfTDD.html
- https://blog.cleancoder.com/uncle-bob/2013/05/27/TheTransformationPriorityPremise.html
- https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- https://blog.cleancoder.com/uncle-bob/2011/11/22/Clean-Architecture.html
- https://www.fil.univ-lille.fr/~routier/enseignement/licence/coo/cours/Principles_and_Patterns.pdf
- https://www.oreilly.com/library/view/clean-code-a/9780136083238/chapter03.xhtml
- https://www.oreilly.com/library/view/97-things-every/9780596809515/ch08.html
- https://www.informit.com/articles/article.aspx?p=1235624&seqNum=3
- https://www.informit.com/articles/article.aspx?p=1235624&seqNum=6
- https://sites.google.com/site/unclebobconsultingllc/going-fast
- https://sites.google.com/site/unclebobconsultingllc/a-mess-is-not-a-technical-debt
- https://sites.google.com/site/unclebobconsultingllc/blogs-by-robert-martin/saying-no
- https://www.informit.com/articles/article.aspx?p=1711821
- https://www.oreilly.com/library/view/clean-coder-the/9780132542913/ch10.xhtml
- https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html
- https://blog.cleancoder.com/uncle-bob/2014/05/02/ProfessionalismAndTDD.html
- https://blog.cleancoder.com/uncle-bob/2011/01/17/software-craftsmanship-is-about.html
- https://github.com/unclebob/cmuratori-discussion/blob/main/cleancodeqa.md
- https://qntm.org/clean
- https://dannorth.net/blog/cupid-for-joyful-coding/
- https://github.com/johnousterhout/aposd-vs-clean-code
- https://victorrentea.ro/blog/overengineering-in-onion-hexagonal-architectures/
- https://ardalis.com/clean-architecture-sucks/
- https://pavelkorolev.xyz/blog/2023-08-23-clean-architecture-android/
- https://jesseduffield.com/Bob-Martin-Interview/
- https://blog.nimblepros.com/blogs/ai-agents-clean-architecture/
- https://arxiv.org/html/2510.03029v1
