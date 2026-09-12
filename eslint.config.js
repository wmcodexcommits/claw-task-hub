import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'test-results', 'logs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Type-aware async safety for the server, which is where the data layer
    // lives. A data access call that returns a promise is only correct when it
    // is awaited: a dropped await on a write leaves the statement unfinished
    // while the next one runs, which is exactly the interleaving
    // server/async-mutex.ts exists to prevent. These three rules need type
    // information, so they cannot come from the untyped recommended config.
    //
    // Only these rules are enabled rather than recommendedTypeChecked: the goal
    // is a safety net for promises, not a sweep of unrelated stylistic findings.
    //
    // The parser is pointed at tsconfig.server.json explicitly because the root
    // tsconfig.json references only the app and node projects, so projectService
    // would not find these files in any project.
    files: ['server/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.server.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
])
