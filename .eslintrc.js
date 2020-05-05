module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  ignorePatterns: ['dist/', 'min/', 'build/', 'node_modules/'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:import/typescript',
    'prettier',
    'prettier/@typescript-eslint',
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  plugins: ['import', '@typescript-eslint'],
  rules: {
    '@typescript-eslint/object-literal-sort-keys': 0,
    '@typescript-eslint/max-classes-per-file': 0,
    '@typescript-eslint/no-console': 0,
    '@typescript-eslint/no-bitwise': 0,
    '@typescript-eslint/explicit-function-return-type': 0,
    '@typescript-eslint/no-explicit-any': 0,
    '@typescript-eslint/': 0,
    '@typescript-eslint/prefer-for-of': 1,
    '@typescript-eslint/camelcase': ['error', { properties: 'never' }],
    'no-tabs': 'error',
    'import/no-cycle': 0,
  },
};
