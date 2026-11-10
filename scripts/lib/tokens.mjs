import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { contrastRatio } from './contrast.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOKENS_PATH = join(ROOT, 'shared/design/tokens.json');
export const SCHEMA_PATH = join(ROOT, 'shared/design/tokens.schema.json');

export function loadTokens() {
  return JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
}

export function validateTokens(tokens) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const validate = ajv.compile(schema);
  if (!validate(tokens)) {
    return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
  }
  return [];
}

/** Returns a list of human-readable contrast failures for both themes. */
export function checkContrast(tokens) {
  const failures = [];
  const rules = [
    ['AA', 4.5],
    ['AALarge', 3],
    ['nonText', 3],
  ];
  for (const theme of ['light', 'dark']) {
    const palette = tokens.color[theme];
    for (const [group, min] of rules) {
      for (const [fg, bg] of tokens.contrast[group]) {
        if (!palette[fg] || !palette[bg]) {
          failures.push(`${theme}: unknown token in pair ${fg}/${bg}`);
          continue;
        }
        const ratio = contrastRatio(palette[fg], palette[bg]);
        if (ratio < min) {
          failures.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
        }
      }
    }
  }
  return failures;
}
