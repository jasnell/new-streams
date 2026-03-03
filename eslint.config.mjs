import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/',
      'node_modules/',
      'benchmarks/html/',
      'samples/html/',
      'samples/cloudflare-worker/',
    ],
  },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript recommended (type-aware not needed — keep it fast)
  ...tseslint.configs.recommended,

  // Source files — strict
  {
    files: ['src/**/*.ts'],
    rules: {
      // Allow unused vars when prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // These fire on legitimate patterns in the codebase
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-constant-condition': ['error', { checkLoops: false }],
      // `const self = this` is used in iterator factory methods where
      // closures need a reference to the enclosing class instance
      '@typescript-eslint/no-this-alias': 'off',
    },
  },

  // Test files — relax some rules
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Benchmark and sample files — relaxed
  {
    files: ['benchmarks/**/*.ts', 'samples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-constant-condition': 'off',
      'no-empty': 'off',
      'require-yield': 'off',
    },
  },
);
