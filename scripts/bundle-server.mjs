// Bundle the whole server into a single CJS file for the desktop app, then place
// the vendored GDScript engines next to it.
//
// esbuild does not provide `import.meta.url` in CJS output, and the vendored
// code derives __dirname from it. We inject a banner constant equal to the
// bundle's own file URL and redirect `import.meta.url` to it, so __dirname
// resolves to the resources/ directory where server.cjs lives at runtime.

import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'desktop', 'src-tauri', 'resources', 'server.cjs');

await esbuild.build({
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile,
  banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': 'import_meta_url' },
  logLevel: 'info',
});

const scriptsSrc = join(root, 'src', 'advanced', 'scripts');
const scriptsDest = join(root, 'desktop', 'src-tauri', 'resources', 'scripts');
await mkdir(scriptsDest, { recursive: true });
await cp(scriptsSrc, scriptsDest, { recursive: true });
console.log(`bundled -> ${outfile}\ncopied GDScript engines -> ${scriptsDest}`);
