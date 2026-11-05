#!/usr/bin/env node
// Batch pass of render-quad-minimap.mjs over the deployed instance maps: for
// every map whose WDT is a single WMO whose md5translate.trs carries quads
// named after that WMO (the client's own indoor minimap art), compose the
// <mapId> image + metadata. Maps that already have a <mapId>.png are skipped
// unless --force. Paper (tile) maps are left alone: their .json stays.
//
//   node scripts/render-quad-minimaps.mjs --source /path/to/client [--assets-dir dir] [--force] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { readWdt } from './scene/placement.mjs';
import { parseMd5TranslateTable, renderQuadMinimap } from './render-quad-minimap.mjs';

function parseArgs(argv) {
  const options = { source: null, assetsDir: null, force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--assets-dir' || arg === '-a') options.assetsDir = argv[++index];
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) throw new Error('Missing required --source argument.');
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
  const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
  if (!trsBuffer) throw new Error('Missing textures\\Minimap\\md5translate.trs');
  const table = parseMd5TranslateTable(trsBuffer);

  let rendered = 0;
  let skipped = 0;
  for (const mapId of ids) {
    const entry = catalog.find((item) => item.mapId === mapId);
    if (!entry) {
      console.log(`${String(mapId).padStart(4)}  (not in the client's Map.dbc)`);
      continue;
    }
    const wdtBuffer = readFile(`World\\maps\\${entry.internalName}\\${entry.internalName}.wdt`);
    if (!wdtBuffer) {
      console.log(`${String(mapId).padStart(4)}  (no WDT)  ${entry.label}`);
      continue;
    }
    const wdt = readWdt(wdtBuffer);
    if (!wdt.wmo || !wdt.wmoOnly) {
      console.log(`${String(mapId).padStart(4)}  (tile map; its minimap comes from tiles)  ${entry.label}`);
      continue;
    }
    const wmoBaseName = path.win32.basename(wdt.wmo.name).replace(/\.wmo$/i, '').toLowerCase();
    const wmoDirectory = path.win32.dirname(wdt.wmo.name).replace(/^world\\/i, '').replace(/\\/g, '/').toLowerCase();
    const quadsByName = table.get(wmoDirectory) ?? new Map();
    const hasQuad = [...quadsByName.keys()].some((name) => name.startsWith(`${wmoBaseName}_`));
    if (!hasQuad) {
      console.log(`${String(mapId).padStart(4)}  (no ${wmoBaseName}_* quads in trs)  ${entry.label}`);
      continue;
    }
    if (!options.force && fs.existsSync(path.join(assetsDir, `${mapId}.png`))) {
      console.log(`${String(mapId).padStart(4)}  (already rendered; --force to re-render)  ${entry.label}`);
      skipped += 1;
      continue;
    }
    const result = await renderQuadMinimap({
      source: options.source,
      map: mapId,
      output: assetsDir,
      dryRun: options.dryRun,
    });
    if (!options.dryRun) {
      const { image } = result;
      const opaque = image.pixels.reduce((sum, pixel, at) => sum + (at % 4 === 3 && pixel > 0 ? 1 : 0), 0)
        / (image.width * image.height);
      console.log(`${String(mapId).padStart(4)}  ${image.width}x${image.height} px, ${(opaque * 100).toFixed(1)}% opaque  ${entry.label}`);
      rendered += 1;
    }
  }
  console.log(`\n${rendered} rendered, ${skipped} skipped.`);
}

main().catch((error) => {
  console.error(`render-quad-minimaps: ${error.message}`);
  process.exit(1);
});
