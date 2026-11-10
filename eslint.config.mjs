import js from "@eslint/js";
import ts from "typescript-eslint";

const boundaries = {
  "packages/contracts": [],
  "packages/core": ["contracts"],
  "packages/image": ["contracts"],
  "packages/renderer": ["contracts", "core"],
  "packages/application": ["contracts", "core", "image"],
  "packages/platform": ["contracts"],
  "packages/storage": ["application", "contracts", "core", "platform"],
  "packages/sdk": ["contracts", "platform"],
  "apps/studio": ["contracts", "core", "renderer"],
  "apps/mcp": ["contracts", "sdk"],
  "apps/cli": ["contracts", "mcp", "sdk", "service"],
};
export default ts.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  ...Object.entries(boundaries).map(([directory, allowed]) => ({
    files: [directory + "/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: allowed.length
                ? "^@riloom/(?!(?:" + allowed.join("|") + ")$)"
                : "^@riloom/",
              message:
                "Import only public packages allowed by this module's dependency direction.",
            },
            {
              group: [
                "**/packages/*/src/**",
                "**/apps/*/src/**",
                "../../*/src/**",
              ],
              message: "Use the package's public exports.",
            },
          ],
        },
      ],
    },
  })),
);
