#!/usr/bin/env node
// Bulk-render the client's in-game minimap art (textures\Minimap tiles,
// resolved through md5translate.trs in the MPQs) for every map that has a
// minimap tile directory, and merge it into the 2D instance asset metadata
// as the "minimap" side of the paper/minimap artwork toggle.
//
// The stitch is the client's own: each WDT tile gets the 256x256 BLP the
// game draws on its minimap, laid out at u = (tileX - min) * 256,
// v = (tileY - min) * 256 — the same grid the renderer's minimapTiles
// projection maps world coordinates onto, so markers align by construction.
//
// Merge rules for assets/instances/<id>.json:
//   - no asset                         -> minimap becomes the primary
//   - primary is paper (worldMapArea)  -> minimap becomes the primary,
//                                         the paper moves to alternates[0]
//   - primary is composite/terrain or
//     dungeonFloors                     -> minimap is added as an alternate
//   - primary is already minimapTiles  -> left untouched (same source art)
// New art is always written to <id>-minimap.jpg, so existing files are
// never clobbered.

import fs from 'node:fs';
import path from 'node:path';

import jpeg from 'jpeg-js';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { parseMd5TranslateTable } from './render-quad-minimap.mjs';
import { readWdt } from './scene/placement.mjs';
import { decodeBlp } from './scene/textures.mjs';

// World math of the 3.3.5 client (WorldConstants.h): one minimap tile covers
// MD_AREA_POLY_SIZE world units; the renderer carries the same constant.
const WORLD_UNITS_PER_TILE = 533.3333333333334;
const TILE_PX = 256;
const GRID_SIZE = 64;
const MINIMAP_SOURCE = 'client minimap tiles';
// The client shows unknown minimap areas as dark; missing tiles inside the
// stitched box (ocean corners, off-map WDT tiles) get the same fill.
const DARK = [14, 24, 44];
const MAX_CANVAS_PX = 16384;
const TILE_NAME = /^map(\d{1,3})_(\d{1,2})\.blp$/;

const DEFAULTS = {
  // Client data root: --source, then WOWMIN_CLIENT_DATA (the pipeline's
  // convention, see export-scenes.mjs), then this host's known location.
  source: process.env.WOWMIN_CLIENT_DATA || '/root/wow-335-client',
  assetsDir: path.resolve(process.cwd(), 'assets/instances'),
  serverDbc: '/root/azerothcore-wotlk/env/dist/bin/dbc/Map.dbc',
  mapIds: [],
  quality: 90,
  dryRun: false,
};

function printUsage() {
  console.log(`Client minimap tile bulk renderer

Usage:
  node scripts/render-minimap-tiles.mjs [options]

Options:
  --source <dir>       WoW client root (default: $WOWMIN_CLIENT_DATA, then
                       ${DEFAULTS.source})
  --assets-dir <dir>   Instance asset dir (default: ./assets/instances)
  --server-dbc <file>  Server-side Map.dbc for extra map records
  --map <ids>          Comma-separated map IDs to process (default: all)
  --quality <1-100>    JPEG quality (default: 90)
  --dry-run            Report the census and merge plan without writing
  --help, -h           Show this message
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source': options.source = argv[++i]; break;
      case '--assets-dir': options.assetsDir = argv[++i]; break;
      case '--server-dbc': options.serverDbc = argv[++i]; break;
      case '--map': options.mapIds = argv[++i].split(',').map((x) => Number(x)); break;
      case '--quality': options.quality = Number(argv[++i]); break;
      case '--dry-run': options.dryRun = true; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.mapIds.some((id) => !Number.isInteger(id) || id < 0)) {
    throw new Error(`--map must be comma-separated non-negative integers, got: ${options.mapIds.join(', ')}`);
  }
  return options;
}

// Every Map.dbc record (parseMapDbc filters by requested IDs or instance
// types; the census needs world maps too, and test maps that the client
// table lacks). Fields: id@0, internalName@4, mapType@8, displayName@20.
function parseAllMapDbc(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'WDBC') return [];
  const recordCount = buffer.readUInt32LE(4);
  const fieldCount = buffer.readUInt32LE(8);
  const recordSize = buffer.readUInt32LE(12);
  if (fieldCount < 6 || recordSize < 24) return [];
  const stringBlockOffset = 20 + recordCount * recordSize;
  const readString = (offset) => {
    if (offset === 0) return '';
    const start = stringBlockOffset + offset;
    let end = start;
    while (end < buffer.length && buffer[end] !== 0) end += 1;
    return buffer.toString('utf8', start, end);
  };
  const mapTypeLabels = ['world', 'instance', 'raid', 'battleground', 'arena'];
  const entries = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = 20 + index * recordSize;
    const mapId = buffer.readUInt32LE(offset);
    const mapType = buffer.readUInt32LE(offset + 8);
    const internalName = readString(buffer.readUInt32LE(offset + 4));
    const displayName = readString(buffer.readUInt32LE(offset + 20));
    entries.push({
      mapId,
      mapType,
      mapTypeLabel: mapTypeLabels[mapType] ?? `type-${mapType}`,
      label: displayName || internalName || `Map ${mapId}`,
      internalName,
    });
  }
  return entries;
}

// One record per map ID: the client table wins (it is what the art targets),
// the server table fills in maps the client lacks.
function buildMapCatalog(readFile, serverDbcPath) {
  const byId = new Map();
  let serverEntries = [];
  if (serverDbcPath && fs.existsSync(serverDbcPath)) {
    serverEntries = parseAllMapDbc(fs.readFileSync(serverDbcPath));
    for (const entry of serverEntries) byId.set(entry.mapId, entry);
  }
  let clientEntries = [];
  const clientMap = readFile('DBFilesClient\\Map.dbc');
  if (clientMap) {
    clientEntries = parseAllMapDbc(clientMap);
    for (const entry of clientEntries) byId.set(entry.mapId, entry);
  }
  // Prefer the record whose internalName actually matches the art directory.
  const byDirectory = new Map();
  for (const entry of [...serverEntries, ...clientEntries]) {
    if (!entry.internalName) continue;
    const key = entry.internalName.toLowerCase();
    if (!byDirectory.has(key)) byDirectory.set(key, []);
    byDirectory.get(key).push(entry);
  }
  for (const [key, entries] of byDirectory) {
    const preferred = entries.find((entry) => byId.get(entry.mapId)?.internalName?.toLowerCase() === key);
    if (preferred) byDirectory.set(key, [preferred, ...entries.filter((entry) => entry !== preferred)]);
  }
  return { byDirectory, entries: [...byId.values()] };
}

// Tile coordinates from a trs directory's logical file names.
function tileCoordinates(trsDir) {
  const tiles = [];
  const seen = new Set();
  for (const logicalName of trsDir.keys()) {
    const match = logicalName.match(TILE_NAME);
    if (!match) continue;
    const x = Number(match[1]);
    const y = Number(match[2]);
    const key = `${x}_${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push({ x, y, logicalName });
  }
  return tiles;
}

// Stitch one map's trs tiles into a flattened RGBA canvas.
function stitchTiles(readFile, trsDir, tiles) {
  const minX = Math.min(...tiles.map((t) => t.x));
  const maxX = Math.max(...tiles.map((t) => t.x));
  const minY = Math.min(...tiles.map((t) => t.y));
  const maxY = Math.max(...tiles.map((t) => t.y));
  const width = (maxX - minX + 1) * TILE_PX;
  const height = (maxY - minY + 1) * TILE_PX;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = DARK[0];
    rgba[i + 1] = DARK[1];
    rgba[i + 2] = DARK[2];
    rgba[i + 3] = 255;
  }

  const missing = [];
  for (const tile of tiles) {
    const hash = trsDir.get(tile.logicalName);
    const blp = readFile(`textures\\Minimap\\${hash}`);
    if (!blp) {
      missing.push(`${tile.x}_${tile.y} (archive miss)`);
      continue;
    }
    let img;
    try {
      img = decodeBlp(blp);
    } catch (error) {
      missing.push(`${tile.x}_${tile.y} (decode: ${error.message})`);
      continue;
    }
    if (img.width !== TILE_PX || img.height !== TILE_PX) {
      missing.push(`${tile.x}_${tile.y} (${img.width}x${img.height})`);
      continue;
    }
    const ox = (tile.x - minX) * TILE_PX;
    const oy = (tile.y - minY) * TILE_PX;
    for (let py = 0; py < TILE_PX; py += 1) {
      const rowOffset = ((oy + py) * width + ox) * 4;
      const srcOffset = py * TILE_PX * 4;
      rgba.set(img.rgba.subarray(srcOffset, srcOffset + TILE_PX * 4), rowOffset);
    }
  }

  // Flatten any remaining alpha onto the dark fill so the result is a
  // plain JPEG (the renderer's map images are JPEG).
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha === 255) continue;
    const inv = 1 - alpha / 255;
    rgba[i] = Math.round(rgba[i] * (alpha / 255) + DARK[0] * inv);
    rgba[i + 1] = Math.round(rgba[i + 1] * (alpha / 255) + DARK[1] * inv);
    rgba[i + 2] = Math.round(rgba[i + 2] * (alpha / 255) + DARK[2] * inv);
    rgba[i + 3] = 255;
  }
  return {
    width,
    height,
    minX,
    maxX,
    minY,
    maxY,
    placed: tiles.length - missing.length,
    missing,
    encoded: jpeg.encode({ width, height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) }, 90).data,
  };
}

// The new art block in the metadata (primary or alternate).
function minimapArtBlock(imageName, stitch) {
  return {
    image: imageName,
    width: stitch.width,
    height: stitch.height,
    tileWidth: TILE_PX,
    tileHeight: TILE_PX,
    minTileX: stitch.minX,
    minTileY: stitch.minY,
    maxTileX: stitch.maxX,
    maxTileY: stitch.maxY,
    gridSize: GRID_SIZE,
    worldUnitsPerTile: WORLD_UNITS_PER_TILE,
    worldMapBounds: null,
    projection: { type: 'minimapTiles' },
    source: MINIMAP_SOURCE,
  };
}

function hasMinimapArt(json) {
  if (json?.projection?.type === 'minimapTiles' && !(json.source ?? '').includes('terrain')) return true;
  return (json?.alternates ?? []).some(
    (alternate) => alternate?.projection?.type === 'minimapTiles' || (alternate?.source ?? '').includes('client minimap tiles'));
}

// Apply the merge rules for one map ID; returns the planned/written action.
function mergeAsset(assetsDir, mapId, catalog, imageName, stitch) {
  const metadataPath = path.join(assetsDir, `${mapId}.json`);
  const block = minimapArtBlock(imageName, stitch);
  const existing = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
  if (!existing) {
    const entry = catalog.find((candidate) => candidate.mapId === mapId);
    const created = {
      schemaVersion: 1,
      mapId,
      label: entry?.label ?? `Map ${mapId}`,
      mapType: entry?.mapType ?? null,
      mapTypeLabel: entry?.mapTypeLabel ?? null,
      clientDirectory: entry?.internalName ?? null,
      ...block,
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(created, null, 2)}\n`);
    return 'created';
  }
  if (hasMinimapArt(existing)) return 'already-minimap';
  // Paper primaries get replaced: the client minimap becomes the primary and
  // the paper moves to alternates. Engine-baked composites (a source that
  // mentions the terrain render, e.g. Isle of Conquest) and dungeonFloors
  // primaries keep their art; the minimap joins their alternates.
  if (existing.projection?.type === 'worldMapArea' && !(existing.source ?? '').includes('terrain')) {
    const paperAlternate = {
      image: existing.image,
      width: existing.width,
      height: existing.height,
      worldMapBounds: existing.worldMapBounds ?? null,
      projection: { type: 'worldMapArea' },
      source: existing.source ?? 'WorldMap paper (M key)',
    };
    const swapped = {
      schemaVersion: existing.schemaVersion ?? 1,
      mapId: existing.mapId ?? mapId,
      label: existing.label,
      mapType: existing.mapType,
      mapTypeLabel: existing.mapTypeLabel,
      clientDirectory: existing.clientDirectory,
      ...block,
      alternates: [paperAlternate, ...(existing.alternates ?? [])],
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(swapped, null, 2)}\n`);
    return 'swapped-primary';
  }
  // Composite/terrain primaries and dungeonFloors keep their art; the
  // minimap joins the alternates the viewer can toggle to.
  existing.alternates = [...(existing.alternates ?? []), block];
  fs.writeFileSync(metadataPath, `${JSON.stringify(existing, null, 2)}\n`);
  return 'added-alternate';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory under ${options.source}`);
  const readFile = openClientData(dataDir);
  const trs = parseMd5TranslateTable(readFile('textures\\Minimap\\md5translate.trs'));
  const catalog = buildMapCatalog(readFile, options.serverDbc);

  const directories = [];
  for (const [dir, trsDir] of trs) {
    const tiles = tileCoordinates(trsDir);
    if (tiles.length === 0) continue;
    const matches = catalog.byDirectory.get(dir) ?? [];
    const mapIds = [...new Set(matches.map((entry) => entry.mapId))];
    if (options.mapIds.length > 0) {
      const kept = mapIds.filter((id) => options.mapIds.includes(id));
      if (kept.length === 0) continue;
    }
    const minX = Math.min(...tiles.map((t) => t.x));
    const maxX = Math.max(...tiles.map((t) => t.x));
    const minY = Math.min(...tiles.map((t) => t.y));
    const maxY = Math.max(...tiles.map((t) => t.y));
    const canvasW = (maxX - minX + 1) * TILE_PX;
    const canvasH = (maxY - minY + 1) * TILE_PX;
    let wdtTiles = null;
    let wdtError = null;
    if (matches[0]?.internalName) {
      try {
        const wdt = readFile(`World\\maps\\${matches[0].internalName}\\${matches[0].internalName}.wdt`);
        wdtTiles = wdt ? readWdt(wdt).tiles.length : null;
      } catch (error) {
        wdtError = error.message;
      }
    }
    directories.push({ dir, trsDir, tiles, matches, mapIds, canvasW, canvasH, wdtTiles, wdtError });
  }
  directories.sort((a, b) => a.mapIds[0] - b.mapIds[0] || a.dir.localeCompare(b.dir));

  console.log(`• ${directories.length} minimap tile director(ies), ${catalog.entries.length} Map.dbc record(s)`);
  const counts = new Map();
  for (const dir of directories) {
    if (dir.mapIds.length === 0) {
      console.log(`  - ${dir.dir}: ${dir.tiles.length} tile(s), no Map.dbc match -> skipped`);
      counts.set('skipped-unmatched', (counts.get('skipped-unmatched') ?? 0) + 1);
      continue;
    }
    if (Math.max(dir.canvasW, dir.canvasH) > MAX_CANVAS_PX) {
      console.log(`  - ${dir.dir} (map ${dir.mapIds.join(', ')}): canvas ${dir.canvasW}x${dir.canvasH} exceeds ${MAX_CANVAS_PX}px -> skipped`);
      counts.set('skipped-canvas', (counts.get('skipped-canvas') ?? 0) + 1);
      continue;
    }
    const names = dir.matches.map((m) => `${m.mapId} ${m.label}`).join('; ');
    const wdt = dir.wdtTiles === null ? (dir.wdtError ? `wdt: ${dir.wdtError}` : 'no wdt') : `wdt ${dir.wdtTiles}`;
    console.log(`  - ${dir.dir} -> ${names} | ${dir.tiles.length} tile(s), ${wdt}, canvas ${dir.canvasW}x${dir.canvasH}`);

    if (options.dryRun) {
      for (const mapId of dir.mapIds) {
        const metadataPath = path.join(options.assetsDir, `${mapId}.json`);
        const existing = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
        const state = !existing
          ? 'no-asset'
          : hasMinimapArt(existing)
            ? 'already-minimap'
            : existing.projection?.type === 'worldMapArea' && !(existing.source ?? '').includes('terrain')
              ? 'paper-primary -> swap'
              : `${existing.projection?.type ?? '?'} (${existing.source ?? 'no source'})-primary -> alternate`;
        counts.set(state, (counts.get(state) ?? 0) + 1);
        console.log(`      map ${mapId}: ${state}`);
      }
      continue;
    }

    // Skip the stitch when every map already carries this art: otherwise the
    // image would be written but referenced by nothing (idempotent re-runs).
    const needsArt = dir.mapIds.some((mapId) => {
      const metadataPath = path.join(options.assetsDir, `${mapId}.json`);
      return !fs.existsSync(metadataPath) || !hasMinimapArt(JSON.parse(fs.readFileSync(metadataPath, 'utf8')));
    });
    if (!needsArt) {
      for (const mapId of dir.mapIds) {
        counts.set('already-minimap', (counts.get('already-minimap') ?? 0) + 1);
        console.log(`      map ${mapId}: already-minimap`);
      }
      continue;
    }

    const imageBase = Math.min(...dir.mapIds);
    const imageName = `${imageBase}-minimap.jpg`;
    const stitch = stitchTiles(readFile, dir.trsDir, dir.tiles);
    if (stitch.missing.length > 0) {
      console.log(`      ! ${stitch.missing.length} tile(s) not placed: ${stitch.missing.slice(0, 8).join(', ')}${stitch.missing.length > 8 ? ', ...' : ''}`);
    }
    fs.writeFileSync(path.join(options.assetsDir, imageName), stitch.encoded);
    for (const mapId of dir.mapIds) {
      const action = mergeAsset(options.assetsDir, mapId, dir.matches, imageName, stitch);
      counts.set(action, (counts.get(action) ?? 0) + 1);
      console.log(`      map ${mapId}: ${action} -> ${imageName} (${stitch.width}x${stitch.height}, ${stitch.placed}/${dir.tiles.length} tiles)`);
    }
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s:`);
  for (const [action, count] of [...counts.entries()].sort()) {
    console.log(`  ${action}: ${count}`);
  }
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
});
