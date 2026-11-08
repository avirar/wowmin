#!/usr/bin/env node
// Bakes the client's world-map landmark table (AreaPOI.dbc): every point of
// interest whose icon is chosen by a world state — the outdoor PvP capture
// points and keeps (Wintergrasp's workshops, towers, and walls, Hellfire's
// three towers, the Plaguelands' towers, Zangarmarsh's, Terokkar's, Silithus's,
// Nagrand's Halaa, IoC's workshops). Each row carries nine icon variants; the
// client picks `icons[worldStateValue - 1]` and draws that cell of
// Interface\Minimap\POIIcons.blp (16 px cells, 16 columns).
//
// Blizzard's data, so each install bakes its own (assets/poi is gitignored).
//
// Output: assets/poi/world-pois.json.

import fs from 'node:fs';
import path from 'node:path';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { readDbc } from './scene/dbc.mjs';

const DEFAULTS = {
  // --source, then WOWMIN_CLIENT_DATA, then this host's known location.
  source: process.env.WOWMIN_CLIENT_DATA || '/root/wow-335-client',
  output: path.resolve(process.cwd(), 'assets/poi'),
};

function printUsage() {
  console.log(`Client world POI bake

Usage:
  node scripts/extract-world-pois.mjs [options]

Options:
  --source <dir>   WoW client root (default: $WOWMIN_CLIENT_DATA, then
                   ${DEFAULTS.source})
  --output <dir>   Asset directory (default: ./assets/poi)
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
  const buffer = readFile('DBFilesClient\\AreaPOI.dbc');
  if (!buffer) throw new Error('The client is missing DBFilesClient/AreaPOI.dbc.');

  // Field layout (AzerothCore's AreaPOIEntryfmt): id at 0, nine icon indices
  // at 2..10, x/y/z at 12..14, map id at 15, area id at 17, name at 18, and
  // the world state at 52.
  const dbc = readDbc(buffer);
  const pois = [];
  for (const record of dbc.records()) {
    const worldState = record.uint(52);
    if (!worldState) continue;
    const name = record.string(18);
    if (!name) continue;
    pois.push({
      id: record.uint(0),
      name,
      map: record.uint(15),
      area: record.uint(17),
      x: Number(record.float(12).toFixed(3)),
      y: Number(record.float(13).toFixed(3)),
      z: Number(record.float(14).toFixed(3)),
      worldState,
      icons: Array.from({ length: 9 }, (_, index) => record.int(2 + index)),
    });
  }

  const output = {
    schemaVersion: 1,
    source: 'client world map landmarks (AreaPOI.dbc, Interface\\Minimap\\POIIcons.blp)',
    // The client's icon atlas layout (CGMinimapFrame::InitializeGame in the
    // decompiled client): 14 columns, 18 px pitch, 1 px inset, 17 px icons.
    iconColumns: 14,
    iconPitchPx: 18,
    iconInsetPx: 1,
    iconCellPx: 17,
    pois,
  };
  fs.mkdirSync(options.output, { recursive: true });
  const jsonPath = path.join(options.output, 'world-pois.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  const byMap = new Map();
  for (const poi of pois) byMap.set(poi.map, (byMap.get(poi.map) ?? 0) + 1);
  console.log(`Done: ${pois.length} world-state POIs -> ${jsonPath}`);
  console.log(`  by map: ${[...byMap.entries()].map(([map, count]) => `${map}:${count}`).join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
}
