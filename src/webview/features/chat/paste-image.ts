import { ImageMediaTypeSchema } from '../../../shared';

/** The parts of a `DataTransfer` that `pastedImage` reads. Every part is optional. */
export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
  getData?(format: string): string;
}

const IMAGE_TYPES: readonly string[] = ImageMediaTypeSchema.options;

/**
 * The first supported image on the clipboard, or undefined. Spreadsheets, documents and browsers put
 * text and an image on the clipboard together: when there is text, the paste is a text paste.
 */
export function pastedImage(clipboard: ClipboardLike | null | undefined): File | undefined {
  if (!clipboard) return undefined;
  const text = clipboard.getData?.('text/plain') ?? '';
  if (text !== '') return undefined;

  for (const file of Array.from(clipboard.files ?? [])) {
    if (IMAGE_TYPES.includes(file.type)) return file;
  }
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file' || !IMAGE_TYPES.includes(item.type)) continue;
    const file = item.getAsFile();
    if (file && IMAGE_TYPES.includes(file.type)) return file;
  }
  return undefined;
}

const CHUNK = 0x8000;

/** Base64 text of `bytes`. The webview has no Buffer; chunking keeps large inputs off the call stack limit. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A byte count for display: `850 B`, `120 KB`, `1.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${String(kb)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
