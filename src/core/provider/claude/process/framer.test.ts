import { describe, expect, it } from 'vitest';
import { LineFramer } from './framer';

describe('LineFramer', () => {
  it('splits lines across chunks', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('ab'))).toEqual([]);
    expect(f.push(Buffer.from('c\nde'))).toEqual(['abc']);
    expect(f.push(Buffer.from('f\ng\n'))).toEqual(['def', 'g']);
    expect(f.flush()).toEqual([]);
  });

  it('never breaks a multi-byte character split across chunks', () => {
    const f = new LineFramer();
    const bytes = Buffer.from('héllo €uro 😀\n');
    const out: string[] = [];
    for (const byte of bytes) out.push(...f.push(Buffer.from([byte])));
    expect(out).toEqual(['héllo €uro 😀']);
  });

  it('strips one trailing carriage return', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('a\r\nb\r\r\n'))).toEqual(['a', 'b\r']);
  });

  it('skips empty lines', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('\n\na\n\r\n\nb\n'))).toEqual(['a', 'b']);
  });

  it('drops a line over the cap, counts it, and carries on', () => {
    const f = new LineFramer(10);
    const out: string[] = [];
    out.push(...f.push(Buffer.from('short\n')));
    out.push(...f.push(Buffer.from('0123456789')));
    out.push(...f.push(Buffer.from('ABCDEF')));
    out.push(...f.push(Buffer.from('GHI\nnormal\n')));
    expect(out).toEqual(['short', 'normal']);
    expect(f.droppedLines).toBe(1);
  });

  it('accepts a line exactly at the cap', () => {
    const f = new LineFramer(5);
    expect(f.push(Buffer.from('12345\n'))).toEqual(['12345']);
    expect(f.droppedLines).toBe(0);
  });

  it('does not buffer a dropped line', () => {
    const f = new LineFramer(8);
    f.push(Buffer.alloc(1000, 0x61));
    f.push(Buffer.alloc(1000, 0x61));
    expect(f.droppedLines).toBe(1);
    expect(f.push(Buffer.from('\nok\n'))).toEqual(['ok']);
  });

  it('flushes a final unterminated line, once', () => {
    const f = new LineFramer();
    f.push(Buffer.from('one\ntwo'));
    expect(f.flush()).toEqual(['two']);
    expect(f.flush()).toEqual([]);
  });

  it('flush after an over-long unterminated line returns nothing', () => {
    const f = new LineFramer(4);
    f.push(Buffer.from('toolongline'));
    expect(f.flush()).toEqual([]);
    expect(f.droppedLines).toBe(1);
    expect(f.push(Buffer.from('ok\n'))).toEqual(['ok']);
  });
});
