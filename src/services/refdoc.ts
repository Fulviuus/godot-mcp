/**
 * Godot class-reference access. The reference is generated locally with the
 * editor's `--doctool` (version-accurate, offline) into the cache, parsed from
 * its XML, and indexed for search. Single-class lookups fall back to fetching
 * the class XML straight from the godotengine/godot repo for the target tag.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cacheDir, versionTag, type VersionSpec } from '../constants.js';
import { ToolError } from '../util/errors.js';
import { exists } from '../util/fswalk.js';
import { fetchText } from '../util/http.js';
import { log } from '../util/log.js';
import { runGodot } from './processes.js';

export interface DocMethod {
  name: string;
  returnType: string;
  params: { name: string; type: string }[];
  description: string;
}

export interface DocMember {
  name: string;
  type: string;
  default?: string;
  description: string;
}

export interface ClassDoc {
  name: string;
  inherits?: string;
  brief: string;
  description: string;
  methods: DocMethod[];
  members: DocMember[];
  signals: { name: string; params: { name: string; type: string }[]; description: string }[];
  constants: { name: string; value: string; description: string }[];
}

function docsRoot(spec: VersionSpec): string {
  return path.join(cacheDir(), 'docs', versionTag(spec));
}

function classesDir(spec: VersionSpec): string {
  return path.join(docsRoot(spec), 'doc', 'classes');
}

/**
 * Ensure the class reference XML is generated for `spec`. Returns the directory
 * containing the per-class XML files, or undefined if generation isn't possible
 * (single-class lookups can still use the GitHub fallback).
 */
export async function ensureClassDocs(spec: VersionSpec, binary?: string): Promise<string | undefined> {
  const dir = classesDir(spec);
  if (await exists(dir)) {
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.some((e) => e.endsWith('.xml'))) return dir;
  }
  if (!binary) return undefined;

  const target = docsRoot(spec);
  await fs.mkdir(target, { recursive: true });
  log.info(`generating class reference via --doctool into ${target}`);
  const res = await runGodot(binary, ['--headless', '--doctool', target, '--quit'], { timeoutMs: 120_000 });
  if (await exists(dir)) {
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.some((e) => e.endsWith('.xml'))) return dir;
  }
  log.warn(`--doctool did not produce class docs (code=${res.code})`);
  return undefined;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Strips BBCode-ish markup Godot uses in descriptions, keeping it readable. */
function cleanText(s: string): string {
  return unescapeXml(s)
    .replace(/\[\/?[a-zA-Z][^\]]*\]/g, (tag) => {
      const inner = tag.replace(/[[\]/]/g, '').split(' ')[0];
      // Keep code/member references as bare names; drop formatting tags.
      return /^(b|i|code|codeblock|url|kbd|param|member|method|constant|enum|signal|theme_item)$/i.test(inner)
        ? ''
        : tag;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : undefined;
}

export function parseClassXml(xml: string): ClassDoc {
  const classTag = /<class\b[^>]*>/.exec(xml)?.[0] ?? '';
  const name = attr(classTag, 'name') ?? 'Unknown';
  const inherits = attr(classTag, 'inherits');

  const brief = cleanText(/<brief_description>([\s\S]*?)<\/brief_description>/.exec(xml)?.[1] ?? '');
  const description = cleanText(/<description>([\s\S]*?)<\/description>/.exec(xml)?.[1] ?? '');

  const methods: DocMethod[] = [];
  const methodsBlock = /<methods>([\s\S]*?)<\/methods>/.exec(xml)?.[1] ?? '';
  for (const m of methodsBlock.matchAll(/<method\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/method>/g)) {
    const body = m[2];
    const returnType = attr(/<return\b[^>]*>/.exec(body)?.[0] ?? '', 'type') ?? 'void';
    const params: { name: string; type: string }[] = [];
    for (const p of body.matchAll(/<param\b[^>]*>/g)) {
      params.push({ name: attr(p[0], 'name') ?? '', type: attr(p[0], 'type') ?? '' });
    }
    methods.push({
      name: unescapeXml(m[1]),
      returnType,
      params,
      description: cleanText(/<description>([\s\S]*?)<\/description>/.exec(body)?.[1] ?? ''),
    });
  }

  const members: DocMember[] = [];
  const membersBlock = /<members>([\s\S]*?)<\/members>/.exec(xml)?.[1] ?? '';
  for (const m of membersBlock.matchAll(/<member\b([^>]*)>([\s\S]*?)<\/member>/g)) {
    members.push({
      name: attr('<x ' + m[1] + '>', 'name') ?? '',
      type: attr('<x ' + m[1] + '>', 'type') ?? '',
      default: attr('<x ' + m[1] + '>', 'default'),
      description: cleanText(m[2]),
    });
  }

  const signals: ClassDoc['signals'] = [];
  const signalsBlock = /<signals>([\s\S]*?)<\/signals>/.exec(xml)?.[1] ?? '';
  for (const m of signalsBlock.matchAll(/<signal\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/signal>/g)) {
    const params: { name: string; type: string }[] = [];
    for (const p of m[2].matchAll(/<param\b[^>]*>/g)) {
      params.push({ name: attr(p[0], 'name') ?? '', type: attr(p[0], 'type') ?? '' });
    }
    signals.push({
      name: unescapeXml(m[1]),
      params,
      description: cleanText(/<description>([\s\S]*?)<\/description>/.exec(m[2])?.[1] ?? ''),
    });
  }

  const constants: ClassDoc['constants'] = [];
  for (const m of xml.matchAll(/<constant\b([^>]*)>([\s\S]*?)<\/constant>/g)) {
    constants.push({
      name: attr('<x ' + m[1] + '>', 'name') ?? '',
      value: attr('<x ' + m[1] + '>', 'value') ?? '',
      description: cleanText(m[2]),
    });
  }

  return { name, inherits, brief, description, methods, members, signals, constants };
}

/** Load a single class doc, preferring local docs and falling back to GitHub. */
export async function getClassDoc(
  spec: VersionSpec,
  className: string,
  binary?: string,
): Promise<ClassDoc> {
  const dir = await ensureClassDocs(spec, binary);
  if (dir) {
    const file = path.join(dir, `${className}.xml`);
    if (await exists(file)) {
      return parseClassXml(await fs.readFile(file, 'utf8'));
    }
  }
  // GitHub fallback for the exact class name.
  const url = `https://raw.githubusercontent.com/godotengine/godot/${versionTag(spec)}/doc/classes/${className}.xml`;
  try {
    return parseClassXml(await fetchText(url, { timeoutMs: 20_000 }));
  } catch {
    throw new ToolError(`No documentation found for class "${className}" (Godot ${versionTag(spec)}).`, {
      code: 'no_doc',
      hint: 'Check the class name (case-sensitive), or run godot_setup so the local reference can be generated.',
    });
  }
}

export interface SearchHit {
  name: string;
  brief: string;
  kind: 'class' | 'method' | 'member' | 'signal' | 'constant';
  member?: string;
  inherits?: string;
}

interface IndexEntry {
  name: string;
  brief: string;
  inherits?: string;
  methods: string[];
  members: string[];
  signals: string[];
  constants: string[];
}

const indexCache = new Map<string, IndexEntry[]>();

async function buildIndex(spec: VersionSpec, dir: string): Promise<IndexEntry[]> {
  const key = versionTag(spec);
  const cached = indexCache.get(key);
  if (cached) return cached;

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.xml'));
  const entries: IndexEntry[] = [];
  for (const file of files) {
    try {
      const xml = await fs.readFile(path.join(dir, file), 'utf8');
      const classTag = /<class\b[^>]*>/.exec(xml)?.[0] ?? '';
      entries.push({
        name: attr(classTag, 'name') ?? path.basename(file, '.xml'),
        inherits: attr(classTag, 'inherits'),
        brief: cleanText(/<brief_description>([\s\S]*?)<\/brief_description>/.exec(xml)?.[1] ?? ''),
        methods: [...xml.matchAll(/<method\b[^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1])),
        members: [...xml.matchAll(/<member\b[^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1])),
        signals: [...xml.matchAll(/<signal\b[^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1])),
        constants: [...xml.matchAll(/<constant\b[^>]*name="([^"]+)"/g)].map((m) => unescapeXml(m[1])),
      });
    } catch {
      /* skip unreadable file */
    }
  }
  indexCache.set(key, entries);
  return entries;
}

/** Full-text-ish search across class names, briefs, and member names. */
export async function searchClasses(
  spec: VersionSpec,
  query: string,
  binary?: string,
  limit = 25,
): Promise<SearchHit[]> {
  const dir = await ensureClassDocs(spec, binary);
  if (!dir) {
    throw new ToolError('Class reference is not available for search.', {
      code: 'no_doc',
      hint: 'Run godot_setup first so the reference can be generated with --doctool.',
    });
  }
  const index = await buildIndex(spec, dir);
  const q = query.toLowerCase();
  const hits: { hit: SearchHit; score: number }[] = [];

  for (const entry of index) {
    const nameLower = entry.name.toLowerCase();
    if (nameLower === q) hits.push({ hit: classHit(entry), score: 100 });
    else if (nameLower.includes(q)) hits.push({ hit: classHit(entry), score: 70 });
    else if (entry.brief.toLowerCase().includes(q)) hits.push({ hit: classHit(entry), score: 40 });

    for (const method of entry.methods) {
      if (method.toLowerCase().includes(q)) {
        hits.push({ hit: { name: entry.name, brief: entry.brief, kind: 'method', member: method }, score: 50 });
      }
    }
    for (const member of entry.members) {
      if (member.toLowerCase().includes(q)) {
        hits.push({ hit: { name: entry.name, brief: entry.brief, kind: 'member', member }, score: 45 });
      }
    }
    for (const signal of entry.signals) {
      if (signal.toLowerCase().includes(q)) {
        hits.push({ hit: { name: entry.name, brief: entry.brief, kind: 'signal', member: signal }, score: 35 });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name));
  return hits.slice(0, limit).map((h) => h.hit);
}

function classHit(entry: IndexEntry): SearchHit {
  return { name: entry.name, brief: entry.brief, kind: 'class', inherits: entry.inherits };
}
