import { describe, expect, it } from 'vitest';
import { dispositionName, isPublicAddress, openUpstream, ProxyError } from './linkProxy';

describe('isPublicAddress', () => {
  it('refuses this machine, the LAN and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.2'])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '151.101.1.140', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe('dispositionName', () => {
  it('reads plain and RFC 5987 filenames', () => {
    expect(dispositionName('inline; filename="1706.03762v7.pdf"')).toBe('1706.03762v7.pdf');
    expect(dispositionName('attachment; filename=paper.pdf')).toBe('paper.pdf');
    expect(dispositionName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf; filename=\"resume.pdf\"")).toBe('résumé.pdf');
    expect(dispositionName(undefined)).toBeNull();
  });
});

describe('openUpstream', () => {
  const signal = new AbortController().signal;
  it('rejects non-web schemes and private targets before connecting', async () => {
    await expect(openUpstream('file:///etc/passwd', false, signal)).rejects.toBeInstanceOf(ProxyError);
    await expect(openUpstream('http://127.0.0.1:1/x.pdf', false, signal)).rejects.toThrow(/local network/);
    await expect(openUpstream('http://[::1]:1/', false, signal)).rejects.toThrow(/local network/);
    await expect(openUpstream('http://localhost:1/', false, signal)).rejects.toThrow(/local network/);
    await expect(openUpstream('not a url', false, signal)).rejects.toThrow(/web link/);
  });
});

describe('CookieJar', () => {
  it('shares Domain cookies across subdomains and refuses foreign domains', async () => {
    const { CookieJar } = await import('./linkProxy');
    const jar = new CookieJar();
    jar.store('link.springer.com', 'trackid="abc"; Domain=.springer.com; Path=/; secure');
    jar.store('link.springer.com', 'local=1; Path=/');
    jar.store('link.springer.com', 'evil=1; Domain=example.com');
    expect(jar.header('idp.springer.com')).toBe('trackid="abc"');
    expect(jar.header('link.springer.com')).toBe('trackid="abc"; local=1');
    expect(jar.header('example.com')).toBe('');
    jar.store('idp.springer.com', 'trackid=; Domain=springer.com; Max-Age=0');
    expect(jar.header('link.springer.com')).toBe('local=1');
  });
});
