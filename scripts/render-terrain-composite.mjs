#!/usr/bin/env node
// Composes a map's minimap artwork from its outdoor terrain plus its WMO
// minimap quads. The client's outdoor minimap is exactly these two layers
// (MinimapFrame.cpp: engine-rendered terrain zoom tiles, with the WMO quad
// art overlaid); this repack carries neither its zoom tiles nor
// MinimapArea.dbc, so the terrain layer is baked straight from the ADTs:
// the tileset textures projected top-down onto the heightmap at 1 pixel
// per world unit, with the 3D scene's texture and splat conventions
// (scripts/scene/terrain.mjs and the renderer's terrain-material.ts).
// Where no tile exists, a pixel is a hole, or the terrain lies below the
// water level, the ocean colour from the map's Light.dbc is used. The WMO
// quads are pasted over the bake at the same 1 px/unit scale (see
// scripts/scene/quad-minimap.mjs for the client maths).
//
// The image covers the quads' union, which becomes the map's world map
// bounds. The baked image becomes the map's primary artwork; its previous
// artwork (the M-key paper) is kept as the paper alternate, and any
// quads-only alternate is replaced.
//
//   node scripts/render-terrain-composite.mjs --source /path/to/client --map 628 [--assets-dir dir] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { readDbc } from './scene/dbc.mjs';
import { decodeBlp, encodeRgba } from './scene/textures.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt } from './scene/placement.mjs';
import { isPlaceholderArea, isPlaceholderChunk, loadMapArea, WDT_FLAG_BIG_ALPHA } from './scene/terrain.mjs';
import { mapLiquidColours } from './scene/liquids.mjs';
import { pasteQuad, quadImageRect } from './scene/quad-minimap.mjs';
import { collectMinimapQuads, parseMd5TranslateTable } from './render-quad-minimap.mjs';

const SCALE = 1; // 1 image px per world unit.
const TILE_SIZE = 1600 / 3;
const CHUNK_SIZE = TILE_SIZE / 16;
// Ground textures repeat 8 times across a chunk (terrain-material.ts).
const TEXTURE_REPEAT = CHUNK_SIZE / 8;
const SPLAT_SIZE = 64;
const TERRAIN_TEXTURE_MAX = 256;
const COMPOSITE_SOURCE = 'engine terrain + WMO minimap quads';

function fail(message, stack) {
  console.error(`render-terrain-composite: ${message}`);
  if (stack) console.error(stack);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { map: null, source: null, assetsDir: null, dryRun: false, waterLevel: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--map') options.map = Number(argv[++index]);
    else if (arg === '--assets-dir' || arg === '-a') options.assetsDir = argv[++index];
    else if (arg === '--water-level') options.waterLevel = Number(argv[++index]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else fail(`Unknown argument ${arg}.`);
  }
  return options;
}

// A WDT tile's world span: the tile's north-west corner is
// ((32 - y) * TILE, (32 - x) * TILE) and the tile runs -TILE on both axes
// from it (verified against chunk 0 positions in the ADTs).
function tileBounds(tile) {
  return {
    minX: (31 - tile.y) * TILE_SIZE,
    maxX: (32 - tile.y) * TILE_SIZE,
    minY: (31 - tile.x) * TILE_SIZE,
    maxY: (32 - tile.x) * TILE_SIZE,
  };
}

// Bakes the map's terrain top-down into `image` (pre-filled with the ocean
// colour), one pixel per world unit, within `union`. The texture and splat
// conventions match the 3D scene: layer 0 is the base colour and layers
// 1-3 mix over it by their 64 x 64 per-chunk alpha (splat row 0 at the
// chunk's north edge, column 0 at its west); the layer textures repeat
// TEXTURE_REPEAT world units, u with world X and v with world Y.
function bakeTerrain({ readFile, mapPath, wdt, union, image, waterLevel }) {
  const bigAlpha = Boolean(wdt.flags & WDT_FLAG_BIG_ALPHA);
  const { width, height, pixels } = image;
  const fract = (value) => ((value % 1) + 1) % 1;

  // A pixel's place within its chunk depends only on the global chunk
  // grid, not on which chunk it is: precomputed per image row (world X)
  // and column (world Y) — the outer-vertex grid (heights, holes), the
  // splat grid, and the texture coordinate.
  const rowVertex = new Int8Array(height);
  const rowVertexF = new Float32Array(height);
  const rowHole = new Int8Array(height);
  const rowSplat = new Int8Array(height);
  const rowSplatF = new Float32Array(height);
  const rowTex = new Float32Array(height);
  const colVertex = new Int8Array(width);
  const colVertexF = new Float32Array(width);
  const colHole = new Int8Array(width);
  const colSplat = new Int8Array(width);
  const colSplatF = new Float32Array(width);
  const colTex = new Float32Array(width);
  for (let row = 0; row < height; row += 1) {
    const v = fract(-(union.maxX - row) / CHUNK_SIZE); // fraction south of the chunk's north edge
    const vertex = v * 8;
    const splat = v * SPLAT_SIZE;
    rowVertex[row] = Math.min(7, vertex | 0);
    rowVertexF[row] = vertex - rowVertex[row];
    rowHole[row] = (rowVertex[row] >> 1) * 4;
    rowSplat[row] = Math.min(63, splat | 0);
    rowSplatF[row] = splat - rowSplat[row];
    rowTex[row] = fract((union.maxX - row) / TEXTURE_REPEAT);
  }
  for (let col = 0; col < width; col += 1) {
    const u = fract(-(union.maxY - col) / CHUNK_SIZE); // fraction east of the chunk's west edge
    const vertex = u * 8;
    const splat = u * SPLAT_SIZE;
    colVertex[col] = Math.min(7, vertex | 0);
    colVertexF[col] = vertex - colVertex[col];
    colHole[col] = (colVertex[col] >> 1) * 4;
    colSplat[col] = Math.min(63, splat | 0);
    colSplatF[col] = splat - colSplat[col];
    colTex[col] = fract((union.maxY - col) / TEXTURE_REPEAT);
  }

  const textures = new Map();
  const getTexture = (name) => {
    if (!textures.has(name)) {
      const buffer = readFile(name);
      textures.set(name, buffer ? decodeBlp(buffer, TERRAIN_TEXTURE_MAX) : null);
    }
    return textures.get(name);
  };

  let chunks = 0;
  let skipped = 0;
  let landPixels = 0;
  for (const tile of wdt.tiles) {
    const bounds = tileBounds(tile);
    if (bounds.minX > union.maxX || bounds.maxX < union.minX || bounds.minY > union.maxY || bounds.maxY < union.minY) continue;
    const adt = readFile(`${mapPath}_${tile.x}_${tile.y}.adt`);
    if (!adt) continue;
    const area = loadMapArea(adt, bigAlpha);
    if (isPlaceholderArea(area)) continue;
    area.chunks.forEach((chunk) => {
      if (!chunk.vertexHeights || isPlaceholderChunk(chunk)) {
        skipped += 1;
        return;
      }
      const layers = [0, 1, 2, 3].map((layer) => (chunk.layers[layer] ? getTexture(chunk.layers[layer].texture) : null));
      if (!layers[0] && !layers[1] && !layers[2] && !layers[3]) {
        skipped += 1;
        return;
      }
      const splats = [1, 2, 3].map((layer) => chunk.layers[layer]?.splat ?? null);
      const left = Math.max(0, Math.round((union.maxY - chunk.position[1]) * SCALE));
      const right = Math.min(width, Math.round((union.maxY - (chunk.position[1] - CHUNK_SIZE)) * SCALE));
      const top = Math.max(0, Math.round((union.maxX - chunk.position[0]) * SCALE));
      const bottom = Math.min(height, Math.round((union.maxX - (chunk.position[0] - CHUNK_SIZE)) * SCALE));
      if (right <= left || bottom <= top) return;
      const heights = chunk.vertexHeights;
      const holes = chunk.holes ?? 0;
      const zBase = chunk.position[2];
      chunks += 1;
      for (let row = top; row < bottom; row += 1) {
        const vertexRow0 = rowVertex[row] * 17;
        const vertexRow1 = vertexRow0 + 17;
        const vertexF = rowVertexF[row];
        const holeRow = rowHole[row];
        const splatRow = rowSplat[row];
        const splatRow1 = Math.min(63, splatRow + 1);
        const splatF = rowSplatF[row];
        const texRow = rowTex[row];
        for (let col = left; col < right; col += 1) {
          if (holes & (1 << (holeRow + colHole[col]))) continue;
          const vertexCol = colVertex[col];
          const vertexFCol = colVertexF[col];
          const terrainHeight = (heights[vertexRow0 + vertexCol] * (1 - vertexF) + heights[vertexRow0 + vertexCol + 1] * vertexF) * (1 - vertexFCol)
            + (heights[vertexRow1 + vertexCol] * (1 - vertexF) + heights[vertexRow1 + vertexCol + 1] * vertexF) * vertexFCol;
          if (zBase + terrainHeight < waterLevel) continue;
          const texCol = colTex[col];
          const base = layers[0];
          let r;
          let g;
          let b;
          if (base) {
            const at = ((texCol * base.height) | 0) * base.width + ((texRow * base.width) | 0);
            const pixel = at * 4;
            r = base.rgba[pixel];
            g = base.rgba[pixel + 1];
            b = base.rgba[pixel + 2];
          } else {
            r = g = b = 127;
          }
          const splatCol = colSplat[col];
          const splatCol1 = Math.min(63, splatCol + 1);
          const splatFCol = colSplatF[col];
          for (let layer = 1; layer < 4; layer += 1) {
            const texture = layers[layer];
            const splat = splats[layer - 1];
            if (!texture || !splat) continue;
            const alpha = (splat[splatRow * SPLAT_SIZE + splatCol] * (1 - splatF) + splat[splatRow * SPLAT_SIZE + splatCol1] * splatF) * (1 - splatFCol)
              + (splat[splatRow1 * SPLAT_SIZE + splatCol] * (1 - splatF) + splat[splatRow1 * SPLAT_SIZE + splatCol1] * splatF) * splatFCol;
            if (alpha <= 0) continue;
            const mix = alpha / 255;
            const at = ((texCol * texture.height) | 0) * texture.width + ((texRow * texture.width) | 0);
            const pixel = at * 4;
            r += (texture.rgba[pixel] - r) * mix;
            g += (texture.rgba[pixel + 1] - g) * mix;
            b += (texture.rgba[pixel + 2] - b) * mix;
          }
          const dest = (row * width + col) * 4;
          pixels[dest] = r;
          pixels[dest + 1] = g;
          pixels[dest + 2] = b;
          landPixels += 1;
        }
      }
    });
  }
  return { chunks, skipped, landPixels };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) throw new Error('Missing required --source argument.');
  if (!Number.isInteger(options.map)) throw new Error('Missing or invalid --map argument.');
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory in ${options.source}`);
  const readFile = openClientData(dataDir);
  const assetsDir = options.assetsDir
    ? path.resolve(options.assetsDir)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'instances');

  const catalog = await buildMapCatalog(readFile, { mapIds: [options.map] });
  const entry = catalog.find((item) => item.mapId === options.map);
  if (!entry) throw new Error(`Map ${options.map} is not in the client's Map.dbc`);
  const mapPath = `World\\maps\\${entry.internalName}\\${entry.internalName}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) throw new Error(`Missing ${mapPath}.wdt`);
  const wdt = readWdt(wdtBuffer);
  if (!wdt.tiles.length) throw new Error(`${entry.internalName} has no terrain tiles`);

  // The map's ADT-placed WMOs that carry quads in the trs (one entry per
  // unique placement): WMOs without any quad entry would only widen the
  // bounds with art the client never draws.
  const placements = new Map();
  for (const tile of wdt.tiles) {
    const buffer = readFile(`${mapPath}_${tile.x}_${tile.y}.adt`);
    if (!buffer) continue;
    for (const wmo of dedupeByUniqueId(readAdtPlacements(buffer).wmos)) {
      if (!placements.has(wmo.uniqueId)) placements.set(wmo.uniqueId, wmo);
    }
  }
  const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
  if (!trsBuffer) throw new Error('Missing textures\\Minimap\\md5translate.trs');
  const table = parseMd5TranslateTable(trsBuffer);
  const wmos = [...placements.values()].filter((placement) => {
    const directory = path.win32.dirname(placement.name).replace(/^world\\/i, '').replace(/\\/g, '/').toLowerCase();
    const base = path.win32.basename(placement.name).replace(/\.wmo$/i, '').toLowerCase();
    const byName = table.get(directory);
    return byName ? [...byName.keys()].some((name) => name.startsWith(`${base}_`)) : false;
  });
  const { quads, baseNames } = collectMinimapQuads({ readFile, table, placements: wmos });
  if (!quads.length) throw new Error(`${entry.internalName} has no minimap quads to compose`);
  const minOf = (a, b) => (b < a ? b : a);
  const maxOf = (a, b) => (b > a ? b : a);
  const union = {
    minX: quads.map((quad) => quad.world.minX).reduce(minOf),
    maxX: quads.map((quad) => quad.world.maxX).reduce(maxOf),
    minY: quads.map((quad) => quad.world.minY).reduce(minOf),
    maxY: quads.map((quad) => quad.world.maxY).reduce(maxOf),
  };
  const width = Math.round((union.maxY - union.minY) * SCALE);
  const height = Math.round((union.maxX - union.minX) * SCALE);
  console.log(`  ${quads.length} quads for ${baseNames.length} WMOs; union x[${union.minX.toFixed(1)}, ${union.maxX.toFixed(1)}] y[${union.minY.toFixed(1)}, ${union.maxY.toFixed(1)}] -> ${width}x${height} px`);

  const pixels = new Uint8ClampedArray(width * height * 4);
  const lights = readFile('DBFilesClient\\Light.dbc');
  const bands = readFile('DBFilesClient\\LightIntBand.dbc');
  const colours = lights && bands ? mapLiquidColours(readDbc(lights), readDbc(bands).byId(), options.map) : null;
  const ocean = (colours?.ocean ?? [0.12, 0.36, 0.52]).map((value) => Math.round(value * 255));
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = ocean[0];
    pixels[index + 1] = ocean[1];
    pixels[index + 2] = ocean[2];
    pixels[index + 3] = 255;
  }

  const image = { width, height, pixels };
  const stats = bakeTerrain({ readFile, mapPath, wdt, union, image, waterLevel: options.waterLevel });
  console.log(`  terrain: ${stats.chunks} chunks (${stats.skipped} placeholder/layerless skipped), ${(100 * stats.landPixels / (width * height)).toFixed(1)}% land`);
  if (options.dryRun) return;

  const decoded = new Map();
  let pasted = 0;
  for (const quad of quads) {
    if (!quad.hash) continue;
    if (!decoded.has(quad.hash)) {
      const buffer = readFile(`textures\\Minimap\\${quad.hash}`);
      if (!buffer) {
        console.warn(`  ! ${quad.name} hashes to ${quad.hash}, which the client does not carry`);
        continue;
      }
      decoded.set(quad.hash, decodeBlp(buffer, TERRAIN_TEXTURE_MAX));
    }
    pasteQuad(image, decoded.get(quad.hash), quadImageRect(quad.world, union, SCALE));
    pasted += 1;
  }
  console.log(`  pasted ${pasted} quads over the bake`);

  const encoded = encodeRgba({ width, height, rgba: image.pixels });
  const extension = encoded.mimeType === 'image/png' ? 'png' : 'jpg';
  const imageFile = `${options.map}.${extension}`;
  const jsonPath = path.join(assetsDir, `${options.map}.json`);
  const old = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  let paper = null;
  if (old && !(old.source?.includes('terrain') ?? false)) {
    // First composite pass: the map's current artwork (the M-key paper)
    // becomes the paper alternate, and the quads-only alternate is
    // replaced by the composite. The composite reuses the old image's
    // file name, so the paper is moved aside before it is overwritten.
    if (old.image && fs.existsSync(path.join(assetsDir, old.image))) {
      const paperFile = `${options.map}-paper${path.extname(old.image) || '.jpg'}`;
      fs.renameSync(path.join(assetsDir, old.image), path.join(assetsDir, paperFile));
      paper = {
        image: paperFile,
        width: old.width,
        height: old.height,
        worldMapBounds: old.worldMapBounds,
        projection: old.projection,
        source: 'WorldMap paper (M key)',
        minTileX: old.minTileX,
        minTileY: old.minTileY,
        maxTileX: old.maxTileX,
        maxTileY: old.maxTileY,
        gridSize: old.gridSize,
        worldUnitsPerTile: old.worldUnitsPerTile,
        tileWidth: old.tileWidth,
        tileHeight: old.tileHeight,
      };
    }
    for (const alternate of old.alternates ?? []) {
      if (alternate.source?.includes('quads') && fs.existsSync(path.join(assetsDir, alternate.image))) {
        fs.unlinkSync(path.join(assetsDir, alternate.image));
      }
    }
  } else {
    paper = (old?.alternates ?? []).find((alternate) => alternate.image.startsWith(`${options.map}-paper`)) ?? null;
  }
  const metadata = {
    schemaVersion: 1,
    mapId: options.map,
    label: entry.label,
    mapType: entry.mapType,
    mapTypeLabel: entry.mapTypeLabel,
    clientDirectory: entry.internalName,
    image: imageFile,
    width,
    height,
    worldMapBounds: {
      minX: union.minX,
      maxX: union.maxX,
      minY: union.minY,
      maxY: union.maxY,
    },
    projection: { type: 'worldMapArea' },
    source: COMPOSITE_SOURCE,
    alternates: paper ? [paper] : [],
  };
  fs.writeFileSync(path.join(assetsDir, imageFile), encoded.data);
  fs.writeFileSync(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`  Wrote ${imageFile} (${width}x${height}) and ${options.map}.json${paper ? ` (paper kept as ${paper.image})` : ''}`);
}

// A count of the distinct terrain textures decoded so far (diagnostic).
function texturesUsed() {
  return '';
}

main().catch((error) => fail(error.message, error.stack));
