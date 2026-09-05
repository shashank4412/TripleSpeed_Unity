import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseGameConfig, GameConfig } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

describe('config hash parity with the C# core', () => {
  it('redline.game.json hashes to the reference value 5088b8b1eac58908', () => {
    const text = readFileSync(resolve(repoRoot, 'Backend/config/redline.game.json'), 'utf8');
    const { config, configHash } = parseGameConfig(text);
    // This constant is produced by GameConfig.computeHash over the current
    // Backend/config/redline.game.json and is embedded in Backend/testvectors/vectors.tsv's
    // header. The shipped config has moved twice on purpose, so the hash has too:
    //   4a8e0d2964dc27e2  original
    //   683ab2c3e7e1e975  after maxEncounterWindowTicks 180 -> 600 (ADR 0005)
    //   5088b8b1eac58908  after the cashout lane's hazardWeight 0.05 -> 0.00
    //                     (no hurdles on the bank lane)
    // Update it here and in vectors.tsv's header together whenever the shipped
    // config content changes.
    expect(configHash).toBe('5088b8b1eac58908');
    expect(config.configHash).toBe('5088b8b1eac58908');
  });

  it('redline.economy.json hashes to the reference value 7b76a0e9dbf95336', () => {
    const text = readFileSync(resolve(repoRoot, 'Backend/config/redline.economy.json'), 'utf8');
    // Moved b73e3bff04ab31db -> 7b76a0e9dbf95336 when the $comment fields'
    // docs/decisions/... references became DevDocs/decisions/... (docs/ renamed
    // to DevDocs/). Not gated on submit like redline.game.json's hash — this is
    // a drift regression check, not a client/server parity check — but update
    // it here whenever the shipped economy config's bytes change.
    expect(GameConfig.computeHash(text)).toBe('7b76a0e9dbf95336');
  });

  it('CRLF and LF checkouts of the same content hash identically', () => {
    const lf = '{\n  "a": 1\n}\n';
    const crlf = '{\r\n  "a": 1\r\n}\r\n';
    expect(GameConfig.computeHash(lf)).toBe(GameConfig.computeHash(crlf));
  });

  it('parses the shipped 4-lane config', () => {
    const text = readFileSync(resolve(repoRoot, 'Backend/config/redline.game.json'), 'utf8');
    const { config } = parseGameConfig(text);
    expect(config.lanes.length).toBe(4);
    expect(config.startLane).toBe(2);
    expect(config.cashoutLane).toBe(3);
    expect(config.positionScale).toBe(60000);
    expect(config.multiplierOf(0)).toBe(5);
    expect(config.effectiveMultiplier(0, 1)).toBe(2);
  });

  it('parses the 5-lane config without hardcoding 4', () => {
    const text = readFileSync(resolve(repoRoot, 'Backend/config/redline.game.5lane.json'), 'utf8');
    const { config } = parseGameConfig(text);
    expect(config.lanes.length).toBe(5);
  });
});
