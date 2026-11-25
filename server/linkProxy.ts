/**
 * Link import proxy: `GET /api/fetch?url=…` downloads a document from the web on the reader's
 * behalf. Browsers can't fetch most paper sites directly (no CORS headers), so Folio's own server
 * (vite dev / vite preview) fetches it and streams the bytes back.
 *
 * Safety: only http(s); every hop of a redirect chain is re-checked; hostnames are resolved
 * through a lookup that refuses loopback, private-LAN, link-local and other non-public addresses
 * (checked at connect time, so DNS rebinding can't slip past); responses are capped at 600 MB.
 */
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';

const MAX_BYTES = 600 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const IDLE_TIMEOUT = 30_000;

export class ProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True for addresses on the public internet (not this machine, the LAN, link-local, …). */
export function isPublicAddress(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && ip.split('.')[2] === '0') return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    return true;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (/^f[cd]/.test(v)) return false; // unique local
    if (/^fe[89ab]/.test(v)) return false; // link-local
    if (/^ff/.test(v)) return false; // multicast
    return true;
  }
  return false;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A dns.lookup that refuses non-public addresses. */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, list) => {
      if (err) return cb(err, '');
      const addrs = list as dns.LookupAddress[];
      if (!allowPrivate && addrs.some((a) => !isPublicAddress(a.address))) {
        return cb(Object.assign(new Error('blocked address'), { code: 'EFOLIOBLOCKED' }), '');
      }
      if (options.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/** An honest client name: sites' bot filters flag clients that claim to be a browser but aren't. */
const UA = 'Mozilla/5.0 (compatible; Folio/0.1; document import)';

function get(url: URL, cookies: string, allowPrivate: boolean, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/pdf,application/epub+zip,text/html;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en;q=0.9,*;q=0.5',
          ...(cookies ? { Cookie: cookies } : {}),
        },
        lookup: guardedLookup(allowPrivate) as never,
        signal,
      },
      resolve,
    );
    req.setTimeout(IDLE_TIMEOUT, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

function checkUrl(url: URL, allowPrivate: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProxyError(400, 'Only http and https links can be opened.');
  if (url.username || url.password) throw new ProxyError(400, 'Links with a username or password are not supported.');
  // IP literals skip DNS lookup, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && !isPublicAddress(host)) throw new ProxyError(403, 'Links to this computer or your local network can’t be opened.');
}

function statusMessage(status: number) {
  if (status === 401 || status === 403) return `The site refused the download (${status}). It may need you to sign in or have a subscription — try the paper’s open-access PDF link.`;
  if (status === 404 || status === 410) return `Nothing was found at that link (${status}).`;
  if (status === 429) return 'The site is limiting downloads right now (429). Try again in a minute.';
  return `The site answered with an error (${status}).`;
}

function networkMessage(e: unknown, host: string) {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EFOLIOBLOCKED') return new ProxyError(403, 'Links to this computer or your local network can’t be opened.');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProxyError(502, `Couldn’t find the site “${host}”. Check the link and your connection.`);
  if (code === 'ETIMEDOUT') return new ProxyError(504, `“${host}” took too long to respond.`);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return new ProxyError(502, `Couldn’t connect to “${host}”.`);
  if (typeof code === 'string' && /CERT|SSL|TLS/.test(code)) return new ProxyError(502, `“${host}” has an invalid security certificate.`);
  return new ProxyError(502, `Couldn’t download from “${host}”.`);
}

/** Filename from a Content-Disposition header. */
export function dispositionName(h: string | undefined): string | null {
  if (!h) return null;
  const star = h.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = h.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}

/** A minimal per-download cookie jar honouring the Domain attribute (paths are ignored). */
export class CookieJar {
  private cookies = new Map<string, { domain: string; hostOnly: boolean; value: string }>(); // `${domain};${name}` → cookie

  store(host: string, setCookie: string) {
    const [pair, ...attrs] = setCookie.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = host;
    let hostOnly = true;
    let expired = false;
    for (const a of attrs) {
      const [k, v = ''] = a.split('=').map((s) => s.trim());
      if (/^domain$/i.test(k) && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (host !== d && !host.endsWith(`.${d}`)) return; // a cookie for some other site: refuse
        domain = d;
        hostOnly = false;
      }
      if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
      if (/^expires$/i.test(k) && Date.parse(v) < Date.now()) expired = true;
    }
    const key = `${domain};${name}`;
    if (expired) this.cookies.delete(key);
    else this.cookies.set(key, { domain, hostOnly, value });
  }

  header(host: string): string {
    return [...this.cookies.entries()]
      .filter(([, c]) => host === c.domain || (!c.hostOnly && host.endsWith(`.${c.domain}`)))
      .map(([k, c]) => `${k.slice(k.indexOf(';') + 1)}=${c.value}`)
      .join('; ');
  }
}

/** Follow redirects (re-checking every hop) and return the final response. */
export async function openUpstream(target: string, allowPrivate: boolean, signal: AbortSignal): Promise<{ res: IncomingMessage; url: URL }> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new ProxyError(400, 'That doesn’t look like a web link.');
  }
  const jar = new CookieJar();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkUrl(url, allowPrivate);
    let res: IncomingMessage;
    try {
      res = await get(url, jar.header(url.hostname), allowPrivate, signal);
    } catch (e) {
      throw networkMessage(e, url.hostname);
    }
    // Some publishers (Springer, Nature…) bounce through a sign-in host that sets a cookie for
    // the whole site and redirects back; without it the redirects loop forever.
    for (const c of res.headers['set-cookie'] ?? []) jar.store(url.hostname, c);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status >= 400) {
      res.resume();
      throw new ProxyError(502, statusMessage(status));
    }
    return { res, url };
  }
  throw new ProxyError(502, 'The link redirected too many times.');
}

function sendError(res: ServerResponse, e: unknown) {
  const err = e instanceof ProxyError ? e : new ProxyError(500, 'The download failed.');
  if (!(e instanceof ProxyError)) console.error('[folio link import]', e);
  if (res.headersSent) return res.destroy();
  res.writeHead(err.status, { 'Content-Type': 'application/json', 'X-Folio-Proxy': '1', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: err.message }));
}

export function linkProxy(opts: { allowPrivate?: boolean } = {}): Connect.NextHandleFunction {
  const allowPrivate = !!opts.allowPrivate;
  return (req, res, next) => {
    if (!req.url || !/^\/api\/fetch(\?|$)/.test(req.url)) return next();
    if (req.method !== 'GET') return sendError(res, new ProxyError(405, 'Method not allowed.'));
    const target = new URL(req.url, 'http://folio').searchParams.get('url');
    if (!target) return sendError(res, new ProxyError(400, 'No link was given.'));

    const ctrl = new AbortController();
    res.on('close', () => !res.writableFinished && ctrl.abort());

    void (async () => {
      try {
        const { res: up, url } = await openUpstream(target, allowPrivate, ctrl.signal);
        const len = Number(up.headers['content-length']);
        if (len > MAX_BYTES) {
          up.destroy();
          throw new ProxyError(413, 'That file is larger than 600 MB.');
        }
        const name = dispositionName(up.headers['content-disposition']);
        res.writeHead(200, {
          'Content-Type': up.headers['content-type'] || 'application/octet-stream',
          ...(len ? { 'Content-Length': String(len) } : {}),
          'X-Folio-Proxy': '1',
          'X-Final-Url': encodeURI(url.href),
          ...(name ? { 'X-Filename': encodeURIComponent(name) } : {}),
          'Cache-Control': 'no-store',
        });
        let seen = 0;
        up.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > MAX_BYTES) {
            up.destroy();
            res.destroy();
          }
        });
        up.on('error', () => res.destroy());
        up.pipe(res);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        sendError(res, e);
      }
    })();
  };
}

/** Vite plugin: serves the link-import proxy from both `vite` (dev) and `vite preview`. */
export function linkImport(): Plugin {
  const mw = () => linkProxy({ allowPrivate: process.env.FOLIO_LINK_ALLOW_PRIVATE === '1' });
  return {
    name: 'folio-link-import',
    configureServer: (s) => void s.middlewares.use(mw()),
    configurePreviewServer: (s) => void s.middlewares.use(mw()),
  };
}
