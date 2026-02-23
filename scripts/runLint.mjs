#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = process.cwd();

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  return result.status ?? 1;
}

function getFilesRecursively(dir, exts) {
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFilesRecursively(fullPath, exts));
      continue;
    }
    if (exts.some((ext) => fullPath.endsWith(ext))) {
      files.push(fullPath);
    }
  }

  return files;
}

function getLineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function readTabBarPages() {
  const appConfigPath = path.join(ROOT, 'src', 'app.config.ts');
  if (!fs.existsSync(appConfigPath)) {
    return [];
  }
  const source = fs.readFileSync(appConfigPath, 'utf8');
  const matches = [...source.matchAll(/pagePath:\s*['"]([^'"]+)['"]/g)];
  return matches.map((match) => `/${match[1]}`);
}

function checkNoNavigateToTabPage() {
  const tabPages = new Set(readTabBarPages());
  const files = getFilesRecursively(path.join(ROOT, 'src'), ['.ts', '.tsx']);
  const offenders = [];

  // Check navigateTo/redirectTo that point to tabBar pages.
  const navigationCallRegex =
    /(?:Taro\.)?(navigateTo|redirectTo)\s*\(\s*\{[\s\S]{0,220}?url\s*:\s*(['"`])([^'"`]+)\2[\s\S]{0,220}?\}\s*\)/g;

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(navigationCallRegex)) {
      const method = match[1];
      const url = match[3];

      if (!url || url.includes('${') || !url.startsWith('/pages/')) {
        continue;
      }

      const pathOnly = url.split('?')[0];
      if (!tabPages.has(pathOnly)) {
        continue;
      }

      offenders.push({
        filePath,
        line: getLineNumber(source, match.index ?? 0),
        method,
        url
      });
    }
  }

  if (offenders.length === 0) {
    return 0;
  }

  console.error('\n[lint] Found invalid tab page navigation (use Taro.switchTab for tab pages):');
  for (const offender of offenders) {
    const rel = path.relative(ROOT, offender.filePath).replace(/\\/g, '/');
    console.error(`  - ${rel}:${offender.line} ${offender.method} -> ${offender.url}`);
  }
  return 1;
}

function checkNoAbsoluteTabBarIconPath() {
  const appConfigPath = path.join(ROOT, 'src', 'app.config.ts');
  if (!fs.existsSync(appConfigPath)) {
    return 0;
  }

  const source = fs.readFileSync(appConfigPath, 'utf8');
  const regex = /(iconPath|selectedIconPath)\s*:\s*['"]\/[^'"]*['"]/g;
  const offenders = [...source.matchAll(regex)];

  if (offenders.length === 0) {
    return 0;
  }

  console.error('\n[lint] Found absolute tabBar icon path(s), remove the leading "/":');
  for (const offender of offenders) {
    const line = getLineNumber(source, offender.index ?? 0);
    console.error(`  - src/app.config.ts:${line} ${offender[0]}`);
  }
  return 1;
}

function checkReferencedPagesDeclared() {
  const appConfigPath = path.join(ROOT, 'src', 'app.config.ts');
  if (!fs.existsSync(appConfigPath)) {
    return 0;
  }

  const appConfig = fs.readFileSync(appConfigPath, 'utf8');
  const declaredPages = new Set(
    [...appConfig.matchAll(/['"]pages\/([a-zA-Z0-9-]+\/index)['"]/g)].map((m) => `/pages/${m[1]}`)
  );

  const files = getFilesRecursively(path.join(ROOT, 'src'), ['.ts', '.tsx']);
  const missing = [];
  const regex = /['"]\/pages\/([a-zA-Z0-9-]+\/index)(?:\?[^'"]*)?['"]/g;

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(regex)) {
      const refPath = `/pages/${match[1]}`;
      if (declaredPages.has(refPath)) {
        continue;
      }
      missing.push({
        filePath,
        line: getLineNumber(source, match.index ?? 0),
        refPath
      });
    }
  }

  if (missing.length === 0) {
    return 0;
  }

  console.error('\n[lint] Found page route reference(s) that are not declared in src/app.config.ts:');
  for (const item of missing) {
    const rel = path.relative(ROOT, item.filePath).replace(/\\/g, '/');
    console.error(`  - ${rel}:${item.line} ${item.refPath}`);
  }
  return 1;
}

let exitCode = 0;

exitCode |= run('pnpm', ['exec', 'biome', 'check', '--write', '--unsafe', '--diagnostic-level=error']);
exitCode |= run('pnpm', ['exec', 'tsgo', '-p', 'tsconfig.check.json']);
exitCode |= checkNoNavigateToTabPage();
exitCode |= checkNoAbsoluteTabBarIconPath();
exitCode |= checkReferencedPagesDeclared();

process.exit(exitCode);
