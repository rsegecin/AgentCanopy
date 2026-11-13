/**
 * Live test of an image turn against the real Claude Code CLI. It makes real model calls on the
 * signed-in account, so it only runs through `npm run test:live`. Prompts are tiny and the model is
 * Haiku. The provider is driven directly: the image travels as one stream-json line on stdin.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentProvider, TurnRequest } from '../../src/core/contracts';
import { createHostToolServer } from '../../src/core/mcp-host';
import { createClaudeProvider } from '../../src/core/provider/claude';
import { ensurePrivateDir, newId } from '../../src/core/util';
import type { AgentEvent } from '../../src/shared';

const DIGITS = '5381';

// A 5 by 7 bitmap for each digit.
const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** A grayscale PNG of black digits on a white background, drawn from the bitmap font. */
function digitsPng(digits: string, scale = 12, margin = 2): Uint8Array {
  const cells = digits.length * 6 - 1 + margin * 2;
  const rows = 7 + margin * 2;
  const width = cells * scale;
  const height = rows * scale;
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter type: none
    const row = Math.floor(y / scale) - margin;
    if (row < 0 || row >= 7) continue;
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(x / scale) - margin;
      if (cell < 0) continue;
      const index = Math.floor(cell / 6);
      if (cell % 6 === 5 || index >= digits.length) continue;
      const glyph = FONT[digits[index] as string];
      if (glyph?.[row]?.[cell % 6] === '1') raw[y * (width + 1) + 1 + x] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const server = createHostToolServer();
let provider: AgentProvider;
let scratch: string;
const sessionId = newId();

beforeAll(async () => {
  provider = createClaudeProvider({ claudePath: () => '' });
  await server.start();
  scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agc-live-image-')));
  await fs.mkdir(join(scratch, 'work'));
});

afterAll(async () => {
  await server.stop();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function runTurn(
  prompt: string,
  session: TurnRequest['session'],
  images?: TurnRequest['images'],
): Promise<{ text: string; outcome: string | undefined }> {
  const registration = server.registerTurn(
    { onPermissionRequest: () => Promise.resolve({ behavior: 'deny', message: 'no' }) },
    { toolHooks: false },
  );
  try {
    const runDir = join(scratch, `run-${newId()}`);
    await ensurePrivateDir(runDir);
    const handle = provider.startTurn({
      cwd: join(scratch, 'work'),
      prompt,
      ...(images ? { images } : {}),
      mode: 'ask',
      model: 'haiku',
      session,
      profile: { kind: 'read-only', webTools: false, planTool: false },
      host: registration.endpoint,
      systemPromptAppend: 'Answer as briefly as you can.',
      runDir,
    });
    const events: AgentEvent[] = [];
    for await (const event of handle.events) events.push(event);
    await handle.done;
    const result = events.find((e) => e.type === 'result');
    return {
      text: events.map((e) => (e.type === 'text-delta' ? e.text : '')).join(''),
      outcome: result?.type === 'result' ? result.outcome : undefined,
    };
  } finally {
    registration.dispose();
  }
}

describe('An image turn against the real CLI', () => {
  it('is installed, new enough and signed in', async () => {
    const status = await provider.detect();
    expect(status.installed).toBe(true);
    expect(status.meetsMinimum).toBe(true);
    expect(status.auth).toBe('signed-in');
  });

  it('reads the digits in a pasted image', async () => {
    const data = digitsPng(DIGITS);
    const result = await runTurn(
      'The image shows a number made of digits. Reply with only those digits.',
      { kind: 'new', sessionId },
      [{ mediaType: 'image/png', data }],
    );
    expect(result.outcome).toBe('completed');
    expect(result.text.replace(/\D/g, '')).toContain(DIGITS);
  }, 170_000);

  it('still knows the digits on the next, text-only turn of the same session', async () => {
    const result = await runTurn(
      'Which digits were in the image I sent before? Reply with only those digits.',
      { kind: 'resume', sessionId },
    );
    expect(result.outcome).toBe('completed');
    expect(result.text.replace(/\D/g, '')).toContain(DIGITS);
  }, 170_000);
});
