import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** A new random id. UUIDs are used because the provider requires them for session ids. */
export function newId<T extends string = string>(): T {
  return randomUUID() as T;
}

/** A random token for URLs and bearer auth: 256 bits, URL-safe. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Compares two secrets without leaking where they differ. */
export function secretsEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
