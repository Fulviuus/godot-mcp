// Copy non-TypeScript runtime assets into dist/ after `tsc`.
// The vendored GDScript engines (godot_operations.gd, mcp_interaction_server.gd)
// are resolved at runtime relative to the compiled module via __dirname, so they
// must sit next to it at dist/advanced/scripts/.

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'advanced', 'scripts');
const dest = join(root, 'dist', 'advanced', 'scripts');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`copied GDScript engines -> ${dest}`);
