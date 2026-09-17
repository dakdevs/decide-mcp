import { defineConfig } from "@dakdevs/oxlint-plugin/config";

export default defineConfig({
  presets: ["recommended", "testing"],
  ignorePatterns: ["node_modules/**", "dist/**", "coverage/**"],
  rules: {
    "typescript/consistent-type-imports": "error",
    "quality/extensionless-relative-code-imports": "error",
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "\\.[cm]?[jt]sx?$",
            message:
              "Use extensionless imports. Package subpaths requiring extensions belong in package.json imports.",
          },
        ],
      },
    ],
  },
});
