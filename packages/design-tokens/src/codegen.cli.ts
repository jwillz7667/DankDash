import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSwift } from './codegen.js';
import { tokens } from './tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const swiftPath = resolve(
  repoRoot,
  'DankDashKit/Sources/DankDashDesignSystem/Generated/Tokens.swift',
);
const jsonPath = resolve(packageRoot, 'dist/tokens.json');

mkdirSync(dirname(swiftPath), { recursive: true });
writeFileSync(swiftPath, emitSwift());

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(tokens, null, 2) + '\n');

process.stdout.write(`design-tokens: wrote ${swiftPath}\n`);
process.stdout.write(`design-tokens: wrote ${jsonPath}\n`);
