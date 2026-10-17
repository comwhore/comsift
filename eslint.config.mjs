import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "excel-modded/**", "userscripts/**", "scripts/**", "tests/**", "*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			// TypeScript resolves globals and ambient types itself (typescript-eslint guidance).
			"no-undef": "off",
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: ["Comsift", "Sherlock", "Maigret", "Jina", "Splink", "Ollama", "Canvas", "Graph View", "Markdown", "Excel"],
				ignoreWords: ["examplePerson"],
			}],
		},
	},
]);
