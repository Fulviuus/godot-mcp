/**
 * Parser/serializer for Godot's `ConfigFile` text format, used by
 * `project.godot`, `export_presets.cfg`, `.godot-mcp` and `.import` files.
 *
 * The format is INI-like but the *values* are Godot variant literals:
 *   config/name="My Game"
 *   run/max_fps=60
 *   config/features=PackedStringArray("4.7", "Forward Plus")
 *   [application]
 *
 * Keys frequently contain slashes (they are flat strings, not nested objects).
 * We keep an order-preserving line model so `set_setting` can rewrite a single
 * value without reflowing comments, blank lines or untouched entries.
 */

export interface ConfigEntry {
  key: string;
  /** Raw value text exactly as it appears after the `=`. */
  raw: string;
}

export interface ConfigSection {
  /** Section name without brackets, e.g. "application". "" for the pre-section preamble. */
  name: string;
  /** Raw attribute text for headers like `[node name="x" type="y"]` (scene files). */
  header: string;
  entries: ConfigEntry[];
}

export interface ParsedConfig {
  sections: ConfigSection[];
}

const SECTION_RE = /^\[([^\]\s]+)(\s+.*)?\]\s*$/;
const ENTRY_RE = /^([^=;#\[][^=]*?)\s*=\s*(.*)$/;

export function parseConfig(text: string): ParsedConfig {
  const sections: ConfigSection[] = [];
  let current: ConfigSection = { name: '', header: '', entries: [] };
  sections.push(current);

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const sectionMatch = SECTION_RE.exec(line.trim());
    if (sectionMatch) {
      current = { name: sectionMatch[1], header: (sectionMatch[2] ?? '').trim(), entries: [] };
      sections.push(current);
      continue;
    }
    const entryMatch = ENTRY_RE.exec(line);
    if (entryMatch) {
      let raw = entryMatch[2].trim();
      // Godot writes multi-line dict/array values (e.g. input actions). Keep
      // consuming following lines until brackets/quotes balance, so round-trip
      // serialization preserves the full value.
      while (!isBalanced(raw) && i + 1 < lines.length) {
        raw += '\n' + lines[++i];
      }
      current.entries.push({ key: entryMatch[1].trim(), raw });
    }
    // Comments / blank lines are intentionally dropped from the model; they are
    // re-emitted as structural separators by serialize().
  }

  // Drop a leading empty unnamed section that carried no entries.
  if (sections.length > 1 && sections[0].name === '' && sections[0].entries.length === 0) {
    sections.shift();
  }
  return { sections };
}

/** True when all (), [], {} and double quotes in `s` are balanced/closed. */
function isBalanced(s: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
  }
  return depth <= 0 && !inString;
}

export function serializeConfig(config: ParsedConfig): string {
  const blocks: string[] = [];
  for (const section of config.sections) {
    const lines: string[] = [];
    if (section.name !== '') {
      lines.push(section.header ? `[${section.name} ${section.header}]` : `[${section.name}]`);
    }
    for (const entry of section.entries) {
      lines.push(`${entry.key}=${entry.raw}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function getSection(config: ParsedConfig, name: string): ConfigSection | undefined {
  return config.sections.find((s) => s.name === name);
}

/** Reads a raw value by section + key, returning undefined when absent. */
export function getRaw(config: ParsedConfig, section: string, key: string): string | undefined {
  const sec = getSection(config, section);
  return sec?.entries.find((e) => e.key === key)?.raw;
}

/**
 * Sets a raw value, creating the section and/or entry if needed. The section is
 * appended at the end when new, matching how the Godot editor grows the file.
 */
export function setRaw(config: ParsedConfig, section: string, key: string, raw: string): void {
  let sec = getSection(config, section);
  if (!sec) {
    sec = { name: section, header: '', entries: [] };
    config.sections.push(sec);
  }
  const existing = sec.entries.find((e) => e.key === key);
  if (existing) existing.raw = raw;
  else sec.entries.push({ key, raw });
}

/** Removes a key. Returns true if something was removed. */
export function removeRaw(config: ParsedConfig, section: string, key: string): boolean {
  const sec = getSection(config, section);
  if (!sec) return false;
  const idx = sec.entries.findIndex((e) => e.key === key);
  if (idx === -1) return false;
  sec.entries.splice(idx, 1);
  return true;
}

/**
 * Best-effort decode of a Godot variant literal into a plain JS value. Strings,
 * numbers, booleans and simple `PackedStringArray(...)` / `Array(...)` lists are
 * decoded; anything else (Vector2(...), Resource(...), dictionaries) is returned
 * as the trimmed raw string so callers always get *something* meaningful.
 */
export function decodeValue(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;

  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(v)) return Number(v);

  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return decodeString(v);
  }

  const packed = /^(?:Packed\w*Array|Array)\s*\((.*)\)$/s.exec(v);
  if (packed) {
    return splitArgs(packed[1]).map((arg) => decodeValue(arg));
  }

  return v; // Vector2(...), dictionaries, Resource(...), ExtResource(...), etc.
}

function decodeString(quoted: string): string {
  const inner = quoted.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return ch;
    }
  });
}

/** Splits a comma-separated argument list while respecting quotes and nesting. */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let buf = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      buf += ch;
      if (ch === '\\') {
        buf += input[++i] ?? '';
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      buf += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      if (buf.trim() !== '') args.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== '') args.push(buf.trim());
  return args;
}

/** Encodes a JS value into a Godot variant literal for writing back. */
export function encodeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encodeValue(v)).join(', ')}]`;
  }
  // Objects / unknown: stringify defensively.
  return `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;
}
