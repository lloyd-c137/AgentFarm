// Build public/, which wrangler serves as static assets.
// The source index.html stays one self-contained file (it still works opened straight from disk).
// The served copy is made lighter:
//   - the 800 KB base64 font is swapped for fonts/fusion-pixel-12-core.woff2 (~125 KB: ASCII, punctuation,
//     the 3,755 common hanzi and every character our pages use) plus an "Ext" fallback family that the browser
//     fetches only if some text needs a rarer character (tools/split_font.py makes both files);
//   - the inline script is minified with esbuild;
//   - css/js/fonts get content-hashed names and a one-year immutable cache; pages revalidate every time.
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const hash = buf => createHash('sha256').update(buf).digest('hex').slice(0, 10);
mkdirSync('public', { recursive: true });
// empty public/ in place (removing the folder itself would confuse a running `wrangler dev`)
for (const f of readdirSync('public')) rmSync(`public/${f}`, { recursive: true, force: true });
mkdirSync('public/fonts', { recursive: true });

const assets = {};
function emit(name, buf) {
  const dot = name.lastIndexOf('.'), out = `${name.slice(0, dot)}.${hash(buf)}${name.slice(dot)}`;
  writeFileSync(`public/${out}`, buf); assets[name] = out; return out;
}
emit('fonts/fusion-pixel-12-core.woff2', readFileSync('fonts/fusion-pixel-12-core.woff2'));
emit('fonts/fusion-pixel-12-ext.woff2', readFileSync('fonts/fusion-pixel-12-ext.woff2'));
const fontFaces = `@font-face { font-family: "Fusion Pixel 12"; src: url(${assets['fonts/fusion-pixel-12-core.woff2']}) format("woff2"); font-display: block; }
@font-face { font-family: "Fusion Pixel 12 Ext"; src: url(${assets['fonts/fusion-pixel-12-ext.woff2']}) format("woff2"); font-display: swap; }`;
// favicons (tools/make_favicon.py draws them): fixed names at the root, where browsers look for /favicon.ico
for (const f of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-512.png']) writeFileSync(`public/${f}`, readFileSync(`icons/${f}`));
const icons = `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#241c3e">`;
const preload = `<link rel="preload" href="${assets['fonts/fusion-pixel-12-core.woff2']}" as="font" type="font/woff2" crossorigin>`;

const css = readFileSync('px.css', 'utf8')
  .replace(/@font-face[^}]*}/, '')
  .replace('--px: "Fusion Pixel 12",', '--px: "Fusion Pixel 12", "Fusion Pixel 12 Ext",')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '\n').trim();
emit('px.css', Buffer.from(fontFaces + '\n' + css));
emit('farm-bg.js', Buffer.from((await transform(readFileSync('farm-bg.js', 'utf8'), { minify: true, target: 'es2020' })).code));

// the game page
let game = readFileSync('../index.html', 'utf8');
const before = game.length;
game = game.replace(/@font-face \{ font-family: "Fusion Pixel 12"; src: url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\);[^}]*\}/, fontFaces);
if (game.length === before) throw new Error('font-face not found in index.html');
game = game.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${preload}\n${icons}`);
const FONT = `'"Fusion Pixel 12", monospace'`;
if (!game.includes(FONT)) throw new Error('canvas font string not found');
game = game.split(FONT).join(`'"Fusion Pixel 12", "Fusion Pixel 12 Ext", monospace'`);
// the startup font preload should only wait for the core file; the Ext family loads on demand
const loads = game.match(/document\.fonts\.load\(`\d+px \$\{FONT_CJK\}`/g) || [];
if (!loads.length) throw new Error('font preload call not found');
game = game.replace(/document\.fonts\.load\(`(\d+)px \$\{FONT_CJK\}`/g, 'document.fonts.load(`$1px "Fusion Pixel 12"`');
const open = game.lastIndexOf('<script>'), close = game.lastIndexOf('</script>');
const js = (await transform(game.slice(open + 8, close), { minify: true, target: 'es2020', legalComments: 'none' })).code;
game = game.slice(0, open + 8) + js + game.slice(close);
writeFileSync('public/index.html', game);

for (const page of ['login.html', 'setup.html']) {
  const html = readFileSync(page, 'utf8')
    .replace(/<link rel="preload" href="fusion-pixel-12\.woff2"[^>]*>/, `${preload}\n${icons}`)
    .replace('href="px.css"', `href="${assets['px.css']}"`)
    .replace('src="farm-bg.js"', `src="${assets['farm-bg.js']}"`);
  writeFileSync(`public/${page}`, html);
}

writeFileSync('public/_headers', `/favicon.*
  Cache-Control: public, max-age=86400
/apple-touch-icon.png
  Cache-Control: public, max-age=86400
/icon-512.png
  Cache-Control: public, max-age=86400
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/px.*
  Cache-Control: public, max-age=31536000, immutable
/farm-bg.*
  Cache-Control: public, max-age=31536000, immutable
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/login
  Cache-Control: no-cache
/login.html
  Cache-Control: no-cache
/setup
  Cache-Control: no-cache
/setup.html
  Cache-Control: no-cache
`);
console.log(`public/ ready · index.html ${(before / 1024).toFixed(0)} KB → ${(game.length / 1024).toFixed(0)} KB`);
