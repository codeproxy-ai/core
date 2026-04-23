import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'providers/claude/index': 'src/providers/claude/index.ts',
      'providers/zai/index': 'src/providers/zai/index.ts',
      'server/index': 'src/server/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'es2020',
    splitting: false,
    sourcemap: true,
    treeshake: true,
  },
  {
    entry: { 'server/cli': 'src/server/cli.ts' },
    format: ['esm'],
    clean: false,
    target: 'es2020',
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    outExtension: () => ({ js: '.js' }),
    noExternal: ['../utils/config', '../types/config'],
  },
]);
