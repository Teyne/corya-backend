// ESLint 9 flat config for @corya/backend.
// Spec: @typescript-eslint recommended-type-checked + project rules.
// NOTE: we intentionally do NOT depend on @eslint/js — the founder validated
// only eslint + typescript-eslint. typescript-eslint's recommendedTypeChecked
// preset already enables the core rules we need.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // scripts/copy-templates.mjs is a plain post-build helper (no TS
    // parsing needed) — excluded so the typed lint stack doesn't complain
    // about it living outside the TS project graph.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/**/*.mjs'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off', // handled by @typescript-eslint/no-unused-vars
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // Config/build files sit outside the TS project graph.
    files: ['vitest.config.ts', 'vitest.e2e.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
    },
  },
);
