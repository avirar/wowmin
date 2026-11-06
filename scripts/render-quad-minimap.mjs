#!/usr/bin/env node
// Composes a map's minimap artwork from its WMO minimap quads. The quads are
// the same textures the in-game minimap draws (see
// scripts/scene/quad-minimap.mjs for the client maths); this writes them
// into <mapId>.jpg plus the <mapId>.json metadata the renderer loads, in
// the renderer's bounds projection (width with world -Y, height with world
// -X) at the client's 2 pixels per world unit. For maps whose WDT is a
// single WMO the building's placement is read from the WDT; for mixed
// terrain+WMO maps the caller passes the ADT WMO placements (see
// render-quad-minimaps.mjs), and with --as-alternate the image is written
// as <mapId>-quads.* beside an existing paper artwork instead of
// overwriting the metadata.
//
//   node scripts/render-quad-minimap.mjs --source /path/to/client --map 369

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { loadWmo } from './scene/wmo.mjs';
import { rotateByQuaternion, readWdt } from './scene/placement.mjs';
import { decodeBlp, encodeRgba } from './scene/textures.mjs';
import { groupQuadGrid, quadImageRect, quadTextureName, pasteQuad, QUAD_TEXEL_WORLD_UNITS } from './scene/quad-minimap.mjs';

const SCALE = 1 / QUAD_TEXEL_WORLD_UNITS; // 2 image px per world unit.

function fail(message, stack) {
  console.error(`render-quad-minimap: ${message}`);
  if (stack) console.error(stack);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { map: null, output: null, source: null, dryRun: false, asAlternate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--map') options.map = Number(argv[++index]);
    else if (arg === '--output' || arg === '-o') options.output = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--as-alternate') options.asAlternate = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else fail(`Unknown argument ${arg}.`);
  }
  return options;
}

// md5translate.trs: "dir: <logical dir>" lines followed by
// "<logical path> <hashed file name>" entries. Exported so the batch and
// discovery passes reuse the exact same (case-normalised) parse.
export function parseMd5TranslateTable(buffer) {
  const byDirectory = new Map();
  let current = null;
  for (const rawLine of buffer.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('dir: ')) {
      // Case-normalised: the table's directories don't always match the
      // WDT's WMO path casing (WMO\... vs wmo\...).
      current = line.slice(5).trim().replace(/\\/g, '/').toLowerCase();
      if (!byDirectory.has(current)) byDirectory.set(current, new Map());
      continue;
    }
    if (!current) continue;
    const [logicalPath, hashedName] = line.split(/\s+/);
    if (!hashedName) continue;
    byDirectory.get(current).set(logicalPath.split('\\').pop().toLowerCase(), hashedName);
  }
  return byDirectory;
}

export function transformBounds(local, rotation, position, scale) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = local;
  const corners = [
    rotateByQuaternion([minX, minY, minZ], rotation),
    rotateByQuaternion([minX, minY, maxZ], rotation),
    rotateByQuaternion([minX, maxY, minZ], rotation),
    rotateByQuaternion([minX, maxY, maxZ], rotation),
    rotateByQuaternion([maxX, minY, minZ], rotation),
    rotateByQuaternion([maxX, minY, maxZ], rotation),
    rotateByQuaternion([maxX, maxY, minZ], rotation),
    rotateByQuaternion([maxX, maxY, maxZ], rotation),
  ].map(([x, y, z]) => [x * scale + position[0], y * scale + position[1], z * scale + position[2]]);
  // Arrow wrappers: reduce passes its index and array on, which this Node
  // build's Math.min does not ignore.
  const minOf = (a, b) => (b < a ? b : a);
  const maxOf = (a, b) => (b > a ? b : a);
  const axis = (index, fold) => corners.map((corner) => corner[index]).reduce(fold);
  return {
    minX: axis(0, minOf), maxX: axis(0, maxOf),
    minY: axis(1, minOf), maxY: axis(1, maxOf),
    minZ: axis(2, minOf), maxZ: axis(2, maxOf),
  };
}

// A map's minimap quads: every placed WMO's groups tiled into the client's
// quad grid, each with its md5translate.trs texture hash and its world
// bounds through the placement. `placements` is the WDT's single building
// for WMO-only maps, or the caller's ADT-placed WMOs for mixed maps. One
// WMO's groups are loaded once per file name (a placement list can carry
// the same WMO several times, at different placements).
export function collectMinimapQuads({ readFile, table, placements }) {
  const wmoInfo = new Map();
  const quads = [];
  const baseNames = [];
  for (const placement of placements) {
    let info = wmoInfo.get(placement.name);
    if (!info) {
      const wmo = loadWmo(placement.name, readFile);
      const base = path.win32.basename(placement.name).replace(/\.wmo$/i, '');
      const directory = path.win32.dirname(placement.name).replace(/^world\\/i, '').replace(/\\/g, '/').toLowerCase();
      const byName = table.get(directory) ?? new Map();
      if (!table.has(directory)) console.warn(`  ! No ${directory} directory in md5translate.trs`);
      info = { base, byName, groups: wmo.groups };
      wmoInfo.set(placement.name, info);
    }
    if (!baseNames.includes(info.base)) baseNames.push(info.base);
    for (const group of info.groups) {
      for (const quad of groupQuadGrid(group.boundingBox, group.index)) {
        const name = quadTextureName(info.base, quad.groupId, quad.x, quad.y);
        quads.push({
          ...quad,
          name,
          hash: info.byName.get(name.toLowerCase()) ?? null,
          world: transformBounds(quad.bounds, placement.rotation, placement.position, placement.scale),
        });
      }
    }
  }
  quads.sort((left, right) => left.world.minZ + left.world.maxZ - (right.world.minZ + right.world.maxZ));
  return { quads, baseNames };
}

export async function renderQuadMinimap(options) {
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory in ${options.source}`);
  const readFile = openClientData(dataDir);
  const catalog = (await buildMapCatalog(readFile, { mapIds: [options.map] }));
  const entry = catalog.find((item) => item.mapId === options.map);
  if (!entry) throw new Error(`Map ${options.map} is not in the client's Map.dbc`);
  const mapPath = `World\\maps\\${entry.internalName}\\${entry.internalName}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) throw new Error(`Missing ${mapPath}.wdt`);
  const wdt = readWdt(wdtBuffer);

  // The placements to compose: the WDT's single building for WMO-only maps,
  // or the caller's list (the map's ADT-placed WMOs for mixed maps).
  const placements = options.wmos?.length
    ? options.wmos
    : (wdt.wmo && wdt.wmoOnly ? [wdt.wmo] : null);
  if (!placements) {
    throw new Error(`${entry.internalName} is not a single-WMO map and no WMO placements were given; its minimap comes from tiles instead.`);
  }

  const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
  if (!trsBuffer) throw new Error('Missing textures\\Minimap\\md5translate.trs');
  const table = parseMd5TranslateTable(trsBuffer);
  const { quads, baseNames } = collectMinimapQuads({ readFile, table, placements });
  const missing = quads.filter((quad) => !quad.hash);
  console.log(`  ${quads.length} quads computed for ${baseNames.join(', ')} (${quads.length - missing.length} in md5translate.trs)`);
  if (options.dryRun) {
    for (const quad of quads) console.log(`    ${quad.name}${quad.hash ? '' : '  (missing)'}`);
    return { quads };
  }

  const union = {
    minX: Math.min(...quads.map((quad) => quad.world.minX)),
    maxX: Math.max(...quads.map((quad) => quad.world.maxX)),
    minY: Math.min(...quads.map((quad) => quad.world.minY)),
    maxY: Math.max(...quads.map((quad) => quad.world.maxY)),
  };
  const image = {
    width: Math.round((union.maxY - union.minY) * SCALE),
    height: Math.round((union.maxX - union.minX) * SCALE),
    pixels: new Uint8ClampedArray(Math.round((union.maxY - union.minY) * SCALE) * Math.round((union.maxX - union.minX) * SCALE) * 4),
  };
  const decoded = new Map();
  for (const quad of quads) {
    if (!quad.hash) continue;
    if (!decoded.has(quad.hash)) {
      const buffer = readFile(`textures\\Minimap\\${quad.hash}`);
      if (!buffer) {
        console.warn(`  ! ${quad.name} hashes to ${quad.hash}, which the client does not carry`);
        continue;
      }
      decoded.set(quad.hash, decodeBlp(buffer, 256));
    }
    pasteQuad(image, decoded.get(quad.hash), quadImageRect(quad.world, union, SCALE));
  }
  const encoded = encodeRgba({ width: image.width, height: image.height, rgba: image.pixels });
  const extension = encoded.mimeType === 'image/png' ? 'png' : 'jpg';
  // Beside an existing paper artwork the quad image takes its own file name
  // and the metadata is merged in by the caller instead of written here.
  const imageBase = options.asAlternate ? `${options.map}-quads` : `${options.map}`;
  const metadata = {
    schemaVersion: 1,
    mapId: options.map,
    label: entry.label,
    mapType: entry.mapType,
    mapTypeLabel: entry.mapTypeLabel,
    clientDirectory: entry.internalName,
    image: `${imageBase}.${extension}`,
    width: image.width,
    height: image.height,
    worldMapBounds: {
      minX: union.minX,
      maxX: union.maxX,
      minY: union.minY,
      maxY: union.maxY,
    },
    projection: { type: 'worldMapArea' },
    // The image's source, for the subtitle: the client's own indoor
    // minimap quads, not the paper artwork.
    source: `WMO minimap quads (${baseNames.join(', ')})`,
  };
  const outputDir = options.output;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, metadata.image), encoded.data);
  if (!options.asAlternate) {
    fs.writeFileSync(path.join(outputDir, `${options.map}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`  Wrote ${path.join(outputDir, metadata.image)} (${image.width}x${image.height}) and ${options.map}.json`);
  } else {
    console.log(`  Wrote ${path.join(outputDir, metadata.image)} (${image.width}x${image.height}); merge it into ${options.map}.json`);
  }
  return { quads, image, metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) fail('Missing required --source argument.');
  if (!Number.isInteger(options.map)) fail('Missing or invalid --map argument.');
  if (!options.output) options.output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'instances');
  renderQuadMinimap(options).catch((error) => fail(error.message, error.stack));
}
