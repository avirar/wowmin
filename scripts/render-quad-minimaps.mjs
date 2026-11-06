#!/usr/bin/env node
// Batch pass of render-quad-minimap.mjs over the deployed instance maps.
// Two sources of the client's indoor minimap quad art:
//
//   1. WMO-only maps: the WDT's single building, whose md5translate.trs
//      carries quads named after it, becomes the map's <mapId> image +
//      metadata (primary artwork).
//   2. Mixed (terrain + WMO) maps from MIXED_QUAD_MAPS below: the WMOs
//      placed in the map's ADT tiles, the ones whose quads the trs
//      carries, are composed into <mapId>-quads.png and merged into the
//      existing paper metadata as an alternate source the renderer can
//      toggle to. Where the client ships no usable paper art (placeholder
//      minimap tiles), the quad art becomes the primary instead.
//
// Maps that already have their image are skipped unless --force.
//
//   node scripts/render-quad-minimaps.mjs --source /path/to/client [--assets-dir dir] [--force] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { readWdt, readAdtPlacements, dedupeByUniqueId } from './scene/placement.mjs';
import { parseMd5TranslateTable, renderQuadMinimap } from './render-quad-minimap.mjs';

// The curated mixed (terrain + WMO) maps: every ADT-placed WMO carrying
// quads is composed. `primary` maps have no usable paper art (the client
// ships only placeholder minimap tiles, or none at all), so the quad art
// becomes their main metadata. `verify` maps get an extra bounds report for
// a spot-check against the paper art before shipping.
// Not listed: 658 Pit of Saron (only tiny outdoor micro-WMOs), 724 The Ruby
// Sanctum (a single quad), and battlegrounds 566/607 (four quads with art
// each) and 13 (none).
const MIXED_QUAD_MAPS = {
  129: { primary: true }, // Razorfen Downs: all paper tiles are the client's placeholder
  189: { primary: true }, // Scarlet Monastery: same placeholder tiles, four wings
  30: {},     // Alterac Valley: fortification-wall quads only, kept as an experiment
  269: {},
  489: {},    // Warsong Gulch: ditto
  529: {},    // Arathi Basin: ditto
  595: {},
  600: {},
  601: {},
  602: {},
  603: {},
  604: {},
  608: {},
  617: { primary: true }, // Dalaran Sewers: no paper art deployed
  618: { primary: true }, // Ring of Valor: no paper art deployed
  619: { verify: true }, // AHN: the only quad WMO is the Uldaman surface roof
  624: {},
  // 628 Isle of Conquest is composed by render-terrain-composite.mjs
  // (textured terrain bake + quads), not the quads-only pass.
  631: {},
  632: {},
  649: {},
  668: {},
};

function parseArgs(argv) {
  const options = { source: null, assetsDir: null, force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--assets-dir' || arg === '-a') options.assetsDir = argv[++index];
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
}

// Merge the quad artwork into the map's paper metadata as an alternate
// source (the paper art stays primary); the renderer toggles between them.
function mergeQuadAlternate(assetsDir, mapId, metadata) {
  const jsonPath = path.join(assetsDir, `${mapId}.json`);
  if (!fs.existsSync(jsonPath)) {
    // No paper metadata to merge into: keep the quad art as primary.
    fs.writeFileSync(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`  No ${mapId}.json to merge into; wrote the quad art as primary`);
    return;
  }
  const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const alternate = {
    image: metadata.image,
    width: metadata.width,
    height: metadata.height,
    worldMapBounds: metadata.worldMapBounds,
    projection: metadata.projection,
    source: metadata.source,
  };
  existing.alternates = (existing.alternates ?? []).filter((item) => item.image !== alternate.image);
  existing.alternates.push(alternate);
  fs.writeFileSync(jsonPath, `${JSON.stringify(existing, null, 2)}\n`);
  console.log(`  Merged ${alternate.image} into ${mapId}.json alternates (paper stays primary)`);
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
    const mapPath = `World\\maps\\${entry.internalName}\\${entry.internalName}`;
    const wdtBuffer = readFile(`${mapPath}.wdt`);
    if (!wdtBuffer) {
      console.log(`${String(mapId).padStart(4)}  (no WDT)  ${entry.label}`);
      continue;
    }
    const wdt = readWdt(wdtBuffer);

    if (wdt.wmo && wdt.wmoOnly) {
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
      continue;
    }

    const mixed = MIXED_QUAD_MAPS[mapId];
    if (!mixed) {
      console.log(`${String(mapId).padStart(4)}  (tile map; its minimap comes from tiles)  ${entry.label}`);
      continue;
    }

    // Mixed map: collect the ADT-placed WMOs (one entry per unique building
    // placement) that carry quads in the trs.
    const placements = new Map();
    for (const tile of wdt.tiles) {
      const buffer = readFile(`${mapPath}_${tile.x}_${tile.y}.adt`);
      if (!buffer) continue;
      for (const wmo of dedupeByUniqueId(readAdtPlacements(buffer).wmos)) {
        if (!placements.has(wmo.uniqueId)) placements.set(wmo.uniqueId, wmo);
      }
    }
    const wmos = [...placements.values()].filter((placement) => {
      const directory = path.win32.dirname(placement.name).replace(/^world\\/i, '').replace(/\\/g, '/').toLowerCase();
      const base = path.win32.basename(placement.name).replace(/\.wmo$/i, '').toLowerCase();
      const byName = table.get(directory);
      return byName ? [...byName.keys()].some((name) => name.startsWith(`${base}_`)) : false;
    });
    if (!wmos.length) {
      console.log(`${String(mapId).padStart(4)}  (no ADT WMO with quads)  ${entry.label}`);
      continue;
    }
    const quadImage = `${mixed.primary ? mapId : `${mapId}-quads`}.png`;
    if (!options.force && fs.existsSync(path.join(assetsDir, quadImage))) {
      console.log(`${String(mapId).padStart(4)}  (already rendered; --force to re-render)  ${entry.label}`);
      skipped += 1;
      continue;
    }
    const result = await renderQuadMinimap({
      source: options.source,
      map: mapId,
      output: assetsDir,
      wmos,
      asAlternate: !mixed.primary,
      dryRun: options.dryRun,
    });
    if (options.dryRun) continue;
    const { image, metadata } = result;
    const opaque = image.pixels.reduce((sum, pixel, at) => sum + (at % 4 === 3 && pixel > 0 ? 1 : 0), 0)
      / (image.width * image.height);
    console.log(`${String(mapId).padStart(4)}  ${image.width}x${image.height} px, ${(opaque * 100).toFixed(1)}% opaque, ${wmos.length} WMO  ${entry.label}`);
    if (!mixed.primary) mergeQuadAlternate(assetsDir, mapId, metadata);
    if (mixed.verify) {
      console.log(`  spot-check: quad bounds ${JSON.stringify(metadata.worldMapBounds)}`);
    }
    rendered += 1;
  }
  console.log(`\n${rendered} rendered, ${skipped} skipped.`);
}

main().catch((error) => {
  console.error(`render-quad-minimaps: ${error.message}`);
  process.exit(1);
});
