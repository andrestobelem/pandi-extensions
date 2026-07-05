// util.mjs — helpers compartidos mínimos para los módulos de workflow-artifact.

// Clave para de-dup y agrupación: quita los índices numéricos o de escalación al final de un label ("skeptic-3" -> "skeptic").
export const norm = (l) => String(l || "agent").replace(/(-e?\d+)+$/i, "").replace(/-\d+$/g, "");
// Las entries de meta.phases pueden ser strings simples ("asignacion") U objetos ({ title: "discover" }).
export const phaseTitleOf = (p) => (typeof p === "string" ? p : p && p.title);
