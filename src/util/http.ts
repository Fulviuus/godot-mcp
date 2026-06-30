/**
 * Small HTTP download helpers built on the global `fetch` (Node 18+). Used by
 * the toolchain service to pull Godot binaries / export templates and by the
 * refdoc service to fetch the class reference.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.js';
import { log } from './log.js';

export interface DownloadOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Optional progress callback invoked with (received, total|undefined). */
  onProgress?: (received: number, total: number | undefined) => void;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'godot-mcp-server', ...(headers ?? {}) },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a URL and return its body as text. Throws ToolError on non-2xx. */
export async function fetchText(url: string, options: DownloadOptions = {}): Promise<string> {
  const { timeoutMs = 30_000, headers } = options;
  const res = await fetchWithTimeout(url, timeoutMs, headers);
  if (!res.ok) {
    throw new ToolError(`HTTP ${res.status} fetching ${url}`, { code: `http_${res.status}` });
  }
  return res.text();
}

/** Fetch a URL and parse it as JSON. */
export async function fetchJson<T = unknown>(url: string, options: DownloadOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...options, headers: { accept: 'application/json', ...(options.headers ?? {}) } });
  return JSON.parse(text) as T;
}

/**
 * Download a URL to `destPath`, streaming to disk. Writes to a temporary file
 * first and renames on success so partial downloads never masquerade as
 * complete. Returns the number of bytes written.
 */
export async function downloadToFile(url: string, destPath: string, options: DownloadOptions = {}): Promise<number> {
  const { timeoutMs = 600_000, onProgress } = options;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.partial`;

  log.info(`Downloading ${url}`);
  const res = await fetchWithTimeout(url, timeoutMs, options.headers);
  if (!res.ok || !res.body) {
    throw new ToolError(`HTTP ${res.status} downloading ${url}`, { code: `http_${res.status}` });
  }

  const total = Number(res.headers.get('content-length')) || undefined;
  let received = 0;
  const handle = await fs.open(tmp, 'w');
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  } finally {
    await handle.close();
  }

  await fs.rename(tmp, destPath);
  log.info(`Saved ${destPath} (${received} bytes)`);
  return received;
}
