# Open Knowledge Format (OKF): el formato de Google para conocimiento agéntico

> **Status: FINAL.** Síntesis de una investigación de 5 ramas paralelas (5/5 completadas, 0 fallidas) sobre OKF de Google Cloud. La evidencia primaria proviene de `okf/SPEC.md` y `okf/README.md` del repo `GoogleCloudPlatform/knowledge-catalog`, leídos directamente vía `raw.githubusercontent.com` y la API de GitHub. Las lagunas iniciales sobre el **blog de anuncio** (fecha/autores) y la **mecánica de ingestión en Knowledge Catalog** fueron cerradas después con búsqueda dirigida (ver §8); los hechos verificados en esa segunda pasada se marcan **[VERIFICADO]**. Las afirmaciones aún dependientes de resúmenes de búsqueda o interpretación se marcan *[no verificado directamente]*.

---

## 1. Resumen ejecutivo

El **Open Knowledge Format (OKF)** es una **especificación abierta en estado borrador (v0.1 — Draft)** de Google Cloud para representar *conocimiento*: "los metadatos, el contexto y la perspectiva curada que rodean a los datos y los sistemas" (SPEC.md). Su tesis central es ser **un formato, no una plataforma**: "un directorio de archivos markdown con frontmatter YAML. No hay registro de esquemas, ni autoridad central, ni herramientas obligatorias" (SPEC.md).

La propuesta de valor es que el conocimiento organizativo (definiciones de tablas, métricas, runbooks, descripciones de APIs, rutas de join) se vuelva **legible, parseable, diffeable y portable**: "si puedes hacer `cat` a un archivo, puedes leer OKF; si puedes hacer `git clone` a un repo, puedes distribuirlo" (README de OKF). Sirve como una **capa durable de conocimiento/contexto** que tanto humanos como agentes de IA pueden consumir, frente a otros artefactos del ecosistema agentico que resuelven capas distintas (descubrimiento de agentes, protocolos de runtime, instrucciones de repo).

Puntos clave:

- Unidad de distribución: el **Knowledge Bundle** (árbol de directorios Markdown UTF-8).
- Único campo de frontmatter **obligatorio**: `type`.
- **Conformidad muy permisiva**: los consumidores no deben rechazar bundles por campos faltantes, tipos desconocidos, claves extra o enlaces rotos.
- Mantenido por **Google bajo Apache-2.0**, con el descargo explícito de que **"no es un producto oficial de Google"**.
- **[VERIFICADO]** Anunciado el **12 de junio de 2026** en el blog de Google Cloud ("Introducing the Open Knowledge Format"), por **Sam McVeety** (Tech Lead, Data Analytics) y **Amir Hormati** (Tech Lead, BigQuery), ambos de Data Cloud, Google Cloud.

---

## 2. Anatomía del formato

### 2.1 Bundles (unidad de distribución, §3)

Un **Knowledge Bundle** es un árbol de directorios de archivos Markdown UTF-8 y es "la unidad de distribución". PUEDE enviarse como:

- un repositorio git (recomendado),
- un tarball/zip, o
- un subdirectorio dentro de un repositorio mayor.

El layout de directorios es independiente del dominio: los productores organizan los conceptos como prefieran.

**Layout mínimo (Apéndice A del SPEC, verificado y coincidente con el bundle `ga4` real):**

```
my_bundle/
├── index.md            # único lugar donde se permite frontmatter okf_version: "0.1"
├── log.md              # opcional; historial con cabeceras de fecha ISO 8601
├── datasets/
│   ├── index.md
│   └── sales.md
└── tables/
    ├── index.md
    ├── orders.md
    └── customers.md
```

### 2.2 Concept documents (§2, §4)

Un **Concept** es una unidad única de conocimiento = un archivo Markdown. El **Concept ID** es la ruta del archivo dentro del bundle sin el sufijo `.md` (p. ej., `tables/users.md` → `tables/users`).

Cada concepto tiene dos partes: un bloque de **frontmatter** YAML delimitado por líneas `---`, y un **cuerpo** Markdown libre.

### 2.3 Campos del frontmatter (§4.1) — requeridos vs. opcionales

| Campo | Estado | Descripción |
|---|---|---|
| `type` | **REQUERIDO** | Cadena corta que identifica el tipo de concepto. Ejemplos: `BigQuery Table`, `BigQuery Dataset`, `API Endpoint`, `Metric`, `Playbook`, `Reference`. **No registrado centralmente**; los consumidores DEBEN tolerar tipos desconocidos (tratarlos como conceptos genéricos). |
| `title` | Recomendado | Nombre para mostrar; los consumidores PUEDEN derivarlo del nombre de archivo si falta. |
| `description` | Recomendado | Resumen de una sola frase. |
| `resource` | Recomendado | URI que identifica de forma única el activo subyacente; ausente en conceptos abstractos. |
| `tags` | Recomendado | Lista YAML de cadenas cortas. |
| `timestamp` | Recomendado | Datetime ISO 8601 del último cambio significativo. |

**Extensiones:** los productores PUEDEN añadir claves arbitrarias; los consumidores DEBERÍAN preservar las claves desconocidas en round-trip y NO DEBEN rechazar documentos por campos no reconocidos.

**Plantilla de frontmatter (§4.1, verbatim):**

```yaml
---
type: <Type name>                  # REQUERIDO
title: <Optional display name>
description: <Optional one-line summary>
resource: <Optional canonical URI for the underlying asset>
tags: [<tag>, <tag>, …]            # Opcional
timestamp: <ISO 8601 datetime>     # Opcional, última modificación
# … otros pares clave/valor definidos por el productor
---
```

### 2.4 Convenciones del cuerpo (§4.2)

Se prefiere markdown estructural. Tres cabeceras **convencionales** (no requeridas): `# Schema`, `# Examples`, `# Citations`. En el ejemplo trabajado del SPEC también aparece `# Joins`, útil para documentar rutas de join.

### 2.5 Ejemplo concreto: concepto ligado a un recurso (§4.3)

```markdown
---
type: BigQuery Table
title: Customer Orders
description: One row per completed customer order across all channels.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders
tags: [sales, orders, revenue]
timestamp: 2026-05-28T14:30:00Z
---

# Schema
| Column | Type | Description |
|--------|------|-------------|
| `order_id` | STRING | Globally unique order identifier. |
| `customer_id` | STRING | Foreign key into [customers](/tables/customers.md). |

# Joins
Joined with [customers](/tables/customers.md) on `customer_id`.

# Citations
[1] [BigQuery table schema](https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders)
```

Un **concepto abstracto** (§4.4) no lleva `resource`: p. ej. un `type: Playbook` con secciones `# Trigger` / `# Steps`.

### 2.6 Reserved filenames (§3.1)

Solo **dos** nombres reservados en cualquier nivel de jerarquía, prohibidos como nombres de concepto:

- `index.md` — listado de directorio para *progressive disclosure* (§6).
- `log.md` — historial de actualizaciones (§7).

Cualquier otro archivo `.md` es un concepto. OKF **no** define un formato de archivo por-tag; las tags son únicamente un campo del frontmatter.

### 2.7 Cross-linking (§5)

Enlaces Markdown estándar, en dos formas:

- **Absolutos/relativos-al-bundle** (empiezan con `/`, p. ej. `/tables/customers.md`) — recomendados por estabilidad.
- **Relativos** (`./other.md`).

Un enlace afirma una **relación no tipada** (arista dirigida); el *tipo* de relación (joins-with, depends-on) vive en la prosa circundante, no en el enlace. Los consumidores DEBEN tolerar enlaces rotos (pueden representar "conocimiento aún no escrito").

### 2.8 Index files (§6)

`index.md` puede aparecer en cualquier directorio para progressive disclosure. Los archivos index **no llevan frontmatter** (única excepción: la declaración de versión en el index raíz). El cuerpo son secciones de enlaces con viñetas y descripciones cortas:

```markdown
# Section / Group Heading
* [Title 1](relative-url-1) - short description of item 1
```

> **Tensión interna señalada por la investigación:** §6 dice que los `index.md` "no contienen frontmatter", pero §11 permite `okf_version` solo en el `index.md` raíz. Cómo deben reconciliar esto los consumidores estrictos queda *no especificado* — marcar como incertidumbre.

### 2.9 Log files (§7)

`log.md` opcional, con lo más reciente primero, agrupado por fecha con cabeceras ISO `YYYY-MM-DD`. Las palabras en negrita iniciales (`**Update**`, `**Creation**`, `**Deprecation**`) son convención, no requisito.

```markdown
# Directory Update Log
## 2026-05-22
* **Update**: Added new BigQuery table reference for [Customer Metrics](/tables/customer-metrics.md).
```

### 2.10 Citations (§8)

Las afirmaciones con fuente DEBERÍAN listarse bajo una cabecera `# Citations` al final, numeradas. Los enlaces PUEDEN ser URLs absolutas, rutas relativas al bundle, o rutas hacia un subdirectorio `references/` que refleja material externo como conceptos de primera clase.

### 2.11 Conformance (§9) — un único nivel, no escalonado

Un bundle es conforme con OKF v0.1 si:

1. todo archivo `.md` no reservado tiene un bloque de frontmatter YAML parseable;
2. todo frontmatter tiene un `type` no vacío;
3. `index.md`/`log.md` siguen §6/§7 cuando están presentes.

Los consumidores **NO DEBEN** rechazar un bundle por: campos opcionales faltantes, valores `type` desconocidos, claves extra desconocidas, enlaces rotos, o `index.md` ausente. **No existen niveles de conformidad con nombre** (no hay "core/strict") en v0.1.

### 2.12 Versioning (§11)

Esquema `<major>.<minor>`: minor = adiciones retrocompatibles; major = cambios disruptivos. Un bundle PUEDE declarar su versión objetivo con `okf_version: "0.1"` en el frontmatter del `index.md` **raíz del bundle** — "el único lugar donde se permite frontmatter en un `index.md`". Versiones declaradas desconocidas → consumo de mejor esfuerzo.

---

## 3. Repositorio y tooling (`knowledge-catalog`)

**Repositorio:** `GoogleCloudPlatform/knowledge-catalog`, **Apache-2.0**. Metadatos (API de GitHub): creado **2026-05-04**, último push 2026-06-21, ~5.777 estrellas, 91 issues abiertos en el momento de la consulta. Lleva el descargo: **"This repository and its contents are not an official Google product."** Contribuir requiere el **Google CLA**.

**Layout raíz (verificado vía API):** `okf/`, `samples/`, `toolbox/`, más `LICENSE.md`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.

### 3.1 Directorio `okf/`

- `SPEC.md`, `README.md`, `LICENSE.md`, `pyproject.toml`, `src/`, `tests/`, `samples/`, `bundles/`.
- `okf/src/reference_agent/`: `__main__.py`, `agent.py`, `cli.py`, `runner.py` y subpaquetes `bundle/`, `prompts/`, `sources/`, `tools/`, `viewer/`, `web/`.
- `okf/tests/`: tests de pytest — `test_bigquery_source.py`, `test_bundle_tools.py`, `test_document.py`, `test_index.py`, `test_viewer.py`, `test_web_fetcher.py`, `test_web_tools.py`.
- `okf/bundles/`: tres bundles de ejemplo listos para navegar — `ga4/`, `stackoverflow/`, `crypto_bitcoin/`, cada uno con un `viz.html` incluido.

### 3.2 Reference enrichment agent (PoC de *productor*)

Dos pasadas:

- **Pasada BQ**: escribe un documento OKF por concepto anunciado, a partir de metadatos de BigQuery.
- **Pasada web**: el LLM actúa como crawler sobre URLs semilla (vía una herramienta `fetch_url`), y luego enriquece conceptos existentes, acuña documentos `references/<slug>`, o se salta. Guardarraíles: `--web-max-pages` (límite), `--web-allowed-host` (filtro mismo-dominio), `--no-web` (omitir).

CLI:

```bash
python -m reference_agent enrich \
  --source bq --dataset <project>.<dataset> \
  --web-seed-file <seeds.txt> --out ./bundles/<name>
```

### 3.3 Visualizer (PoC de *consumidor*)

```bash
python -m reference_agent visualize --bundle ./bundles/<name>
```

Emite un `viz.html` autocontenido: grafo force-directed con **Cytoscape.js**, render de markdown con **marked** (ambos desde CDN); backlinks/"Cited by", búsqueda, filtro por tipo, cambio de layout. Ningún dato sale de la página.

### 3.4 Instalación y credenciales

- `python3.13 -m venv .venv` + `pip install -e .[dev]`; tests con `.venv/bin/pytest`.
- BigQuery vía ADC (`gcloud auth application-default login`) + proyecto de facturación.
- Gemini vía `GEMINI_API_KEY` (AI Studio) **o** Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`).

### 3.5 `toolbox/` y `samples/` (preocupación *separada* de la spec OKF)

- `toolbox/`: **"Metadata as Code"** — `mdcode/` (`kcmd`: CLI/librería/**servidor MCP**, con `toolbox/mdcode/src/tool/mcp.ts`) y un agente de enriquecimiento (`enrichment/` / `kcagent`). Estas son herramientas de **Knowledge Catalog**, no estrictamente de OKF.
- `samples/enrichment/`: flujo del agente de enriquecimiento de Knowledge Catalog (descargar metadatos de BigQuery → enriquecer Markdown local → revisar diffs → publicar de vuelta). Incluye `samples/enrichment/sample/config/mcp.json` que define un servidor MCP `fileskb` (un Python `tools/fileskb/main.py --dir <docs>`).

> **Hallazgo relevante:** MCP aparece en el repositorio como **transporte operativo** para exponer una base de conocimiento basada en ficheros (servidor `fileskb`, servidor MCP de `kcmd`), **no como parte de la especificación OKF**.
>
> **No confirmado:** no se halló un validador/linter de conformidad OKF dedicado ("okf-validate") que aplique las reglas de §9; solo existen los tests de pytest, el agente de referencia y el visualizador.

---

## 4. Casos de uso y consumo por agentes

**Modelo productor → consumidor (README de OKF):**

- **Productores**: humanos a mano; agentes sobre cualquier framework (Google ADK, LangChain, custom); pipelines de exportación desde catálogos existentes (Dataplex/Knowledge Catalog, Unity Catalog, Collibra); o scripts que recorren una base de datos.
- **Consumidores**: servidores de ficheros estáticos; UIs de conocimiento (Obsidian, Notion, MkDocs, Hugo, Jekyll); un LLM cargando ficheros en contexto; índices de búsqueda; o visores de grafos.

**Bundles de ejemplo reales (verificados):**

- `bundles/ga4/` — e-commerce de GA4 (contiene `index.md`, `datasets/`, `tables/`, `references/`, `viz.html`).
- `bundles/stackoverflow/` — dataset público de Stack Overflow.
- `bundles/crypto_bitcoin/` — bloques/transacciones de Bitcoin, ejercitando relaciones FK entre tablas en prosa.

Cada ejemplo empareja una **receta** reproducible (`samples/<name>/`: semillas + comando `enrich` exacto) con el **bundle producido** (`bundles/<name>/`).

**Integración con Google Cloud:** el README raíz describe **Knowledge Catalog** (antes Dataplex Universal Catalog) como "un catálogo de datos potenciado por IA… un grafo de conocimiento dinámico… para aportar semántica y contexto de negocio a los agentes de IA". **[VERIFICADO]** El blog de anuncio confirma que **Knowledge Catalog fue actualizado para ingerir OKF y servirlo a los agentes**.

**[VERIFICADO] Mecánica de ingestión (vía `kcmd`, "Metadata as Code"):** la ruta práctica que muestra el repo es:

1. crear/targetear un **EntryGroup** de Dataplex/Knowledge Catalog,
2. colocar el bundle OKF bajo `catalog/`,
3. ejecutar **`kcmd push`**.

El demo OKF mapea cada `.md` a una **entry** de Knowledge Catalog usando el **Documents Layout**: deriva el nombre de la entry de la ruta del fichero, guarda el cuerpo Markdown en el aspecto global **`overview`**, y hace *fallback* a **`dataplex-types.global.generic`** para valores de `type` OKF personalizados que no son type-refs válidos de Dataplex. `kcmd` soporta sync bidireccional (`pull`/`push`). *(Fuentes: `toolbox/mdcode` y `toolbox/mdcode/demo`.)*

**Casos de uso para agentes:** cargar contexto curado de tablas/métricas en la ventana de contexto de un LLM; resolver rutas de join (sección `# Joins`); navegar el grafo de conceptos vía backlinks; enriquecer iterativamente conocimiento generado parcialmente por agentes (la conformidad permisiva mantiene válidos los bundles parciales).

---

## 5. OKF vs A2A vs MCP vs AGENTS.md vs llms.txt

> **Advertencia importante de evidencia.** Se verificó por grep que **A2A, MCP, AGENTS.md, llms.txt, "Agent Card" y "Model Context" NO aparecen en `SPEC.md` ni en `okf/README.md`**. El §10 del SPEC ("Relationship to other formats") solo nombra tres comparadores: **repositorios "wiki" para LLM**, **herramientas de conocimiento personal (Obsidian/Notion)** y **"metadata as code"**, afirmando que OKF "difiere principalmente en estar *especificado*". Por tanto, **la comparativa siguiente es síntesis/interpretación** a partir de las fuentes primarias de cada formato, **no texto normativo de OKF**.

| Formato | Capa | Artefacto | Pregunta que responde | Estructura requerida |
|---|---|---|---|---|
| **OKF** | Conocimiento/contenido | Árbol de directorios Markdown + frontmatter YAML | "¿Qué conocimiento curado existe sobre estos activos?" | `type` requerido; recomendados `title`/`description`/`resource`/`tags`/`timestamp` |
| **A2A Agent Card** | Descubrimiento/manifiesto de capacidades de un agente | Un único JSON en `/.well-known/agent-card.json` | "¿Qué puede hacer este *agente* y cómo lo invoco?" | `name`, `description`, `version`, `supportedInterfaces`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills` |
| **MCP** | Protocolo de runtime | Conexiones cliente/servidor JSON-RPC 2.0 | "¿Cómo se conecta una app a tools/data/prompts en tiempo de ejecución?" | Servidores exponen `resources`, `prompts`, `tools` |
| **AGENTS.md** | Guía operativa de proyecto | Un único Markdown en el repo | "¿Cómo debe trabajar un *agente de código* en este codebase?" | Markdown libre, sin campos requeridos |
| **llms.txt** | Descubrimiento/guía de sitio web | Un único Markdown en la raíz del sitio (`/llms.txt`) | "¿Qué contenido público/docs debería leer un LLM?" | H1 requerido; opcional blockquote-resumen, guía, listas de enlaces H2 |

**Solapamientos y límites (interpretación):**

- **OKF vs llms.txt:** ambos Markdown-first. llms.txt es un *único fichero índice* en la raíz de un sitio para consumo *web en inferencia*; OKF es un *bundle multi-fichero, tipado, cross-enlazado y versionado* (más cercano a una wiki que a un índice raíz plano).
- **OKF vs AGENTS.md:** AGENTS.md son *instrucciones operativas imperativas* (setup, tests, convenciones) acotadas a un repo; OKF es *conocimiento declarativo* sobre activos, independiente de cualquier codebase. AGENTS.md no tiene esquema; OKF exige `type`.
- **OKF vs MCP (el más complementario):** MCP es *cómo* obtener/actuar en runtime; OKF es *qué* se sirve. Un bundle OKF puede ser **servido/buscado/expuesto vía un servidor MCP** — de hecho `kcmd` y el servidor `fileskb` del repo son servidores MCP. Las URIs `resource` de OKF mapean naturalmente sobre los `resources` de MCP.
- **OKF vs A2A Agent Card (el de menor solapamiento):** el Agent Card es un *manifiesto de capacidades del agente* (skills, interfaces, auth); OKF describe *conocimiento sobre datos/activos*, no la superficie invocable de un agente.

**Stack combinado plausible (interpretación):** AGENTS.md indica a un agente de código cómo operar → llms.txt apunta a docs públicos → OKF empaqueta conocimiento tipado profundo → MCP sirve/busca esos bundles y expone tools → los A2A Agent Cards permiten que agentes independientes se anuncien e invoquen entre sí. Cada uno ocupa una ranura distinta; **son complementarios, no competidores**, y OKF no reemplaza a ninguno.

**Linaje (verificado):** Google enmarca OKF como una formalización del patrón "LLM wiki" (bases de conocimiento Markdown persistentes e interconectadas, mantenidas por agentes), explícitamente asociado al gist "LLM-wiki" de Andrej Karpathy.

---

## 6. Madurez, gobernanza, adopción y riesgos

**Madurez/estado.** Etiquetado explícitamente **"Version 0.1 — Draft"**. Es etapa temprana: una versión publicada de la spec, un productor PoC (reference agent), un consumidor PoC (visualizador HTML) y tres bundles de ejemplo. Repo creado 2026-05-04.

**Gobernanza.** Mantenido por **Google Cloud** bajo el org `GoogleCloudPlatform`, **Apache-2.0**, con descargo de **"no es un producto oficial de Google"**. Las contribuciones requieren el **Google CLA**; todos los PRs requieren revisión. **No hay fundación independiente, organismo de estándares ni comité multi-vendor** — la gobernanza es de un solo proveedor (Google), aunque el *formato* se posicione como neutral respecto al proveedor. Contexto de producto: **[VERIFICADO]** Knowledge Catalog es el renombre de **Dataplex Universal Catalog** (efectivo el **10 de abril de 2026** según la doc oficial de Dataplex); las APIs, librerías cliente, comandos `gcloud dataplex` y nombres IAM permanecen sin cambios.

**Neutralidad de proveedor (y su matiz).** El *formato* (Markdown + YAML) es genuinamente portable y sin lock-in. Pero la *gobernanza, autoría de la spec, herramientas de referencia y valores de ejemplo* son Google-céntricos (los `type` por defecto son `BigQuery Table`/`BigQuery Dataset`; el reference agent enriquece desde BigQuery + Gemini/Vertex). **La neutralidad es una propiedad de diseño, no aún una realidad de gobernanza.**

**Riesgos/limitaciones para adoptantes:**

1. **Borrador, gobernanza de un solo proveedor** — sin organismo neutral; posibles cambios disruptivos en saltos de versión mayor; "no es producto oficial".
2. **Conformidad extremadamente permisiva** — solo `type` es obligatorio; **garantías de validación casi nulas**: dos bundles "conformes" pueden ser muy inconsistentes.
3. **Relaciones no tipadas** — los enlaces afirman relaciones pero su *tipo* vive en prosa, no en metadatos legibles por máquina; los consumidores de grafo solo ven aristas dirigidas no tipadas.
4. **Sin taxonomía registrada de `type`** — valores de cadena libre, así que la interoperabilidad semántica entre organizaciones es solo por convención.
5. **Sin modelo de seguridad/confianza/procedencia** en la spec — las citas son convención; no hay firma, integridad ni control de acceso. Los bundles generados por agentes (el reference agent usa un crawler LLM) plantean dudas de confianza en el contenido.
6. **Tooling de referencia explícitamente PoC**, con sabor BigQuery+Gemini; productores/consumidores/validadores de producción quedan a cargo de los adoptantes.

**Adopción.** No hay evidencia de uso en producción por terceros: Collibra, Unity Catalog, etc. se *nombran como posibilidades* en el README, no como integraciones que ya envían.

---

## 7. Fuentes (URLs primarias)

**Evidencia primaria verificada (leída directamente):**

- OKF v0.1 SPEC (normativo): https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md · raw: https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md
- OKF README (reference agent, visualizador, samples, credenciales): https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/README.md
- README raíz del repositorio (framing de Knowledge Catalog/Dataplex, descargo): https://github.com/GoogleCloudPlatform/knowledge-catalog · raw: https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/README.md
- Licencia (Apache-2.0): https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/LICENSE.md
- README de toolbox (`kcmd`/`kcagent`, "Metadata as Code"): https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/toolbox/README.md
- Config MCP de muestra (servidor `fileskb`): https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/samples/enrichment/sample/config/mcp.json
- Estructura del repo (API de contenidos/árboles de GitHub): `okf/`, `samples/`, `toolbox/`; subdirectorios verificados de `okf/src/reference_agent`, `okf/tests`, `okf/bundles/ga4`.

**Evidencia verificada en 2ª pasada (búsqueda dirigida, fuentes primarias):**

- Anuncio de Google Cloud "Introducing the Open Knowledge Format" (12-jun-2026; autores Sam McVeety, Amir Hormati; afirma que Knowledge Catalog ingiere OKF): https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing
- `kcmd` "Metadata as Code" (ruta de ingestión `push`/`pull`, EntryGroup): https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/toolbox/mdcode
- Demo OKF Wiki (mapeo `.md` → entry, aspecto `overview`, fallback `generic`): https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/toolbox/mdcode/demo
- Knowledge Catalog = Dataplex Universal Catalog (renombre 10-abr-2026): https://docs.cloud.google.com/dataplex/docs/introduction

**Fuente primaria aún no recuperada vía HTML directo:**

- Producto Knowledge Catalog: https://cloud.google.com/products/knowledge-catalog

**Fuentes primarias de formatos comparados (para §5):**

- A2A: https://github.com/a2aproject/A2A/blob/main/docs/specification.md · AgentCard: https://a2a-protocol.org/latest/specification/#441-agentcard
- MCP: https://modelcontextprotocol.io/docs/getting-started/intro
- AGENTS.md: https://agents.md/
- llms.txt: https://llmstxt.org/ · https://llmstxt.org/core.html
- Gist LLM-wiki de Karpathy: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

---

## 8. Lagunas de cobertura y qué verificar después

**Ramas fallidas o vacías: 0** (5 de 5 ángulos completados). Estado de las lagunas tras la 2ª pasada de verificación:

1. ~~**HTML del blog no recuperado.**~~ **[CERRADA]** Verificado vía búsqueda dirigida: blog publicado el **12-jun-2026** por **Sam McVeety** y **Amir Hormati**; confirma que **Knowledge Catalog fue actualizado para ingerir OKF y servirlo a agentes**. *(Pendiente menor: si el blog menciona explícitamente AGENTS.md/MCP/A2A no se confirmó palabra por palabra.)*
2. ~~**Mecánica de ingestión OKF → Knowledge Catalog.**~~ **[CERRADA]** Verificado: vía `kcmd push` a un EntryGroup, Documents Layout, cuerpo Markdown en aspecto `overview`, fallback `dataplex-types.global.generic` para `type` custom (ver §4). *(Pendiente menor: si la ingestión está en GA o preview.)*
3. **[ABIERTA] Ausencia de validador de conformidad.** No se localizó un linter/validador `okf-validate` dedicado que aplique §9; solo tests de pytest, el reference agent y el visualizador. La búsqueda de confirmación externa quedó limitada por presupuesto de búsqueda en esta sesión.
4. **[ABIERTA] Taxonomía de `type`.** No hay registro central de valores `type`; sin confirmar si Google publica una lista recomendada. Limitada por presupuesto de búsqueda.
5. **[ABIERTA] Adopción por terceros.** Sin evidencia de export/import real de OKF por Collibra/Unity Catalog u otros más allá de menciones aspiracionales en el README. Limitada por presupuesto de búsqueda.
