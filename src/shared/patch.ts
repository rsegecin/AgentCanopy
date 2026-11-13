import type { PatchOp, StatePath } from './protocol';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function checkSegment(container: Container, segment: string | number, path: StatePath): void {
  if (Array.isArray(container)) {
    if (typeof segment !== 'number')
      throw new Error(`patch path ${JSON.stringify(path)}: expected an index`);
  } else if (typeof segment !== 'string' || FORBIDDEN.has(segment)) {
    throw new Error(`patch path ${JSON.stringify(path)}: invalid key`);
  }
}

function child(container: Container, segment: string | number): unknown {
  return (container as Record<string | number, unknown>)[segment];
}

/** Returns a copy of `container` with `segment` replaced by `update(old)`, or removed when it returns REMOVE. */
const REMOVE = Symbol('remove');

function withChild(container: Container, segment: string | number, value: unknown): Container {
  if (Array.isArray(container)) {
    const copy = container.slice();
    const index = segment as number;
    if (value === REMOVE) {
      copy.splice(index, 1);
    } else {
      if (index > copy.length) throw new Error(`patch index ${String(index)} is past the end`);
      copy[index] = value;
    }
    return copy;
  }
  const copy: Record<string, unknown> = { ...container };
  if (value === REMOVE) delete copy[segment as string];
  else copy[segment as string] = value;
  return copy;
}

function update(
  node: unknown,
  path: StatePath,
  depth: number,
  apply: (old: unknown) => unknown,
): unknown {
  if (depth === path.length) return apply(node);
  if (!isContainer(node))
    throw new Error(`patch path ${JSON.stringify(path)}: nothing at depth ${String(depth)}`);
  const segment = path[depth] as string | number;
  checkSegment(node, segment, path);
  return withChild(node, segment, update(child(node, segment), path, depth + 1, apply));
}

/**
 * Applies patch operations to a state value and returns the new value. Never mutates its input:
 * every container on the changed path is copied, everything else is shared.
 * The host uses the same function to change its own state, so a view that applies every patch
 * in order holds exactly the host's state.
 */
export function applyPatch<T>(state: T, ops: readonly PatchOp[]): T {
  let current: unknown = state;
  for (const op of ops) {
    if (op.path.length === 0 && op.op !== 'set') throw new Error('only "set" may target the root');
    switch (op.op) {
      case 'set':
        current = update(current, op.path, 0, () => op.value);
        break;
      case 'push':
        current = update(current, op.path, 0, (old) => {
          if (!Array.isArray(old))
            throw new Error(`patch push: ${JSON.stringify(op.path)} is not an array`);
          return [...(old as unknown[]), op.value];
        });
        break;
      case 'appendText':
        current = update(current, op.path, 0, (old) => {
          if (typeof old !== 'string')
            throw new Error(`patch appendText: ${JSON.stringify(op.path)} is not text`);
          return old + op.text;
        });
        break;
      case 'delete':
        current = update(current, op.path, 0, () => REMOVE);
        break;
    }
  }
  return current as T;
}
