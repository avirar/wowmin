const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/live-map-telemetry.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} } };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const {
  buildLiveMapTelemetryCommand,
  parseLiveMapTelemetry,
  parseLiveMapTelemetrySnapshot,
} = context.module.exports;

test('builds standalone telemetry commands with optional session filters', () => {
  assert.equal(buildLiveMapTelemetryCommand(), 'wowmin telemetry');
  assert.equal(buildLiveMapTelemetryCommand(489), 'wowmin telemetry 489');
  assert.equal(buildLiveMapTelemetryCommand(489, 42), 'wowmin telemetry 489 42');
  assert.equal(buildLiveMapTelemetryCommand(undefined, 42), 'wowmin telemetry');
});

test('parses a complete live worldserver snapshot', () => {
  const message = [
    'WMAP_VERSION|1',
    'WMAP|Jaspianus|571|42|5800.125|620.500|647.250|1.750|80|1|1|9001|1|1|1',
    'WMAP_END|1',
  ].join('\n');
  const [player] = parseLiveMapTelemetry(message);
  assert.equal(player.name, 'Jaspianus');
  assert.equal(player.instanceId, 42);
  assert.equal(player.position_x, 5800.125);
  assert.equal(player.isBot, true);
  assert.equal(player.inCombat, true);
});

test('parses protocol v2 session, group, status, target, and role fields', () => {
  const row = [
    'WMAP', 'Jaspianus%7CTest', 489, 42, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 1, 1,
    3, 0, 1760000000, 77, 1, 2, 0, 72.5, 0, 44.5, 1234, 3, 'Training%7CPuppet', 10,
  ].join('|');
  const [player] = parseLiveMapTelemetry(`WMAP_VERSION|2\n${row}\nWMAP_END|1`);
  assert.equal(player.name, 'Jaspianus|Test');
  assert.equal(player.mapType, 3);
  assert.equal(player.sessionStartedAt, 1760000000);
  assert.equal(player.groupId, 77);
  assert.equal(player.isRaidGroup, true);
  assert.equal(player.healthPct, 72.5);
  assert.equal(player.targetName, 'Training|Puppet');
  assert.equal(player.roleMask, 10);
});

test('parses protocol v3 battleground summaries, objectives, resurrection, and bot roles', () => {
  const playerRow = [
    'WMAP', 'Jaspianus', 489, 42, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 0, 0,
    3, 0, 1760000000, 77, 1, 2, 0, 0, 0, 0, 0, 0, '', 10, 1, 7,
  ].join('|');
  const battlegroundRow = [
    'WBG', 489, 42, 2, 3, 90000, 0, 2, 1, 2, 10, 9, 8, 7, 12000, 1, 2,
  ].join('|');
  const message = [
    'WMAP_VERSION|3',
    playerRow,
    battlegroundRow,
    'WOBJ|489|42|1581|1',
    'WMAP_END|1|1|1',
  ].join('\n');
  const snapshot = parseLiveMapTelemetrySnapshot(message);
  assert.equal(snapshot.players[0].waitingForResurrect, true);
  assert.equal(snapshot.players[0].battlegroundRole, 7);
  assert.equal(snapshot.battlegrounds[0].status, 3);
  assert.equal(snapshot.battlegrounds[0].allianceStrategy, 1);
  assert.equal(snapshot.battlegrounds[0].worldStates[0].id, 1581);
});

test('parses protocol v4 encounter, death, and floor-context telemetry', () => {
  const playerRow = [
    'WMAP', 'Jaspianus', 631, 42, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 0, 1,
    2, 0, 1760000000, 77, 1, 2, 0, 75, 0, 100, 0, 0, '', 10, 0, -1, 20115,
  ].join('|');
  const message = [
    'WMAP_VERSION|4',
    playerRow,
    'WINS|631|42|3',
    'WBOSS|631|42|0|3|Lord%20Marrowgar',
    'WDEATH|631|42|9|1760000100|123|Jaspianus|456|3|Lord%20Marrowgar',
    'WMAP_END|1|0|0|1|1|1',
  ].join('\n');
  const snapshot = parseLiveMapTelemetrySnapshot(message);
  assert.equal(snapshot.players[0].wmoGroupId, 20115);
  assert.equal(snapshot.instances[0].bosses[0].name, 'Lord Marrowgar');
  assert.equal(snapshot.instances[0].bosses[0].state, 3);
  assert.equal(snapshot.deaths[0].victimName, 'Jaspianus');
  assert.equal(snapshot.deaths[0].killerName, 'Lord Marrowgar');
  assert.equal(snapshot.events.length, 0);
});

test('parses protocol v5 authoritative session events', () => {
  const playerRow = [
    'WMAP', 'Jaspianus', 631, 42, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 1, 0,
    2, 0, 1760000000, 77, 1, 2, 0, 100, 0, 100, 0, 0, '', 10, 0, -1, 20115,
  ].join('|');
  const message = [
    'WMAP_VERSION|5',
    playerRow,
    'WEVENT|631|42|17|1760000100|loot|123|Jaspianus|0|0||49908|Primordial%20Saronite|2',
    'WEVENT|631|42|18|1760000101|kill|123|Jaspianus|456|3|Cult%20Adherent|37949|Cult%20Adherent|1',
    'WMAP_END|1|0|0|0|0|0|2',
  ].join('\n');
  const snapshot = parseLiveMapTelemetrySnapshot(message);
  assert.equal(snapshot.events[0].valueName, 'Primordial Saronite');
  assert.equal(snapshot.events[0].amount, 2);
  assert.equal(snapshot.events[1].targetName, 'Cult Adherent');
});

test('parses protocol v6 gender and compact player state flags', () => {
  const playerRow = [
    'WMAP', 'Jaspianus', 571, 0, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 1, 1,
    0, 0, 0, 0, 0, 0, 1, 100, 0, 100, 0, 0, '', 0, 0, -1, -1, 1, 31,
  ].join('|');
  const snapshot = parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|6', playerRow, 'WMAP_END|1|0|0|0|0|0|0',
  ].join('\n'));
  const [player] = snapshot.players;
  assert.equal(player.gender, 1);
  assert.equal(player.onTaxi, true);
  assert.equal(player.mounted, true);
  assert.equal(player.sapped, true);
  assert.equal(player.stunned, true);
  assert.equal(player.spiritForm, true);
});

test('parses protocol v7 battleground flag carrier state', () => {
  const playerRow = [
    'WMAP', 'Carrier', 489, 7, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 1, 1,
    3, 0, 1760000000, 77, 0, 0, 1, 100, 0, 100, 0, 0, '', 0, 0, -1, -1, 0, 32,
  ].join('|');
  const snapshot = parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|7', playerRow, 'WMAP_END|1|0|0|0|0|0|0',
  ].join('\n'));
  assert.equal(snapshot.players[0].flagCarrier, true);
});

test('parses protocol v8/v9 transport positions', () => {
  const playerRow = [
    'WMAP', 'Jaspianus', 571, 0, 100, 200, 30, 1.5, 80, 1, 1, 9001, 1, 1, 1,
    0, 0, 0, 0, 0, 0, 1, 100, 0, 100, 0, 0, '', 0, 0, -1, -1, 1, 31,
  ].join('|');
  const transportRow = [
    'WTRN', 18442, 'Stormwind%7COrgrimmar%20Zeppelin', 0, 0, 1541.77, 5854.94, 3190.0, 0.75, 3200, 18472,
  ].join('|');
  const snapshot = parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|8', playerRow, transportRow, 'WMAP_END|1|1|0|0|0|0|0|0',
  ].join('\n'));
  assert.equal(snapshot.players.length, 1);
  const [transport] = snapshot.transports;
  assert.equal(transport.entry, 18442);
  assert.equal(transport.name, 'Stormwind|Orgrimmar Zeppelin');
  assert.equal(transport.map, 0);
  assert.equal(transport.position_x, 1541.77);
  assert.equal(transport.orientation, 0.75);
  assert.equal(transport.pathProgress, 3200);
  assert.equal(transport.displayId, 18472);
  // A v8 record predates the debug fields and the passenger lines.
  assert.equal(transport.guid, 0);
  assert.equal(transport.period, 0);
  assert.equal(transport.flags, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(transport.passengers)), []);

  // A 12-field v9 build (before WTPA) named its riders without offsets; the
  // record is still accepted, name-only, with the eight older counts.
  const legacyRow = ['WTRN', 18442, 'Zeppelin', 0, 0, 1, 2, 3, 0.5, 100, 18472, 'Thrall,Jaina'].join('|');
  const legacy = parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|9', playerRow, legacyRow, 'WMAP_END|1|1|0|0|0|0|0|0',
  ].join('\n'));
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.transports[0].passengers.map((p) => [p.guid, p.name]))),
    [[0, 'Thrall'], [0, 'Jaina']]);

  // Version 9 grows WTRN by five fields (object guid, period, flags, path
  // time, key frames) and gives each standing passenger a WTPA line with
  // their transport-local offset and the client's transport clock.
  const v9Row = [
    'WTRN', 18442, 'Stormwind%7COrgrimmar%20Zeppelin', 0, 0, 1541.77, 5854.94, 3190.0, 0.75, 3200, 18472,
    77, 120000, 3, 118000, 42,
  ].join('|');
  const riderRow = [
    'WTPA', 77, 4242, 'Thrall', '1.500', '-2.250', '6.099', '4.100', '-1', '1234', '5678',
  ].join('|');
  const v9 = parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|9', playerRow, v9Row, riderRow, 'WMAP_END|1|1|0|0|0|0|0|0|1',
  ].join('\n'));
  const v9Transport = v9.transports[0];
  assert.equal(v9Transport.guid, 77);
  assert.equal(v9Transport.period, 120000);
  assert.equal(v9Transport.flags, 3);
  assert.equal(v9Transport.pathTime, 118000);
  assert.equal(v9Transport.keyFrames, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(v9Transport.passengers)), [
    { guid: 4242, name: 'Thrall', x: 1.5, y: -2.25, z: 6.099, orientation: 4.1, seat: -1, time: 1234, time2: 5678 },
  ]);
  // A rider whose transport record is missing is a malformed snapshot, and
  // so is a declared passenger count that disagrees.
  assert.equal(parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|9', playerRow, riderRow, 'WMAP_END|1|0|0|0|0|0|0|0|1',
  ].join('\n')), null);
  assert.equal(parseLiveMapTelemetrySnapshot([
    'WMAP_VERSION|9', playerRow, v9Row, riderRow, 'WMAP_END|1|1|0|0|0|0|0|0|0',
  ].join('\n')), null);
});

test('rejects v8 snapshots with mismatched transport counts or stray rows', () => {
  const transportRow = ['WTRN', 18442, 'Zeppelin', 0, 0, 1, 2, 3, 0.5, 100, 18472].join('|');
  // The count says no transports, one was sent.
  assert.equal(parseLiveMapTelemetrySnapshot(`WMAP_VERSION|8\n${transportRow}\nWMAP_END|0|0|0|0|0|0|0|0`), null);
  // A transport with too few fields.
  assert.equal(parseLiveMapTelemetrySnapshot('WMAP_VERSION|8\nWTRN|18442|Zeppelin|0|0|1|2|3\nWMAP_END|0|1|0|0|0|0|0|0'), null);
  // A v7 snapshot never carries transports.
  assert.equal(parseLiveMapTelemetrySnapshot(`WMAP_VERSION|7\n${transportRow}\nWMAP_END|0|0|0|0|0|0|0`), null);
});

test('rejects truncated snapshots', () => {
  const message = 'WMAP|Jaspianus|571|0|1|2|3|4|80|1|1|9001|1|1|0\nWMAP_END|2';
  assert.equal(parseLiveMapTelemetry(message), null);
});

test('rejects unsupported telemetry protocol versions', () => {
  assert.equal(parseLiveMapTelemetry('WMAP_VERSION|3\nWMAP_END|0'), null);
});
