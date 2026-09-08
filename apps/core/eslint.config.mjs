import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
    { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
    {
        files: ["**/*.ts"],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        rules: {
            // Heterogeneous tool registries intentionally erase generic inputs
            // at registration; do not rewrite these public contracts for lint.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", {
                argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none",
            }],
            "prefer-const": "warn",
            "no-useless-assignment": "warn",
            "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],
            "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
            // IPC and credential sanitizers intentionally reject control bytes.
            "no-control-regex": "off",
        },
    },
    {
        files: ["ui/**/*.js"],
        extends: [js.configs.recommended],
        languageOptions: {
            sourceType: "script",
            globals: {
                window: "readonly", document: "readonly", performance: "readonly",
                EventSource: "readonly", ResizeObserver: "readonly", IntersectionObserver: "readonly",
            },
        },
    },
);
