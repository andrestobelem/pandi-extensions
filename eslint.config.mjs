// ESLint flat config (ESLint 10 + typescript-eslint v8, type-aware).
//
// Scope: TypeScript extensions under extensions/ get type-aware linting; all
// .mjs files (test scripts, fixtures, this config) are linted as plain Node
// ESM without type info. Markdown is intentionally left to markdownlint-cli2,
// and generated Pi artifacts under .pi/** are excluded. Prettier owns all
// formatting, so eslint-config-prettier is applied LAST to disable conflicting
// style rules.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

const noUnusedVars = [
	"error",
	{
		argsIgnorePattern: "^_",
		varsIgnorePattern: "^_",
		caughtErrorsIgnorePattern: "^_",
	},
];

export default tseslint.config(
	{
		ignores: ["node_modules/**", ".pi/**", "dist/**", ".cache/**", "coverage/**", "**/*.md"],
	},
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		// Type-aware linting for the extension sources. projectService discovers
		// the root tsconfig.json (which already includes extensions/**/*.ts).
		files: ["extensions/**/*.ts"],
		extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": noUnusedVars,
			// The extensions cross the dynamic boundary of pi event payloads and
			// persisted JSON state (parsed as `any`), so the no-unsafe-* family
			// fires systematically without catching real bugs here. The
			// high-value async-safety rules (no-floating-promises /
			// no-misused-promises) stay as errors. Re-enable these once those
			// boundaries are properly typed.
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			// pi tool execute()/command handlers must be async by API contract
			// even when a particular branch has no await.
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-explicit-any": "warn",
			// Several hits are defensive initializers / idempotent cleanup writes
			// in async orchestration paths; keep them visible without blocking.
			"no-useless-assignment": "warn",
			// stylisticTypeChecked: `||`→`??` changes falsy handling at runtime, so
			// surface as warn (review case-by-case) instead of mass-rewriting.
			"@typescript-eslint/prefer-nullish-coalescing": "warn",
			// No-op callbacks (e.g. fire-and-forget `.catch(() => {})`) are
			// intentional throughout the async orchestration code.
			"@typescript-eslint/no-empty-function": "off",
		},
	},
	{
		// Plain Node ESM: not part of the TS project, so disable type-checked
		// rules to avoid "file not included in project" errors.
		files: ["**/*.mjs"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			globals: globals.node,
		},
		rules: {
			"@typescript-eslint/no-unused-vars": noUnusedVars,
			// Test fixtures match ANSI escape sequences (\x1b) on purpose.
			"no-control-regex": "off",
			"no-useless-assignment": "warn",
		},
	},
	eslintConfigPrettier,
);
