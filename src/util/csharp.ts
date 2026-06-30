/**
 * Best-effort static outline of a C# (`.cs`) file for Godot .NET projects.
 * Like the GDScript scanner this is line-oriented rather than a full parser; it
 * recognises namespaces, classes (with base type), methods, properties, fields,
 * `[Export]` members and `[Signal]` delegates.
 */

import type { ScriptOutline, ScriptParam, ScriptFunction, ScriptVariable } from './gdscript.js';

function parseParams(raw: string): ScriptParam[] {
  const inner = raw.trim();
  if (inner === '') return [];
  return inner.split(',').map((piece) => {
    const part = piece.trim().replace(/\b(ref|out|in|params)\s+/g, '');
    let def: string | undefined;
    const eq = part.indexOf('=');
    let decl = part;
    if (eq !== -1) {
      def = part.slice(eq + 1).trim();
      decl = part.slice(0, eq).trim();
    }
    const tokens = decl.split(/\s+/);
    const name = tokens.pop() ?? decl;
    const type = tokens.join(' ') || undefined;
    return { name, type, default: def };
  });
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'virtual',
  'override',
  'abstract',
  'sealed',
  'async',
  'partial',
  'readonly',
  'const',
  'new',
  'extern',
  'unsafe',
  'volatile',
]);

export function parseCSharp(text: string): ScriptOutline {
  const outline: ScriptOutline = {
    language: 'csharp',
    isTool: false,
    signals: [],
    constants: [],
    enums: [],
    variables: [],
    functions: [],
    innerClasses: [],
  };

  const lines = text.split(/\r?\n/);
  const pendingAttrs: string[] = [];
  let primaryClassSet = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]).trim();
    if (raw === '') continue;

    // [Tool], [Export], [Signal], [GlobalClass] attributes (possibly multiple on a line).
    const attrLine = /^\[(.+)\]$/.exec(raw);
    if (attrLine) {
      for (const a of attrLine[1].split('][')) {
        const name = a.split('(')[0].trim();
        pendingAttrs.push(name);
      }
      if (pendingAttrs.includes('Tool')) outline.isTool = true;
      continue;
    }

    const attrs = pendingAttrs.splice(0, pendingAttrs.length);

    let m: RegExpExecArray | null;

    // namespace declaration.
    if (/^namespace\s+[A-Za-z_][\w.]*/.test(raw)) {
      continue;
    }

    // class / partial class declaration with optional base list.
    if ((m = /^(?:[\w\s]*?\b)?class\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.<>, ]*))?/.exec(raw))) {
      const base = m[2]?.split(',')[0].trim();
      if (!primaryClassSet) {
        outline.className = m[1];
        outline.extends = base;
        primaryClassSet = true;
      } else {
        outline.innerClasses.push({ name: m[1], extends: base, line: lineNo });
      }
      continue;
    }

    if ((m = /\benum\s+([A-Za-z_]\w*)/.exec(raw))) {
      outline.enums.push({ name: m[1], line: lineNo });
      continue;
    }

    // [Signal] delegate EventHandler.
    if (attrs.includes('Signal') && /\bdelegate\b/.test(raw)) {
      const sig =
        /delegate\s+\w[\w<>]*\s+([A-Za-z_]\w*?)EventHandler\s*\(([^)]*)\)/.exec(raw) ||
        /delegate\s+\w[\w<>]*\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(raw);
      if (sig) {
        outline.signals.push({ name: sig[1], params: parseParams(sig[2] ?? ''), line: lineNo });
        continue;
      }
    }

    // Strip leading modifier keywords so they don't pollute the type capture.
    const { mods, body } = stripLeadingModifiers(raw);
    const isStatic = mods.includes('static');
    const isConst = mods.includes('const');
    const annotations = attrs.map((a) => `[${a}]`);

    // Method: ReturnType Name(params)
    if ((m = /^([A-Za-z_][\w<>\[\],. ]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:=>|\{|;)?\s*$/.exec(body))) {
      const name = m[2];
      if (!['if', 'for', 'foreach', 'while', 'switch', 'using', 'return', 'get', 'set'].includes(name)) {
        const fn: ScriptFunction = {
          name,
          params: parseParams(m[3] ?? ''),
          returnType: m[1].trim() === 'void' ? undefined : m[1].trim(),
          line: lineNo,
          isStatic,
          annotations,
        };
        outline.functions.push(fn);
        continue;
      }
    }

    // Property: Type Name { get; set; }
    if ((m = /^([A-Za-z_][\w<>\[\],. ]*?)\s+([A-Za-z_]\w*)\s*\{\s*get/.exec(body))) {
      pushField(outline, m[2], m[1].trim(), lineNo, attrs);
      continue;
    }

    // Field / constant: Type Name (= value)?;
    if ((m = /^([A-Za-z_][\w<>\[\],. ]*?)\s+([A-Za-z_]\w*)\s*(?:=\s*([^;]+))?;\s*$/.exec(body))) {
      if (isConst) {
        outline.constants.push({ name: m[2], value: m[3]?.trim(), line: lineNo });
      } else {
        pushField(outline, m[2], m[1].trim(), lineNo, attrs, m[3]?.trim());
      }
      continue;
    }
  }

  return outline;
}

/** Split off a leading run of modifier keywords from a declaration line. */
function stripLeadingModifiers(line: string): { mods: string[]; body: string } {
  const tokens = line.split(/\s+/);
  const mods: string[] = [];
  let i = 0;
  while (i < tokens.length && MODIFIERS.has(tokens[i])) {
    mods.push(tokens[i]);
    i++;
  }
  return { mods, body: tokens.slice(i).join(' ') };
}

function pushField(
  outline: ScriptOutline,
  name: string,
  type: string,
  line: number,
  attrs: string[],
  def?: string,
): void {
  const variable: ScriptVariable = {
    name,
    type,
    default: def,
    line,
    exported: attrs.includes('Export'),
    annotations: attrs.map((a) => `[${a}]`),
  };
  outline.variables.push(variable);
}

function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}
