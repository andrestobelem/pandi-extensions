// json-to-markdown.mjs
// Self-contained, zero-dependency. Converts ANY JSON value into readable Markdown,
// choosing the layout automatically by shape.
//
// Public API:
//   export function jsonToMarkdown(value, opts = {})
//     opts.maxDepth : number (default 4)  -> recursion cap; deeper values become inline code
//     opts.maxRows  : number (default 200) -> row/item cap for tables, lists and sections
//
// The RETURNED STRING may contain backticks / fenced blocks; that is fine because it is a
// runtime value meant to be interpolated via ${...}. Only THIS module's source must be valid JS.

export function jsonToMarkdown(value, opts = {}) {
  const cfg = {
    maxDepth: Number.isFinite(opts.maxDepth) ? opts.maxDepth : 4,
    maxRows: Number.isFinite(opts.maxRows) ? opts.maxRows : 200,
  };
  const out = render(value, cfg, 0, 2);
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

function render(value, cfg, depth, level) {
  if (value === null) return "null";
  if (value === undefined) return "";
  const t = typeof value;
  if (t === "string") return value === "" ? '""' : value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return String(value) + "n";
  if (Array.isArray(value)) return renderArray(value, cfg, depth, level);
  if (t === "object") return renderObject(value, cfg, depth, level);
  return String(value);
}

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

function renderArray(arr, cfg, depth, level) {
  if (arr.length === 0) return "_(lista vacía)_";
  if (depth >= cfg.maxDepth) return "`" + compact(arr) + "`";
  if (arr.every(isPrimitive)) return bulletList(arr, cfg);
  if (canTable(arr)) return table(arr, cfg);
  return sections(arr, cfg, depth, level);
}

function bulletList(arr, cfg) {
  const rows = arr.slice(0, cfg.maxRows);
  const lines = rows.map((v) => "- " + inlineScalar(v));
  if (arr.length > cfg.maxRows) lines.push(`- _… ${arr.length - cfg.maxRows} más_`);
  return lines.join("\n");
}

function sections(arr, cfg, depth, level) {
  const rows = arr.slice(0, cfg.maxRows);
  const hl = "#".repeat(Math.min(level, 6));
  const parts = rows.map(
    (v, i) => `${hl} ${i + 1}.\n\n${render(v, cfg, depth + 1, level + 1)}`,
  );
  if (arr.length > cfg.maxRows) {
    parts.push(`_… ${arr.length - cfg.maxRows} elementos más_`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tables (array of ~uniform objects with primitive cell values)
// ---------------------------------------------------------------------------

function canTable(arr) {
  if (!arr.every(isPlainObject)) return false;
  for (const o of arr) {
    for (const k of Object.keys(o)) {
      if (!isPrimitive(o[k])) return false;
    }
  }
  const keys = orderedKeys(arr);
  if (keys.length === 0) return false;
  let present = 0;
  for (const o of arr) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(o, k)) present++;
    }
  }
  const coverage = present / (arr.length * keys.length);
  return coverage >= 0.6; // "uniform or nearly uniform"
}

function table(arr, cfg) {
  const keys = orderedKeys(arr);
  const rows = arr.slice(0, cfg.maxRows);
  const header = "| " + keys.map((k) => escapeCell(k)).join(" | ") + " |";
  const sep = "| " + keys.map(() => "---").join(" | ") + " |";
  const body = rows
    .map(
      (o) =>
        "| " + keys.map((k) => escapeCell(cellValue(o[k]))).join(" | ") + " |",
    )
    .join("\n");
  let out = [header, sep, body].join("\n");
  if (arr.length > cfg.maxRows) {
    out += `\n\n_… ${arr.length - cfg.maxRows} filas más_`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function renderObject(obj, cfg, depth, level) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "_(objeto vacío)_";
  if (depth >= cfg.maxDepth) return "`" + compact(obj) + "`";
  const lines = [];
  const hl = "#".repeat(Math.min(level, 6));
  for (const k of keys) {
    const v = obj[k];
    if (isPrimitive(v)) {
      lines.push(`- **${escapeInline(k)}**: ${inlineScalar(v)}`);
    } else if (isBig(v)) {
      // Nested collection -> its own heading + recursive block.
      lines.push(`\n${hl} ${escapeInline(k)}\n\n${render(v, cfg, depth + 1, level + 1)}`);
    } else {
      // Empty [] / {} -> keep inline and compact.
      lines.push(`- **${escapeInline(k)}**: ${compact(v)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrimitive(v) {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isBig(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return false;
}

function orderedKeys(arr) {
  const seen = new Set();
  const keys = [];
  for (const o of arr) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

function cellValue(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function inlineScalar(v) {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "string") return escapeInline(v);
  return String(v);
}

// Escape a table cell: keep emojis/unicode, but neutralize pipes, backslashes
// and line breaks so the row stays on a single line.
function escapeCell(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

// Inline (bullet / key-value) text: collapse line breaks so formatting holds.
function escapeInline(s) {
  return String(s).replace(/\r?\n/g, " ");
}

// Compact, length-capped JSON for depth-capped / tiny values.
function compact(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  if (s.length > 200) s = s.slice(0, 197) + "…";
  return s;
}
