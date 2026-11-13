import type { ImageMediaType } from '../../shared';

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The bytes of a base64 text, or undefined when it is not strictly base64 (alphabet, padding, length).
 * Node's decoder is lenient, so the shape is checked first and the decoded length afterwards.
 */
export function decodeBase64(data: string): Buffer | undefined {
  if (!BASE64_SHAPE.test(data) || data.length % 4 !== 0) return undefined;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = Buffer.from(data, 'base64');
  return bytes.length === (data.length / 4) * 3 - padding ? bytes : undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Whether the first bytes are those of the declared image type. */
export function matchesImageSignature(mediaType: ImageMediaType, bytes: Uint8Array): boolean {
  switch (mediaType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'));
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8);
  }
}
