import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "excel-modded/**", "userscripts/**", "scripts/**", "tests/**", "*.mjs"] },
	...obsidianmd.configs.recommended,
...tseslint.configs.recommendedTypeCheckedOnly,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			// TypeScript resolves globals and ambient types itself (typescript-eslint guidance).
			"no-undef": "off",
"@typescript-eslint/no-unsafe-call": "error",
"@typescript-eslint/no-unsafe-member-access": "error",
"@typescript-eslint/no-unsafe-assignment": "error",
"@typescript-eslint/no-unsafe-argument": "error",
"@typescript-eslint/no-unsafe-return": "error",
"@typescript-eslint/only-throw-error": "error",
"@typescript-eslint/prefer-promise-reject-errors": "error",
"@typescript-eslint/no-unnecessary-type-assertion": "error",
"@typescript-eslint/require-await": "off",
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: ["Comsift", "Sherlock", "Maigret", "Jina", "Splink", "Ollama", "Canvas", "Graph View", "Markdown", "Excel"],
				ignoreWords: ["examplePerson"],
			}],
		},
	},
]);
