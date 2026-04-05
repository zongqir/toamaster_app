#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const env = {...process.env};
const isWeappBuild = args.includes('--type') && args.includes('weapp');

function copyDirRecursive(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;

  fs.rmSync(targetDir, {recursive: true, force: true});
  fs.mkdirSync(targetDir, {recursive: true});

  for (const entry of fs.readdirSync(sourceDir, {withFileTypes: true})) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

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

if ((result.status ?? 1) === 0 && isWeappBuild) {
  const distDir = path.join(ROOT, 'dist');
  const legacyWeappDir = path.join(ROOT, 'dist-weapp');

  copyDirRecursive(distDir, legacyWeappDir);
  console.log(`Synced weapp build output to ${legacyWeappDir}`);
}

process.exit(result.status ?? 1);
