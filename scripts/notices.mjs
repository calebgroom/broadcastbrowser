// pnpm run notices: writes THIRD_PARTY_NOTICES.md (and .html, for the app), the licenses of everything that ships inside the
// app: Electron and Chromium, the NDI library, the DeckLink SDK, Syphon, and every npm package the
// app depends on (its dependencies, and theirs), with each one's license text as the package has
// it. Made from what's installed (node_modules), so it's run again before each build (scripts/
// dist.mjs) and the file goes inside the app (electron-builder.yml: extraResources), where Help →
// Acknowledgements opens it.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'THIRD_PARTY_NOTICES.md');

/** A package's folder, as `fromDir` would find it (through pnpm's links). */
function packageDir(fromDir, name) {
  try {
    return dirname(createRequire(join(fromDir, 'x.js')).resolve(`${name}/package.json`));
  } catch {
    // (A package whose exports leave out package.json: found by walking up node_modules.)
    for (let d = fromDir; d !== dirname(d); d = dirname(d)) {
      const c = join(d, 'node_modules', name);
      if (existsSync(join(c, 'package.json'))) return realpathSync(c);
    }
    return null;
  }
}

/** Every package that ships (dependencies and optionalDependencies, all the way down), by name@version. */
function collect() {
  const seen = new Map();
  const walk = (dir) => {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return;
    const files = readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      .sort();
    const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
    const license = p.license ?? (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(' OR ') : 'unknown');
    const author = typeof p.author === 'string' ? p.author : p.author?.name;
    // (As a web address: git+ssh://git@github.com/x/y.git, git://…, github:x/y and x/y all become https://github.com/x/y.)
    const repo = String(p.repository?.url ?? p.repository ?? '')
      .replace(/^git\+/, '')
      .replace(/^(ssh:\/\/git@|git:\/\/|git@)([^/:]+)[/:]/, 'https://$2/')
      .replace(/^github:/, 'https://github.com/')
      .replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
      .replace(/\.git$/, '')
      .replace(/^http:/, 'https:');
    seen.set(key, { name: p.name, version: p.version, license, author, repo, text });
    for (const d of Object.keys({ ...(p.dependencies ?? {}), ...(p.optionalDependencies ?? {}) })) {
      const c = packageDir(realpathSync(dir), d);
      if (c) walk(c);
    }
  };
  const top = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const d of Object.keys({ ...(top.dependencies ?? {}), ...(top.optionalDependencies ?? {}) })) {
    const c = packageDir(root, d);
    if (c) walk(c);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const fence = (text) => '```text\n' + text.replace(/```/g, "'''") + '\n```';
const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8').trim() : null);

/** The DeckLink SDK's notice: the licence statement at the top of its headers. */
function deckLinkNotice() {
  const h = read('decklink/sdk/Mac/DeckLinkAPI.h') ?? '';
  const m = h.match(/-LICENSE-START-([\s\S]*?)-LICENSE-END-/);
  return m ? m[1].replace(/^\s*\*\*\s?/gm, '').trim() : 'See the licence at the top of each file in decklink/sdk/.';
}

const electronVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(packageDir(root, 'electron'), 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
})();
const packages = collect();
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const md = [];
md.push(`# Third-party notices

${product.productName} ${product.version} is © ${new Date().getFullYear()} Caleb Groom, under the MIT License (LICENSE). It's built on, and ships with, the software below, each under its own license. (This file is made by \`pnpm run notices\` from what's installed: don't edit it by hand.)

## Trademarks

NDI® is a registered trademark of Vizrt NDI AB (https://ndi.video/). Blackmagic Design, DeckLink, UltraStudio and Desktop Video are trademarks of Blackmagic Design Pty. Ltd. Syphon is a project of Tom Butterworth and Anton Marini. Mac and macOS are trademarks of Apple Inc. Stream Deck is a trademark of Corsair Memory, Inc.; Bitfocus Companion is a project of Bitfocus AS. Ghostery is a trademark of Ghostery GmbH. Other names are the trademarks of their owners. Broadcast Browser isn't affiliated with or endorsed by any of them.

## Electron and Chromium

The app is built with Electron${electronVersion ? ` ${electronVersion}` : ''} (MIT License, © GitHub Inc. and Electron contributors: https://github.com/electron/electron), which includes Chromium and its many components under their own licenses. Their full notices ship inside the app with Electron itself (\`LICENSE\` and \`LICENSES.chromium.html\`), and are at https://github.com/electron/electron/blob/main/LICENSE and https://source.chromium.org/chromium/chromium/src/+/main:LICENSE.

## NDI

The app includes Vizrt NDI AB's NDI library (\`libndi.dylib\`, from the NDI SDK), distributed under the NDI SDK License Agreement (http://ndi.link/ndisdk_license). NDI® is a registered trademark of Vizrt NDI AB. For more about NDI: https://ndi.video/. The library is reached through @stagetimerio/grandiose (Apache-2.0, below).

## Blackmagic Design DeckLink SDK

The DeckLink addon (\`decklink/\`) is built with Blackmagic Design's DeckLink SDK headers and dispatch code (\`decklink/sdk/\`), under this licence (as at the top of each file):

${fence(deckLinkNotice())}

The DeckLink SDK End User License Agreement: https://www.blackmagicdesign.com/EULA/DeckLinkSDK. Desktop Video, which drives the devices, is Blackmagic's, installed separately.

## Syphon

The Syphon addon (\`syphon/\`) includes the Syphon framework's server code (\`syphon/vendor/\`: https://github.com/Syphon/Syphon-Framework), under this licence:

${fence(read('syphon/vendor/License.txt') ?? 'BSD licence: see syphon/vendor/License.txt.')}

## npm packages

${packages.length} packages, the app's dependencies and theirs:

| Package | Version | License |
| --- | --- | --- |
${packages.map((p) => `| ${p.repo ? `[${p.name}](${p.repo})` : p.name} | ${p.version} | ${p.license} |`).join('\n')}
`);
for (const p of packages) {
  md.push(`### ${p.name} ${p.version}

License: ${p.license}${p.author ? ` · Author: ${p.author}` : ''}${p.repo ? ` · ${p.repo}` : ''}

${p.text ? fence(p.text) : `(The package has no license file: it's under the ${p.license} license, as its package.json says.)`}
`);
}

writeFileSync(out, md.join('\n'));
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.html'), toHtml(md.join('\n'), `${product.productName}: Acknowledgements`));
console.log(`[notices] THIRD_PARTY_NOTICES.md and .html: ${packages.length} npm packages, and Electron, NDI, DeckLink, Syphon`);

// The same, as a page for the app's Help → Acknowledgements window (most Macs have nothing that opens
// Markdown). Only the Markdown written above: headings, paragraphs, tables, ```text blocks, links, `code`.
function toHtml(markdown, title) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)<]+[^\s)<.,:;])/g, '$1<a href="$2">$2</a>');
  const html = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body = [];
      while (++i < lines.length && !lines[i].startsWith('```')) body.push(lines[i]);
      html.push(`<pre>${esc(body.join('\n'))}</pre>`);
    } else if (/^#{1,3} /.test(line)) {
      const n = line.indexOf(' ');
      const text = line.slice(n + 1);
      const id = text.toLowerCase().replace(/[^a-z0-9@./-]+/g, '-');
      html.push(`<h${n} id="${esc(id)}">${inline(text)}</h${n}>`);
    } else if (line.startsWith('| ')) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.slice(1, -1).split(' | ').map((c) => c.trim());
      html.push(
        `<table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
    } else if (line.trim()) {
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|\| )/.test(lines[i + 1])) para.push(lines[++i]);
      html.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; margin: 0 auto; padding: 24px 32px 48px; max-width: 860px; }
  h1 { font-size: 22px; margin-top: 0; } h2 { font-size: 17px; margin-top: 32px; } h3 { font-size: 14px; margin: 28px 0 4px; }
  pre { font: 11px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; background: color-mix(in srgb, CanvasText 6%, Canvas); padding: 10px 12px; border-radius: 6px; }
  code { font: 12px ui-monospace, Menlo, monospace; }
  table { border-collapse: collapse; } th, td { text-align: left; padding: 2px 16px 2px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); }
  a { color: LinkText; }
</style>
</head>
<body>
${html.join('\n')}
</body>
</html>
`;
}
