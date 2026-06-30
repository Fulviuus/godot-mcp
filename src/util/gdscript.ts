/**
 * Best-effort static outline of a GDScript (`.gd`) file. This is not a full
 * parser — it is a line-oriented scanner that recognises the top-level
 * declarations an agent usually wants: extends/class_name, signals, enums,
 * constants, exported and plain variables, and functions (with params, return
 * type, static-ness and annotations such as @rpc / @onready).
 */

export interface ScriptParam {
  name: string;
  type?: string;
  default?: string;
}

export interface ScriptFunction {
  name: string;
  params: ScriptParam[];
  returnType?: string;
  line: number;
  isStatic: boolean;
  annotations: string[];
}

export interface ScriptVariable {
  name: string;
  type?: string;
  default?: string;
  line: number;
  exported: boolean;
  annotations: string[];
}

export interface ScriptOutline {
  language: 'gdscript' | 'csharp';
  extends?: string;
  className?: string;
  isTool: boolean;
  signals: { name: string; params: ScriptParam[]; line: number }[];
  constants: { name: string; value?: string; line: number }[];
  enums: { name: string; line: number }[];
  variables: ScriptVariable[];
  functions: ScriptFunction[];
  innerClasses: { name: string; extends?: string; line: number }[];
}

function parseParams(raw: string): ScriptParam[] {
  const inner = raw.trim();
  if (inner === '') return [];
  return splitTopLevel(inner).map((piece) => {
    const part = piece.trim();
    let name = part;
    let type: string | undefined;
    let def: string | undefined;

    const eq = topLevelIndexOf(part, '=');
    if (eq !== -1) {
      def = part.slice(eq + 1).trim();
      name = part.slice(0, eq).trim();
    }
    const colon = name.indexOf(':');
    if (colon !== -1) {
      type = name.slice(colon + 1).trim() || undefined;
      name = name.slice(0, colon).trim();
    }
    return { name, type, default: def };
  });
}

/** Split on top-level commas, ignoring commas nested in (), [], {} or strings. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let buf = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      buf += ch;
      if (ch === '\\') buf += input[++i] ?? '';
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
    } else if ('([{'.includes(ch)) {
      depth++;
      buf += ch;
    } else if (')]}'.includes(ch)) {
      depth--;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== '') out.push(buf);
  return out;
}

function topLevelIndexOf(input: string, target: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === target && depth === 0) return i;
  }
  return -1;
}

export function parseGdScript(text: string): ScriptOutline {
  const outline: ScriptOutline = {
    language: 'gdscript',
    isTool: false,
    signals: [],
    constants: [],
    enums: [],
    variables: [],
    functions: [],
    innerClasses: [],
  };

  const lines = text.split(/\r?\n/);
  let pendingAnnotations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]);
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    // Standalone annotation line (e.g. `@export` above a var, `@rpc("any_peer")`).
    const annoOnly = /^@(\w+)(\([^)]*\))?\s*$/.exec(trimmed);
    if (annoOnly) {
      pendingAnnotations.push('@' + annoOnly[1]);
      continue;
    }

    // Inline annotations: collect leading @annotations then continue on same content.
    let content = trimmed;
    const inlineAnnos: string[] = [];
    let annoMatch: RegExpExecArray | null;
    const annoRe = /^@(\w+)(\([^)]*\))?\s+/;
    while ((annoMatch = annoRe.exec(content))) {
      inlineAnnos.push('@' + annoMatch[1]);
      content = content.slice(annoMatch[0].length);
    }
    const annotations = [...pendingAnnotations, ...inlineAnnos];
    pendingAnnotations = [];

    if (content.startsWith('@tool') || trimmed === '@tool') {
      outline.isTool = true;
      continue;
    }

    let m: RegExpExecArray | null;

    if ((m = /^extends\s+(.+)$/.exec(content))) {
      if (!outline.extends) outline.extends = m[1].trim();
      continue;
    }
    if ((m = /^class_name\s+([A-Za-z_]\w*)/.exec(content))) {
      outline.className = m[1];
      continue;
    }
    if ((m = /^signal\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(content))) {
      outline.signals.push({ name: m[1], params: parseParams(m[2] ?? ''), line: lineNo });
      continue;
    }
    if ((m = /^enum\s+([A-Za-z_]\w*)/.exec(content))) {
      outline.enums.push({ name: m[1], line: lineNo });
      continue;
    }
    if ((m = /^const\s+([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_][\w\[\], ]*?)?\s*:?=\s*(.+)$/.exec(content))) {
      outline.constants.push({ name: m[1], value: m[2].trim(), line: lineNo });
      continue;
    }
    if ((m = /^(static\s+)?func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_][\w.\[\], ]*))?\s*:/.exec(content))) {
      outline.functions.push({
        name: m[2],
        params: parseParams(m[3] ?? ''),
        returnType: m[4]?.trim(),
        line: lineNo,
        isStatic: Boolean(m[1]) || annotations.includes('@static'),
        annotations,
      });
      continue;
    }
    if ((m = /^class\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_][\w.]*))?\s*:/.exec(content))) {
      outline.innerClasses.push({ name: m[1], extends: m[2], line: lineNo });
      continue;
    }
    if ((m = /^(?:static\s+)?var\s+([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(content))) {
      const exported = annotations.some((a) => a === '@export' || a.startsWith('@export'));
      outline.variables.push({
        name: m[1],
        type: m[2]?.trim(),
        default: m[3]?.trim(),
        line: lineNo,
        exported,
        annotations,
      });
      continue;
    }
  }

  return outline;
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
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}
