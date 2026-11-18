import { describe, expect, it } from 'vitest';
import { projectSlug } from './claude-memory';

describe('projectSlug', () => {
  it('turns a Windows folder into the name the CLI uses', () => {
    expect(projectSlug('d:\\NSources\\AgentCanopy')).toBe('d--NSources-AgentCanopy');
  });

  it('turns a POSIX folder into the name the CLI uses', () => {
    expect(projectSlug('/Users/rinaldi/Documents/Sources/pixlox_app3')).toBe(
      '-Users-rinaldi-Documents-Sources-pixlox-app3',
    );
  });

  it('turns a character outside the BMP into two dashes', () => {
    expect(projectSlug('/a\u{1F600}b')).toBe('-a--b');
  });

  it('keeps a slug of 200 characters and gives none for 201', () => {
    expect(projectSlug('a'.repeat(200))).toBe('a'.repeat(200));
    expect(projectSlug('a'.repeat(201))).toBeUndefined();
  });
});
