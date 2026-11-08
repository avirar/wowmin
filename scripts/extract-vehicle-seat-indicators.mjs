#!/usr/bin/env node
// Bakes the client's vehicle seat-indicator art (Interface\Vehicles\
// SeatIndicator — the Demolisher and Siege Engine silhouettes and their seat
// icons) and the seat layouts from VehicleUIIndicator.dbc and
// VehicleUIIndSeat.dbc, so the flat view can draw a vehicle with its seats
// and light the ones players sit in.
//
// Blizzard's art, so each install bakes its own (assets/vehicles is
// gitignored), like the map and scene assets.
//
// Output: assets/vehicles/seat-indicators.json plus the PNG art under
// assets/vehicles/art/. The seats' x/y are normalized over the indicator
// artwork (0,0 top-left), as in the client's DBC.

import fs from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { readDbc } from './scene/dbc.mjs';
import { decodeBlp } from './scene/textures.mjs';

const DEFAULTS = {
  // --source, then WOWMIN_CLIENT_DATA (the pipeline's convention), then this
  // host's known location.
  source: process.env.WOWMIN_CLIENT_DATA || '/root/wow-335-client',
  output: path.resolve(process.cwd(), 'assets/vehicles'),
};

function printUsage() {
  console.log(`Client vehicle seat-indicator bake

Usage:
  node scripts/extract-vehicle-seat-indicators.mjs [options]

Options:
  --source <dir>   WoW client root (default: $WOWMIN_CLIENT_DATA, then
                   ${DEFAULTS.source})
  --output <dir>   Asset directory (default: ./assets/vehicles)
  --help, -h       Show this message
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source': options.source = argv[++i]; break;
      case '--output': options.output = path.resolve(process.cwd(), argv[++i]); break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory under ${options.source}`);
  const readFile = openClientData(dataDir);
  const indicatorsDbc = readFile('DBFilesClient\\VehicleUIIndicator.dbc');
  const seatsDbc = readFile('DBFilesClient\\VehicleUIIndSeat.dbc');
  if (!indicatorsDbc || !seatsDbc) throw new Error('The client is missing VehicleUIIndicator.dbc / VehicleUIIndSeat.dbc.');

  const indicators = readDbc(indicatorsDbc);
  const seats = readDbc(seatsDbc);
  const seatsByIndicator = new Map();
  for (const row of seats.records()) {
    const indicator = row.uint(1);
    if (!seatsByIndicator.has(indicator)) seatsByIndicator.set(indicator, []);
    seatsByIndicator.get(indicator).push({ seat: row.uint(2), x: row.float(3), y: row.float(4) });
  }

  const artDir = path.join(options.output, 'art');
  fs.mkdirSync(artDir, { recursive: true });
  const baked = new Set();
  const bake = (blpPath, pngName) => {
    if (baked.has(pngName)) return true;
    const blp = readFile(blpPath);
    if (!blp) return false;
    const image = decodeBlp(blp);
    fs.writeFileSync(path.join(artDir, pngName),
      PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.rgba) }));
    baked.add(pngName);
    console.log(`  ✓ ${pngName} (${image.width}×${image.height})`);
    return true;
  };

  const table = {};
  for (const row of indicators.records()) {
    const indicator = row.uint(0);
    const texture = row.string(1);
    if (!texture) continue;
    const baseName = path.basename(texture.replace(/\\/g, '/'));
    const pngName = `${baseName.replace(/\.blp$/i, '')}.png`;
    if (!bake(texture, pngName)) {
      console.warn(`  ! indicator ${indicator}: art missing (${texture})`);
      continue;
    }
    // The per-seat icons beside the silhouette (Vehicle-<name>-Seat-N.blp),
    // baked for completeness; the flat view draws seat dots from the DBC.
    for (let seat = 1; seat <= 8; seat += 1) {
      const seatTexture = texture.replace(/\.blp$/i, `-Seat-${seat}.blp`);
      const seatPng = pngName.replace(/\.png$/, `-Seat-${seat}.png`);
      if (!bake(seatTexture, seatPng)) continue;
    }
    table[indicator] = { art: pngName, seats: seatsByIndicator.get(indicator) ?? [] };
  }
  // The generic seat button atlas beside the silhouettes (the client's
  // VehicleSeats.blp): kept with the rest of the folder's art.
  bake('Interface\\Vehicles\\VehicleSeats.blp', 'VehicleSeats.png');

  const output = {
    schemaVersion: 1,
    source: 'client seat indicator art (VehicleUIIndicator.dbc, VehicleUIIndSeat.dbc)',
    indicators: table,
  };
  const jsonPath = path.join(options.output, 'seat-indicators.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nDone: ${Object.keys(table).length} indicator(s), ${baked.size} image(s) -> ${jsonPath}`);
}

try {
  main();
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
}
