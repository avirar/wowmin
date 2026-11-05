#!/usr/bin/env node
// Which of the deployed instance maps carry WMO minimap quads (the client's
// indoor minimap art), and under what texture base name. The quad textures
// are keyed in md5translate.trs by their FULL logical path
// (WMO\<dir>\<base>_<g>_<x>_<y>.blp), and <base> is NOT always the .wmo file's
// basename (e.g. wailingcaverns_instance.wmo -> quads named wailingcaverns_*).
// This maps each deployed map's WDT WMO to the quad bases actually present in
// that WMO's trs directory, so the base-name rule can be chosen from data.
// Read-only: writes nothing.
//
//   node scripts/discover-quad-minimaps.mjs --source /path/to/client
//   node scripts/discover-quad-minimaps.mjs --source ... --assets-dir assets/instances

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { readWdt } from './scene/placement.mjs';
import { parseMd5TranslateTable } from './render-quad-minimap.mjs';

const QUAD_NAME = /^([a-z0-9]+)_(\d{3})_(\d{2})_(\d{2})\.blp$/i;

function parseArgs(argv) {
  const options = { source: null, assetsDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--assets-dir' || arg === '-a') options.assetsDir = argv[++index];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory in ${options.source}`);
  const readFile = openClientData(dataDir);
  const assetsDir = options.assetsDir
    ? path.resolve(options.assetsDir)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'instances');

  // The deployed set: every numeric file base under the assets dir.
  const mapIds = new Set();
  for (const entry of fs.readdirSync(assetsDir)) {
    const match = entry.match(/^(\d+)\.(?:json|jpg|png|glb)$/i) ?? entry.match(/^(\d+)\.scene\.json$/i);
    if (match) mapIds.add(Number.parseInt(match[1], 10));
  }
  const ids = [...mapIds].sort((a, b) => a - b);

  const catalog = await buildMapCatalog(readFile, { mapIds: ids });
  const byMap = new Map(catalog.map((entry) => [entry.mapId, entry]));

  const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
  if (!trsBuffer) throw new Error('Missing textures\\Minimap\\md5translate.trs');
  // table: dirKey(normalised) -> Map<quadBase(lowercase) -> count>
  const raw = parseMd5TranslateTable(trsBuffer);
  const quadsByDir = new Map();
  for (const [dir, entries] of raw) {
    const bases = new Map();
    for (const name of entries.keys()) {
      const m = name.match(QUAD_NAME);
      if (!m) continue;
      const base = m[1].toLowerCase();
      bases.set(base, (bases.get(base) ?? 0) + 1);
    }
    if (bases.size) quadsByDir.set(dir, bases);
  }

  const rows = [];
  for (const mapId of ids) {
    const entry = byMap.get(mapId);
    const hasJpg = fs.existsSync(path.join(assetsDir, `${mapId}.jpg`));
    const hasPng = fs.existsSync(path.join(assetsDir, `${mapId}.png`));
    let wmoBase = '';
    let wmoDir = '';
    let bases = [];
    let wmoOnly = false;
    if (entry) {
      const wdtBuffer = readFile(`World\\maps\\${entry.internalName}\\${entry.internalName}.wdt`);
      const wdt = wdtBuffer ? readWdt(wdtBuffer) : null;
      if (wdt?.wmo && wdt.wmoOnly) {
        wmoOnly = true;
        const wmoName = wdt.wmo.name.replace(/^world\\/i, '');
        wmoBase = path.win32.basename(wmoName).replace(/\.wmo$/i, '').toLowerCase();
        wmoDir = path.win32.dirname(wmoName).replace(/\\/g, '/').toLowerCase();
        bases = [...(quadsByDir.get(wmoDir)?.keys() ?? [])];
      }
    }
    rows.push({ mapId, hasJpg, hasPng, wmoOnly, wmoBase, wmoDir, bases, label: entry?.label ?? '' });
  }

  const withBases = rows.filter((row) => row.bases.length > 0);
  console.log(`deployed set: ${ids.length} ids; ${withBases.length} have quad textures in their WMO dir:\n`);
  for (const row of withBases.sort((a, b) => a.mapId - b.mapId)) {
    const exact = row.bases.includes(row.wmoBase) ? 'EXACT'
      : row.bases.includes(row.wmoBase.replace(/_instance\d*$/, '')) ? 'no-suffix' : 'MISMATCH';
    console.log(`${String(row.mapId).padStart(4)}  ${row.hasJpg ? 'J' : '-'}${row.hasPng ? 'P' : '-'}  `
      + `wmo="${row.wmoBase}"  quads=[${row.bases.join(', ')}]  ${exact}  ${row.label}`);
  }
  console.log(`\nWMO-only, no quads in dir (${rows.filter((row) => row.wmoOnly && !row.bases.length).length}):`);
  for (const row of rows.filter((row) => row.wmoOnly && !row.bases.length).sort((a, b) => a.mapId - b.mapId)) {
    console.log(`  ${String(row.mapId).padStart(4)}  ${row.hasJpg ? 'J' : row.hasPng ? 'P' : '-'}  "${row.wmoBase}"  ${row.label}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
