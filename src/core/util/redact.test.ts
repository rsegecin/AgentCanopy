import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { redact, redactWith, tail } from './redact';

const MAC = { home: '/Users/alice', platform: 'darwin' } as const;
const LINUX = { home: '/home/alice', platform: 'linux' } as const;
const WIN = { home: 'C:\\Users\\Alice', platform: 'win32' } as const;

function clean(text: string, env: Parameters<typeof redactWith>[1] = MAC): string {
  return redactWith(text, env);
}

describe('tokens', () => {
  const secrets: [string, string, string][] = [
    ['anthropic key', 'key sk-ant-api03-AbCdEfGh1234567890_xyz', 'AbCdEfGh1234567890'],
    [
      'anthropic oauth',
      'CLAUDE_CODE_OAUTH_TOKEN is sk-ant-oat01-abcdefghij0123456789',
      'abcdefghij',
    ],
    ['openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnop'],
    ['openai plain', 'use sk-abcdefghijklmnopqrstuvwx now', 'abcdefghijklmnop'],
    ['github classic', 'ghp_0123456789abcdefghijABCDEFGHIJ012345', '0123456789abcdef'],
    ['github oauth', 'gho_0123456789abcdefghijABCDEFGHIJ012345', '0123456789abcdef'],
    ['github server', 'ghs_0123456789abcdefghijABCDEFGHIJ012345', '0123456789abcdef'],
    ['github user', 'ghu_0123456789abcdefghijABCDEFGHIJ012345', '0123456789abcdef'],
    [
      'github fine grained',
      'github_pat_11ABCDEFG0abcdefghijkl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV',
      '11ABCDEFG0abcdefghijkl',
    ],
    // Split so the literal does not match GitHub's Slack token scanner.
    ['slack', 'xoxb-' + '123456789012-1234567890123-abcdefghijklmnopqrstuvwx', '123456789012'],
    ['slack user', 'xoxp-123456789012-abcdefghij', '123456789012'],
    ['aws access key', 'id AKIAIOSFODNN7EXAMPLE here', 'IOSFODNN7EXAMPLE'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ],
    ['bearer', 'Authorization: Bearer abcdefgh12345678', 'abcdefgh12345678'],
    ['bearer lower case', 'authorization: bearer abcdefgh12345678', 'abcdefgh12345678'],
    ['basic', 'Authorization: Basic YWxpY2U6aHVudGVyMg==', 'YWxpY2U6aHVudGVyMg'],
    [
      'pem',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXk',
    ],
    [
      'url user info',
      'fatal: unable to access https://alice:hunter2secret@github.com/acme/repo.git',
      'hunter2secret',
    ],
    [
      'url token user info',
      'https://x-access-token:abcdef0123456789abcdef@github.com/acme/repo.git',
      'abcdef0123456789',
    ],
    ['env token', 'ANTHROPIC_AUTH_TOKEN=abcdef0123456789abcdef0123456789', 'abcdef0123456789'],
    ['env secret', 'MY_SECRET=hunter2', 'hunter2'],
    ['env key', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['env password quoted', 'DB_PASSWORD="p4ssw0rd!" other', 'p4ssw0rd'],
    ['env auth', 'X_AUTH=abc123', 'abc123'],
    ['lower case token', 'token=Zk3vQ1pXh0c2Jw8n5t7y9u1i3o5p7a9s1d3f5g7h9j0&x=1', 'Zk3vQ1pXh'],
    [
      'hook url secret',
      'POST http://127.0.0.1:53211/hook/Zk3vQ1pXh0c2Jw8n5t7y9u1i3o5p7a9s1d3f5g7h9j0/pre failed',
      'Zk3vQ1pXh0c2',
    ],
    [
      'mcp route',
      'POST http://127.0.0.1:53211/mcp/Zk3vQ1pXh0c2Jw8n5t7y9u1i3o5p7a9s1d3f5g7h9j0 failed',
      'Zk3vQ1pXh0c2',
    ],
  ];

  it.each(secrets)('redacts %s', (_label, text, secret) => {
    const out = clean(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps the scheme and the host of a URL with user info', () => {
    expect(clean('https://alice:hunter2@github.com/acme/repo.git')).toBe(
      'https://[redacted]@github.com/acme/repo.git',
    );
  });

  it('keeps the name and surrounding text of an assignment', () => {
    expect(clean('run API_TOKEN=abc123 then exit')).toBe('run API_TOKEN=[redacted] then exit');
    expect(clean('a=1 b=2 PASSWORD=x&y=2')).toBe('a=1 b=2 PASSWORD=[redacted]&y=2');
  });

  it('keeps the word in front of a bearer value', () => {
    expect(clean('Bearer abcdefgh12345678, ok')).toBe('Bearer [redacted], ok');
  });

  it('leaves ordinary text alone', () => {
    for (const text of [
      'Basic information about the task',
      'a task-list with sk-short',
      'the key is in the door',
      'GET /mcp/short and /hook/x',
      'package.json: a=b, c==d',
      'version 1.2.3 of pkg@1.2.3',
      'ghp_short',
    ]) {
      expect(clean(text, LINUX)).toBe(text);
    }
  });

  it('redacts an unterminated PEM block to the end', () => {
    expect(clean('x -----BEGIN PRIVATE KEY-----\nabc')).toBe('x [redacted]');
  });
});

describe('email addresses', () => {
  const addresses = [
    'alice@example.com',
    'alice+tag@example.com',
    'jörg.müller@example.com',
    'alice@münchen.de',
    'алиса@пример.рф',
    'login_hint=alice%40example.com',
    'alice%40example.com',
    '{"email":"alice@example.com","organization":"Acme Corp"}',
    "o'brien@example.co.uk",
  ];
  it.each(addresses)('redacts %s', (text) => {
    const out = clean(text, LINUX);
    expect(out).toContain('[redacted]');
    expect(out).not.toMatch(/alice|jörg|müller|алиса|brien/);
  });

  it('keeps the text around an address', () => {
    expect(clean('mail alice@example.com, thanks', LINUX)).toBe('mail [redacted], thanks');
    expect(clean('{"email":"alice@example.com"}', LINUX)).toBe('{"email":"[redacted]"}');
  });

  it('redacts adjacent addresses', () => {
    expect(clean('a@x.org b@y.org', LINUX)).toBe('[redacted] [redacted]');
  });

  it('does not redact things that are not addresses', () => {
    for (const text of [
      '@',
      'a@',
      '@b.com',
      'user@localhost',
      'pkg@1.2.3',
      'Logged in as Alice (Max plan)',
      'x@y.',
    ]) {
      expect(clean(text, LINUX)).toBe(text);
    }
  });
});

describe('home directory', () => {
  const cases: [string, string, Parameters<typeof redactWith>[1], string][] = [
    [
      'posix path',
      "ENOENT: open '/Users/alice/Library/x.json'",
      MAC,
      "ENOENT: open '~/Library/x.json'",
    ],
    ['lower case on darwin', "open '/users/alice/proj/x.json'", MAC, "open '~/proj/x.json'"],
    ['upper case on darwin', "open '/USERS/ALICE/proj/x.json'", MAC, "open '~/proj/x.json'"],
    ['file uri', 'file:///Users/alice/proj/a.ts', MAC, 'file://~/proj/a.ts'],
    [
      'uri encoded space',
      'file:///Users/alice%20smith/proj/a.ts',
      { home: '/Users/alice smith', platform: 'darwin' },
      'file://~/proj/a.ts',
    ],
    ['windows path', "open 'C:\\Users\\Alice\\AppData\\x.json'", WIN, "open '~\\AppData\\x.json'"],
    ['windows lower drive', "open 'c:\\Users\\Alice\\x.json'", WIN, "open '~\\x.json'"],
    ['windows lower case path', "open 'c:\\users\\alice\\x.json'", WIN, "open '~\\x.json'"],
    ['windows forward slashes', 'C:/Users/Alice/proj', WIN, '~/proj'],
    [
      'windows json escaped',
      JSON.stringify({ p: 'C:\\Users\\Alice\\proj' }),
      WIN,
      '{"p":"~\\\\proj"}',
    ],
    ['windows uri', 'file:///c%3A/Users/Alice/proj', WIN, 'file:///~/proj'],
    ['windows uri lower hex', 'file:///c%3a/users/alice/proj', WIN, 'file:///~/proj'],
    ['wsl path', '/mnt/c/Users/Alice/proj', WIN, '~/proj'],
    [
      'claude project folder',
      '/x/.claude/projects/-Users-alice-Documents-proj/abc.jsonl',
      MAC,
      '/x/.claude/projects/~-Documents-proj/abc.jsonl',
    ],
    [
      'windows dashed folder',
      '.claude/projects/C--Users-Alice-proj/a.jsonl',
      WIN,
      '.claude/projects/~-proj/a.jsonl',
    ],
    ['linux realpath of a symlinked home', '/data/home/alice/proj/file', LINUX, '/data~/proj/file'],
  ];

  it.each(cases)('redacts %s', (_label, text, env, expected) => {
    expect(redactWith(text, env)).toBe(expected);
  });

  it('is case sensitive on linux', () => {
    expect(redactWith('/HOME/ALICE/x and /home/alice/x', LINUX)).toBe('/HOME/ALICE/x and ~/x');
  });

  it('does not touch another user with the same prefix', () => {
    expect(redactWith('/Users/alice2/proj', MAC)).toBe('/Users/alice2/proj');
    expect(redactWith('/Users/alice-b/proj', MAC)).toBe('/Users/alice-b/proj');
    expect(redactWith('-Users-alice2-Documents', MAC)).toBe('-Users-alice2-Documents');
    expect(redactWith('user alice (uid 501)', MAC)).toBe('user alice (uid 501)');
  });

  it('handles a home that is too short to be meaningful', () => {
    expect(redactWith('/a/b', { home: '/', platform: 'linux' })).toBe('/a/b');
    expect(redactWith('/a/b', { home: '', platform: 'linux' })).toBe('/a/b');
  });

  describe('through the real home directory', () => {
    const realHome = process.env.HOME;
    afterEach(() => {
      process.env.HOME = realHome;
    });

    it('follows HOME', () => {
      process.env.HOME = '/Users/zed';
      if (homedir() !== '/Users/zed') return; // not a POSIX platform
      expect(redact('open /Users/zed/x and /Users/zed/y')).toBe('open ~/x and ~/y');
    });
  });
});

describe('performance', () => {
  const homes = [MAC, WIN];
  const inputs: [string, string][] = [
    ['letters', 'a'.repeat(400_000)],
    ['a@ repeated', 'a@'.repeat(200_000)],
    ['@ only', '@'.repeat(400_000)],
    ['sk- repeated', 'sk-'.repeat(133_000)],
    ['eyJ repeated', 'eyJ'.repeat(133_000)],
    ['xoxb- repeated', 'xoxb-'.repeat(80_000)],
    ['equals', '='.repeat(400_000)],
    ['key= repeated', 'key='.repeat(100_000)],
    ['bearer repeated', 'Bearer '.repeat(57_000)],
    ['scheme repeated', '://'.repeat(133_000)],
    ['begin repeated', '-----BEGIN '.repeat(36_000)],
    ['slashes', '/'.repeat(400_000)],
    ['home prefix repeated', '/Users/alic'.repeat(36_000)],
    ['dots and at', 'a.'.repeat(100_000) + '@' + 'b.'.repeat(100_000)],
    ['percent forty', '%40'.repeat(133_000)],
    ['long local and domain', ('a'.repeat(60) + '@' + 'b'.repeat(250)).repeat(1200)],
  ];

  it.each(inputs)('stays fast on %s', (_label, input) => {
    for (const env of homes) {
      const start = performance.now();
      redactWith(input, env);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
});

describe('tail', () => {
  it('keeps the end of a text', () => {
    expect(tail('abcdef', 3)).toBe('def');
    expect(tail('abc', 5)).toBe('abc');
  });
});
