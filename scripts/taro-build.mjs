#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const env = {...process.env};

// Work around Windows spawn issues with esbuild by pinning a known executable.
if (process.platform === 'win32' && !env.ESBUILD_BINARY_PATH) {
  const esbuildWinPath = path.join(
    ROOT,
    'node_modules',
    '.pnpm',
    '@esbuild+win32-x64@0.21.5',
    'node_modules',
    '@esbuild',
    'win32-x64',
    'esbuild.exe'
  );
  if (fs.existsSync(esbuildWinPath)) {
    env.ESBUILD_BINARY_PATH = esbuildWinPath;
  }
}

const result = spawnSync('pnpm', ['exec', 'taro', 'build', ...args], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

process.exit(result.status ?? 1);
