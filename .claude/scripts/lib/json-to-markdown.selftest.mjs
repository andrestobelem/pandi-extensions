import assert from "node:assert/strict";
import { jsonToMarkdown } from "./json-to-markdown.mjs";

// 1) Array de objetos uniformes -> tabla Markdown
const tableIn = {
  totalFrases: 36,
  coordinadas: 36,
  bucketsFallidos: 0,
  pares: [
    { frase: "Buenas, acá ando con ganas de ayudar.", emoji: "🌅", motivo: "Amanecer" },
    { frase: "Bienvenido | sesión clara.\nSegunda línea", emoji: "✨", motivo: "Claridad" },
  ],
};
const tableMd = jsonToMarkdown(tableIn);
assert.match(tableMd, /- \*\*totalFrases\*\*: 36/, "top-level primitive as kv");
assert.match(tableMd, /## pares/, "nested array gets a heading");
assert.match(tableMd, /\| frase \| emoji \| motivo \|/, "table header");
assert.match(tableMd, /\| --- \| --- \| --- \|/, "table separator");
assert.match(tableMd, /🌅/, "emoji preserved");
assert.match(tableMd, /Bienvenido \\\| sesión clara\.<br>Segunda línea/, "pipe escaped + newline -> <br>");

// 2) Objeto anidado -> lista key/value, recursiva con heading para valores grandes
const kvIn = {
  name: "panda",
  active: true,
  meta: { level: 3, tags: ["zen", "calm"] },
};
const kvMd = jsonToMarkdown(kvIn);
assert.match(kvMd, /- \*\*name\*\*: panda/, "string kv");
assert.match(kvMd, /- \*\*active\*\*: true/, "boolean kv");
assert.match(kvMd, /## meta/, "nested object gets heading");
assert.match(kvMd, /- \*\*level\*\*: 3/, "recursed nested primitive");
assert.match(kvMd, /### tags/, "nested array under nested object gets deeper heading");
assert.match(kvMd, /- zen\n- calm/, "primitive array -> bullet list");

// 3) Array de primitivos -> lista con bullets, con tope de maxRows
const listMd = jsonToMarkdown(["a", "b", "c"]);
assert.equal(listMd.trim(), "- a\n- b\n- c", "flat bullet list");

const capped = jsonToMarkdown([1, 2, 3, 4, 5], { maxRows: 2 });
assert.match(capped, /- 1\n- 2\n- _… 3 más_/, "maxRows cap indicates remainder");

// bonus: array heterogéneo -> secciones numeradas
const heteroMd = jsonToMarkdown([{ a: 1 }, 42, "hi"]);
assert.match(heteroMd, /## 1\./, "numbered section 1");
assert.match(heteroMd, /## 2\./, "numbered section 2");

// bonus: passthrough de primitivo simple
assert.equal(jsonToMarkdown("just text").trim(), "just text");

console.log("OK: all json-to-markdown self-tests passed");
