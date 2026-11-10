import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

const STORAGE_MESSAGE =
  'Use src/lib/storage.ts for UI preferences only; tokens and secrets must never go to Web Storage.';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'test-results',
      'playwright-report',
      'src/styles/tokens.ts',
      'src/lib/api/schema.gen.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strict, jsxA11y.flatConfigs.strict],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Context modules export their provider together with its hook by design.
      'react-refresh/only-export-components': 'off',
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: STORAGE_MESSAGE },
        { name: 'sessionStorage', message: STORAGE_MESSAGE },
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].flatMap((object) => [
          { object, property: 'localStorage', message: STORAGE_MESSAGE },
          { object, property: 'sessionStorage', message: STORAGE_MESSAGE },
        ]),
      ],
    },
  },
  {
    // The only modules allowed to touch Web Storage: the preference wrapper and test setup (unit and e2e).
    files: ['src/lib/storage.ts', 'src/test/**', 'src/**/*.test.{ts,tsx}', 'e2e/**'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
);
