#!/usr/bin/env node
/**
 * Build a distributable client bot that does NOT ship readable source.
 *
 * Pipeline:
 *   1. esbuild               — bundle axios/dotenv + index.js into one minified file
 *   2. javascript-obfuscator — flatten control flow, encode strings, mangle names
 *   3. @yao-pkg/pkg (--exe)  — compile to a standalone .exe with Node embedded
 *
 * Outputs:
 *   build/bundle.js                 bundled + minified (intermediate)
 *   build/bot.obf.js                obfuscated single file (runs with `node build/bot.obf.js`)
 *   dist/signal-client-bot.exe      standalone binary (client needs no Node install)
 *
 * The client only ever receives the .exe (or the obfuscated .js) plus their own
 * .env — never index.js. Caveat: obfuscation + packaging raises the bar a lot but
 * is NOT unbreakable (V8 bytecode/strings can be partially recovered). The actual
 * signal strategy already lives server-side; this protects the executor, licensing,
 * and sizing code and deters tampering.
 *
 *   npm run build       → bundle + obfuscate (fast, no download)
 *   npm run build:exe   → also produce the .exe (downloads a Node base on first run)
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(BUILD, 'bundle.js');
const OBF = path.join(BUILD, 'bot.obf.js');
const BUILTINS = require('module').builtinModules.filter((m) => !m.startsWith('_'));

fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

async function bundle() {
  console.log('[build] esbuild: bundling dependencies…');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'index.js')],
    outfile: BUNDLE,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    bundle: true,
    minify: true,
    legalComments: 'none',
  });
}

function obfuscate() {
  console.log('[build] javascript-obfuscator: obfuscating…');
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
    target: 'node',
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.85,
    // Keep Node built-in module names as plain literals. After esbuild bundling the
    // only require() calls left are built-ins; if their arguments get moved into the
    // string array, pkg can't resolve them statically and emits "Dynamic require may
    // fail" warnings on every build. Harmless at runtime, but noisy — and exempting
    // strings like "fs"/"http" costs nothing in protection.
    reservedStrings: [`^(?:node:)?(?:${BUILTINS.join('|')})$`],
    // selfDefending/debugProtection are intentionally OFF: their anti-tamper loops
    // are incompatible with pkg's V8 snapshot and hang the packaged .exe. Control-flow
    // flattening + string-array encoding + name mangling already make the source
    // unreadable; the strategy itself is server-side, so this is enough.
    selfDefending: false,
  });
  fs.writeFileSync(OBF, result.getObfuscatedCode());
}

async function packExe() {
  console.log('[build] pkg: compiling standalone .exe (may download a Node base)…');
  const { exec } = require('@yao-pkg/pkg');
  await exec([
    OBF,
    '--targets', 'node22-win-x64',
    '--output', path.join(DIST, 'signal-client-bot.exe'),
  ]);
}

/** Ship a .env template next to the artifacts so recipients know what to fill in. */
function copyEnvExample() {
  const src = path.join(ROOT, '.env.example');
  fs.copyFileSync(src, path.join(BUILD, '.env.example'));
  fs.copyFileSync(src, path.join(DIST, '.env.example'));
  console.log('[build] .env.example → build/ and dist/');
}

(async () => {
  await bundle();
  obfuscate();
  copyEnvExample();
  console.log('[build] obfuscated bundle →', path.relative(ROOT, OBF));
  if (process.argv.includes('--exe')) {
    await packExe();
    console.log('[build] standalone binary →', path.relative(ROOT, path.join(DIST, 'signal-client-bot.exe')));
  }
  console.log('[build] done.');
})().catch((e) => {
  console.error('[build] failed:', e && e.message ? e.message : e);
  process.exit(1);
});