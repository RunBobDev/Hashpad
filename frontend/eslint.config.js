import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // SPEC §10: no `any` without a comment justifying it. The rule forbids it
      // outright; a justified use is silenced with an inline eslint-disable
      // carrying the reason, which makes every exception visible in review.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { ignores: ['dist/', 'wailsjs/'] },
);
