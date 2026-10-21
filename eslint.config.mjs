import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: [".aws-sam/**", ".local/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Removing keys from plain data objects (patches, DynamoDB items) is intended.
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
)
