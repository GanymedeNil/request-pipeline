import js from '@eslint/js';
import globals from 'globals';

const extension = { ...globals.webextensions };

export default [
    { ignores: ['node_modules/', 'dist/'] },
    js.configs.recommended,
    {
        rules: {
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'prefer-const': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['background.js', 'config.js', 'lib/**/*.js'],
        languageOptions: { globals: { ...globals.serviceworker, ...extension } },
    },
    {
        files: ['popup.js'],
        languageOptions: { globals: { ...globals.browser, ...extension } },
    },
    {
        files: ['test/**/*.js', 'e2e/**/*.js', 'scripts/**/*.js', '*.config.js'],
        languageOptions: { globals: { ...globals.node } },
    },
    {
        // Callbacks passed to page.evaluate() run inside the extension's pages.
        files: ['e2e/**/*.js', 'scripts/store-assets.js'],
        languageOptions: { globals: { ...globals.browser, ...extension } },
    },
];
