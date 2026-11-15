import { describe, expect, it } from 'vitest';
import { formatBytes, pastedImage, toBase64 } from './paste-image';

/** Independent reference: one character per byte, no chunking. */
function reference(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}

describe('toBase64', () => {
  it('matches known vectors', () => {
    expect(toBase64(new Uint8Array([]))).toBe('');
    expect(toBase64(new Uint8Array([0]))).toBe('AA==');
    expect(toBase64(new Uint8Array([255, 0, 1]))).toBe('/wAB');
    expect(toBase64(new TextEncoder().encode('Hello'))).toBe('SGVsbG8=');
  });

  it('matches the reference for a 1 MB input without overflowing the call stack', () => {
    const input = new Uint8Array(1024 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = (i * 31 + 7) % 256;
    expect(toBase64(input)).toBe(reference(input));
  });

  it('handles a view that does not start at the beginning of its buffer', () => {
    const input = Uint8Array.from([9, 8, 7, 6, 5, 4]).subarray(2, 5);
    expect(toBase64(input)).toBe(reference(Uint8Array.from([7, 6, 5])));
  });
});

describe('formatBytes', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(850)).toBe('850 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(120 * 1024)).toBe('120 KB');
    expect(formatBytes(1024 * 1024 - 1)).not.toBe('1024 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(Math.round(1.4 * 1024 * 1024))).toBe('1.4 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('pastedImage', () => {
  const png = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
  const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
  const item = (file: File) => ({ kind: 'file', type: file.type, getAsFile: () => file });

  it('returns an image from files', () => {
    expect(pastedImage({ files: [svg, png], getData: () => '' })).toBe(png);
  });

  it('returns an image from items', () => {
    const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };
    expect(pastedImage({ items: [textItem, item(svg), item(png)], getData: () => '' })).toBe(png);
  });

  it('works when getData is missing', () => {
    expect(pastedImage({ files: [png] })).toBe(png);
  });

  it('ignores the image when the clipboard also has text', () => {
    expect(
      pastedImage({ files: [png], items: [item(png)], getData: () => 'a cell' }),
    ).toBeUndefined();
  });

  it('ignores unsupported image types and empty clipboards', () => {
    expect(pastedImage({ files: [svg], items: [item(svg)], getData: () => '' })).toBeUndefined();
    expect(pastedImage({})).toBeUndefined();
    expect(pastedImage(null)).toBeUndefined();
    expect(pastedImage(undefined)).toBeUndefined();
  });

  it('asks for the plain text format', () => {
    const asked: string[] = [];
    pastedImage({
      files: [png],
      getData: (format) => {
        asked.push(format);
        return '';
      },
    });
    expect(asked).toEqual(['text/plain']);
  });
});
