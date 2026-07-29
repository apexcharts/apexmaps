import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // `const { series: _series, ...rest } = options` names a key in order to
          // *exclude* it from the rest, which is a use rather than an oversight.
          ignoreRestSiblings: true,
        },
      ],
      // The geo and topojson ecosystems are loosely typed at their boundaries, and
      // forcing them into precise shapes obscures more than it protects.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // `**/dist/**` rather than `dist/**`: the wrappers build into their own dist,
    // and linting a minified bundle reports a hundred things about terser's output.
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'examples/data/**'],
  },
]
