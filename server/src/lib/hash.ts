import { createHash } from 'node:crypto';

/** Deterministic JSON serialization: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 truncated to the first 16 hex chars, as required by design §6.9. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

export function contentHash(value: unknown): string {
  return shortHash(canonicalJson(value));
}

export const HASH_RE = /^[a-f0-9]{16}$/;
