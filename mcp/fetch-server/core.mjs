import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export const FETCH_TOOL_NAME = 'fetch';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_BYTES = 500_000;
const MAX_MAX_BYTES = 1_000_000;

const DEFAULT_MAX_REDIRECTS = 3;
const MAX_MAX_REDIRECTS = 5;

const USER_AGENT = 'LibreChat-MCP-Fetch/0.1';

export class ToolError extends Error {
  /** @type {string} */
  code;

  /** @type {unknown} */
  details;

  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function getFetchToolDefinition() {
  return {
    name: FETCH_TOOL_NAME,
    description: 'HTTP(S) GET-only fetch with SSRF protections and strict caps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
        },
        maxBytes: {
          type: 'integer',
          minimum: 1024,
          maximum: MAX_MAX_BYTES,
          default: DEFAULT_MAX_BYTES,
        },
        maxRedirects: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_MAX_REDIRECTS,
          default: DEFAULT_MAX_REDIRECTS,
        },
      },
    },
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBoundedInt(value, { field, min, max, defaultValue }) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError('INVALID_INPUT', `${field} must be an integer`, { field });
  }
  if (value < min || value > max) {
    throw new ToolError('INVALID_INPUT', `${field} must be between ${min} and ${max}`, {
      field,
      min,
      max,
    });
  }
  return value;
}

export function parseFetchToolInput(raw) {
  if (!isPlainObject(raw)) {
    throw new ToolError('INVALID_INPUT', 'arguments must be an object');
  }
  const url = raw.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new ToolError('INVALID_INPUT', 'url must be a non-empty string');
  }

  const timeoutMs = parseBoundedInt(raw.timeoutMs, {
    field: 'timeoutMs',
    min: 1,
    max: MAX_TIMEOUT_MS,
    defaultValue: DEFAULT_TIMEOUT_MS,
  });

  const maxBytes = parseBoundedInt(raw.maxBytes, {
    field: 'maxBytes',
    min: 1024,
    max: MAX_MAX_BYTES,
    defaultValue: DEFAULT_MAX_BYTES,
  });

  const maxRedirects = parseBoundedInt(raw.maxRedirects, {
    field: 'maxRedirects',
    min: 0,
    max: MAX_MAX_REDIRECTS,
    defaultValue: DEFAULT_MAX_REDIRECTS,
  });

  return { url, timeoutMs, maxBytes, maxRedirects };
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) {
      return null;
    }
    const n = Number(p);
    if (n < 0 || n > 255) {
      return null;
    }
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip) {
  const input = ip.toLowerCase();

  const ipv4Index = input.lastIndexOf('.');
  const hasEmbeddedIpv4 = ipv4Index !== -1;

  let left = input;
  /** @type {number[] | null} */
  let embeddedV4Hextets = null;

  if (hasEmbeddedIpv4) {
    const lastColon = input.lastIndexOf(':');
    const v4Part = input.slice(lastColon + 1);
    const v4Int = ipv4ToInt(v4Part);
    if (v4Int === null) {
      throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
    }
    embeddedV4Hextets = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    left = input.slice(0, lastColon) + ':0:0';
  }

  const [headRaw, tailRaw] = left.split('::');
  const head = headRaw ? headRaw.split(':').filter((s) => s.length > 0) : [];
  const tail = tailRaw ? tailRaw.split(':').filter((s) => s.length > 0) : [];
  if (left.includes('::') === false && head.length + tail.length !== 8) {
    throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
  }

  const headNums = head.map((h) => {
    if (!/^[0-9a-f]{1,4}$/.test(h)) {
      throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
    }
    return parseInt(h, 16);
  });
  const tailNums = tail.map((h) => {
    if (!/^[0-9a-f]{1,4}$/.test(h)) {
      throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
    }
    return parseInt(h, 16);
  });

  let hextets = [];
  if (left.includes('::')) {
    const missing = 8 - (headNums.length + tailNums.length);
    if (missing < 0) {
      throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
    }
    hextets = [...headNums, ...Array.from({ length: missing }, () => 0), ...tailNums];
  } else {
    hextets = [...headNums, ...tailNums];
  }

  if (embeddedV4Hextets) {
    hextets[6] = embeddedV4Hextets[0];
    hextets[7] = embeddedV4Hextets[1];
  }

  if (hextets.length !== 8) {
    throw new ToolError('INVALID_INPUT', 'Invalid IPv6 address');
  }

  let result = 0n;
  for (const h of hextets) {
    result = (result << 16n) + BigInt(h);
  }
  return result;
}

function ipv6InCidr(addr, prefix, bits) {
  const shift = 128n - BigInt(bits);
  return (addr >> shift) === (prefix >> shift);
}

export function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const v = ipv4ToInt(ip);
    if (v === null) {
      return true;
    }
    const inCidr = (base, maskBits) => {
      const mask = maskBits === 0 ? 0 : (~0 >>> (32 - maskBits)) << (32 - maskBits);
      return (v & mask) === (base & mask);
    };
    const base = (a, b, c, d) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

    return (
      inCidr(base(0, 0, 0, 0), 8) ||
      inCidr(base(10, 0, 0, 0), 8) ||
      inCidr(base(100, 64, 0, 0), 10) ||
      inCidr(base(127, 0, 0, 0), 8) ||
      inCidr(base(169, 254, 0, 0), 16) ||
      inCidr(base(172, 16, 0, 0), 12) ||
      inCidr(base(192, 168, 0, 0), 16) ||
      inCidr(base(192, 0, 0, 0), 24) ||
      inCidr(base(192, 0, 2, 0), 24) ||
      inCidr(base(198, 18, 0, 0), 15) ||
      inCidr(base(198, 51, 100, 0), 24) ||
      inCidr(base(203, 0, 113, 0), 24) ||
      inCidr(base(224, 0, 0, 0), 4) ||
      inCidr(base(240, 0, 0, 0), 4)
    );
  }
  if (version === 6) {
    const addr = ipv6ToBigInt(ip);

    if (addr === 0n || addr === 1n) {
      return true;
    }

    if ((addr >> 32n) === 0xffffn) {
      const v4 = Number(addr & 0xffff_ffffn);
      const ip4 = `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
      return isPrivateIp(ip4);
    }

    const fc00 = 0xfc00_0000_0000_0000_0000_0000_0000_0000n;
    const fe80 = 0xfe80_0000_0000_0000_0000_0000_0000_0000n;
    const ff00 = 0xff00_0000_0000_0000_0000_0000_0000_0000n;
    const doc = 0x2001_0db8_0000_0000_0000_0000_0000_0000n;

    return (
      ipv6InCidr(addr, fc00, 7) ||
      ipv6InCidr(addr, fe80, 10) ||
      ipv6InCidr(addr, ff00, 8) ||
      ipv6InCidr(addr, doc, 32)
    );
  }
  return true;
}

function normalizeHostname(hostname) {
  return hostname.replace(/\.$/, '').toLowerCase();
}

function isBlockedHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (h === 'localhost') {
    return true;
  }
  return h.endsWith('.local') || h.endsWith('.internal');
}

async function assertUrlAllowed(urlString, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new ToolError('INVALID_URL', 'Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('INVALID_URL', 'Only http:// and https:// URLs are allowed', {
      protocol: url.protocol,
    });
  }
  if (url.username || url.password) {
    throw new ToolError('INVALID_URL', 'Userinfo in URL is not allowed');
  }
  if (!url.hostname) {
    throw new ToolError('INVALID_URL', 'URL hostname is required');
  }

  if (isBlockedHostname(url.hostname)) {
    throw new ToolError('SSRF_BLOCKED', 'Blocked hostname', { hostname: url.hostname });
  }

  const ipVersion = net.isIP(url.hostname);
  if (ipVersion !== 0) {
    if (isPrivateIp(url.hostname)) {
      throw new ToolError('SSRF_BLOCKED', 'Blocked IP address', { host: url.hostname });
    }
    return url;
  }

  let addrs;
  try {
    addrs = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ToolError('DNS_FAILED', 'DNS lookup failed', {
      hostname: url.hostname,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new ToolError('SSRF_BLOCKED', 'Blocked resolved IP address', {
        hostname: url.hostname,
        address: a.address,
      });
    }
  }

  return url;
}

async function readBodyText(response, maxBytes) {
  if (!response.body) {
    return { body: '', truncated: false, bytesRead: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytesRead = 0;
  let truncated = false;
  let text = '';
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytesRead += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    text += decoder.decode(undefined, { stream: false });
    return { body: text, truncated, bytesRead };
  } finally {
    reader.releaseLock();
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headersToRecord(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of headers.entries()) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

export async function fetchWithGuards(
  input,
  { signal, fetchImpl = globalThis.fetch, lookup = dnsLookup } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new ToolError('INTERNAL_ERROR', 'fetch is not available in this runtime');
  }

  const redirects = [];
  let current = input.url;
  for (let i = 0; i <= input.maxRedirects; i += 1) {
    const allowedUrl = await assertUrlAllowed(current, { lookup });

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error('timeout'));
    }, input.timeoutMs);

    const onAbort = () => {
      abortController.abort(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw new ToolError('ABORTED', 'Request aborted');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let response;
    try {
      response = await fetchImpl(allowedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: abortController.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
        },
      });
    } catch (error) {
      throw new ToolError('FETCH_FAILED', 'Fetch failed', {
        message: error instanceof Error ? error.message : String(error),
        url: allowedUrl.toString(),
      });
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ToolError('FETCH_FAILED', 'Redirect response missing Location header', {
          status: response.status,
        });
      }
      const next = new URL(location, allowedUrl).toString();
      redirects.push({ status: response.status, location: next });
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      current = next;
      continue;
    }

    const { body, truncated, bytesRead } = await readBodyText(response, input.maxBytes);
    return {
      url: allowedUrl.toString(),
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: headersToRecord(response.headers),
      body,
      truncated,
      bytesRead,
      redirects,
    };
  }

  throw new ToolError('TOO_MANY_REDIRECTS', 'Too many redirects', {
    maxRedirects: input.maxRedirects,
    redirects,
  });
}

