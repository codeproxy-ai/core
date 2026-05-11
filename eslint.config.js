import { ai0x0 as ai0x0Plugin, allRestrictions } from '@ai0x0/utils/eslint-config/index.js';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ai0x0Plugin.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': ['error', ...allRestrictions],
    },
  },
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      curly: 'error',
      'max-lines': ['error', { max: 550, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'max-lines': 'off',
      'ai0x0/no-one-letter-vars': 'off',
      'ai0x0/require-section-divider': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
