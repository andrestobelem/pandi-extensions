#!/usr/bin/env bash
# format-workflows.sh — format .claude/workflows/*.js to pi's biome house style
# (tabs, indentWidth 3, lineWidth 120, double quotes) and VERIFY the reformat changed
# only cosmetics (no logic). Re-run whenever these scaffolds drift in quotes/indent/format.
#
# Why a dedicated config (and not the root biome.jsonc / `npm run format`):
#   These scaffolds are TOP-LEVEL scripts — `export const meta = {…}` followed by a
#   top-level `return`. That is invalid as a standalone JS module, so biome's parser
#   rejects it with "Illegal return statement outside of a function", and biome has no
#   flag to allow top-level return. So they can't join the `biome check` gate.
#   `formatWithErrors: true` (.claude/scripts/biome-workflows.jsonc) lets the FORMATTER
#   apply anyway; biome's own non-zero exit on those parse errors is EXPECTED and is
#   swallowed below. Verified: a biome-reformatted top-level script still runs in Claude
#   Code's Workflow tool, so this normalization is safe.
#
# Usage:
#   bash .claude/scripts/format-workflows.sh           # format + verify all
#   CHECK_ONLY=1 bash .claude/scripts/format-workflows.sh   # report drift, change nothing
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

DIR=".claude/workflows"
CFG=".claude/scripts/biome-workflows.jsonc"
STRIP=" \t\n\"',;()\\"   # tokens biome may legitimately change: ws, quotes, ; , parens, escaping

# --- CHECK_ONLY: report drift, touch nothing -----------------------------------------
# biome's exit code can't be used here (these files ALWAYS exit non-zero on the
# top-level-return parse error), so format each file via stdin (bypasses files.includes
# and respects formatWithErrors) and compare against the on-disk content.
if [ "${CHECK_ONLY:-0}" = "1" ]; then
	drift=0
	for f in "$DIR"/*.js; do
		formatted=$(npx biome format --config-path "$CFG" --stdin-file-path="$f" < "$f" 2>/dev/null)
		if [ -n "$formatted" ] && [ "$formatted" != "$(cat "$f")" ]; then
			echo "  drift: $f"
			drift=1
		fi
	done
	if [ "$drift" = "1" ]; then
		echo "[format-workflows] drift detected — run without CHECK_ONLY to apply."
		exit 1
	fi
	echo "[format-workflows] ✅ already formatted, no drift."
	exit 0
fi

# --- snapshot BEFORE so we can isolate biome's effect regardless of git state ---------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$DIR"/*.js "$TMP/"

echo "[format-workflows] formatting $DIR/*.js (pi style: tabs, double quotes, 120 cols)…"
# biome exits non-zero on the expected top-level-return parse errors — ignore it.
npx biome format --write --config-path "$CFG" "$DIR/" >/dev/null 2>&1 || true

# --- verify: tokenized (quotes/ws/escaping stripped) content must be unchanged --------
changed=0
fail=0
for f in "$DIR"/*.js; do
	base="$(basename "$f")"
	old="$(tr -d "$STRIP" < "$TMP/$base")"
	new="$(tr -d "$STRIP" < "$f")"
	[ "$(cat "$TMP/$base")" != "$(cat "$f")" ] && changed=$((changed + 1))
	if [ "$old" != "$new" ]; then
		echo "  ⚠ LOGIC CHANGE in $f — biome altered more than formatting; review before committing"
		fail=1
	fi
done

echo "[format-workflows] files reformatted: $changed/$(ls "$DIR"/*.js | wc -l | tr -d ' ')"
if [ "$fail" = "0" ]; then
	echo "[format-workflows] ✅ verified: only cosmetic changes (quotes/indent/format), no logic."
else
	echo "[format-workflows] ❌ a file changed beyond formatting (see ⚠ above) — do NOT commit blindly."
	exit 1
fi
