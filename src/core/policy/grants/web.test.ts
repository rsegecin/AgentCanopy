import { describe, expect, it } from 'vitest';
import { fetchSite, webCovered } from './web';

describe('fetchSite', () => {
  it.each([
    ['https://example.com/a?b=c', 'example.com'],
    ['http://example.com', 'example.com'],
    ['HTTPS://EXAMPLE.COM/Path', 'example.com'],
    ['https://Docs.Example.com:443/x', 'docs.example.com'],
    ['http://example.com:80/x', 'example.com'],
    ['https://example.com:8443/x', 'example.com:8443'],
    ['http://example.com:443/x', 'example.com:443'],
    ['https://example.com:80/x', 'example.com:80'],
    ['http://[::1]:8080/x', '[::1]:8080'],
    ['http://[2001:DB8::1]/x', '[2001:db8::1]'],
    ['https://bücher.example/x', 'xn--bcher-kva.example'],
    ['https://127.0.0.1:3000/', '127.0.0.1:3000'],
    ['https://example.com./x', 'example.com.'],
    ['https://example.com/a@b', 'example.com'],
  ])('%s gives %s', (address, site) => {
    expect(fetchSite(address)).toBe(site);
  });

  it.each([
    ['a user name', 'https://user@example.com/'],
    ['a user name and password', 'https://user:pw@example.com/'],
    ['a password only', 'https://:pw@example.com/'],
    ['a port that looks like a password, then another host', 'http://example.com:8080@evil.com/'],
    ['a file address', 'file:///etc/passwd'],
    ['an ftp address', 'ftp://example.com/'],
    ['a data address', 'data:text/plain,hi'],
    ['no scheme', 'example.com/x'],
    ['an unparsable address', 'http://'],
    ['nothing', ''],
    ['a backslash', 'https://example.com\\@evil.com/'],
    ['a backslash in the path', 'https://example.com/a\\b'],
    ['a leading space', ' https://example.com/'],
    ['a trailing space', 'https://example.com/ '],
    ['a space inside', 'https://exa mple.com/'],
    ['a newline inside', 'https://exam\nple.com/'],
    ['a tab inside', 'https://exam\tple.com/'],
    ['a control character', 'https://example.com/\u0001'],
    ['a C1 control character', 'https://example.com/\u0085'],
    ['a non-breaking space', 'https://example.com/ '],
  ])('refuses %s', (_name, address) => {
    expect(fetchSite(address)).toBeUndefined();
  });
});

describe('webCovered', () => {
  const none = { switches: [], grants: [] };
  const site = { switches: [], grants: [{ kind: 'web-site' as const, host: 'docs.example.com' }] };

  it('a fetch is covered by its switch or by its saved site, a search only by its switch', () => {
    expect(webCovered(none, true, 'docs.example.com')).toBe(false);
    expect(webCovered(site, true, 'docs.example.com')).toBe(true);
    expect(webCovered(site, true, 'docs.example.com:8443')).toBe(false);
    expect(webCovered(site, true, 'other.example.com')).toBe(false);
    expect(webCovered(site, true, undefined)).toBe(false);
    expect(webCovered({ switches: ['web-fetch'], grants: [] }, true, undefined)).toBe(true);
    expect(webCovered({ switches: ['web-search'], grants: [] }, true, 'x.com')).toBe(false);
    expect(webCovered(site, false, 'docs.example.com')).toBe(false);
    expect(webCovered({ switches: ['web-fetch'], grants: [] }, false, undefined)).toBe(false);
    expect(webCovered({ switches: ['web-search'], grants: [] }, false, undefined)).toBe(true);
  });
});
