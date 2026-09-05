/**
 * The economy config is money, so it is tested against the REAL file rather than
 * a fixture. A fixture would keep passing after someone edits the shipped ladder
 * into dollars again, which is the exact regression S-101 exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEconomyConfig } from '../src/economyConfig.js';
import { settle } from '../src/settlement.js';

const ROOT_CONFIG = new URL('../../../Backend/config/redline.economy.json', import.meta.url);
const FALLBACK_CONFIG = new URL('../../functions/config/redline.economy.json', import.meta.url);

const rootText = readFileSync(ROOT_CONFIG, 'utf8');
const economy = parseEconomyConfig(rootText);

describe('economy config is authored in integer cents', () => {
  it('parses the shipped ladder as integers', () => {
    expect(economy.money.stakesCents).toEqual([50, 100, 200, 500, 1000]);
    for (const s of economy.money.stakesCents) expect(Number.isInteger(s)).toBe(true);
  });

  it('contains no non-integer money value in the raw JSON', () => {
    const raw = JSON.parse(rootText) as { money: Record<string, unknown> };
    const money = raw.money;
    // Every numeric leaf under `money` must be a whole number. Strings starting
    // with `$` are prose and are skipped; they document, they do not settle.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'number') {
        if (!Number.isInteger(node)) offenders.push(`${path} = ${node}`);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith('$')) continue;
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(money, 'money');
    expect(offenders).toEqual([]);
  });

  it('rejects a fractional stake, naming the key', () => {
    const raw = JSON.parse(rootText) as Record<string, unknown>;
    (raw['money'] as Record<string, unknown>)['stakeCents'] = [50, 50.5, 1000];
    expect(() => parseEconomyConfig(JSON.stringify(raw))).toThrow(
      /economy\.money\.stakeCents\[1\].*integer number of cents.*50\.5/s,
    );
  });

  it('rejects a fractional rake, naming the key', () => {
    const raw = JSON.parse(rootText) as Record<string, unknown>;
    (raw['money'] as Record<string, unknown>)['rakeBasisPoints'] = 1000.5;
    expect(() => parseEconomyConfig(JSON.stringify(raw))).toThrow(
      /economy\.money\.rakeBasisPoints/,
    );
  });

  it('makes no claim that server-side money is a decimal type', () => {
    expect(rootText).not.toMatch(/C# decimal/);
    expect(rootText).toMatch(/INTEGER CENTS/);
  });

  it('declares inactivity as "none", per ADR 0012', () => {
    // The config is the only thing a reviewer can read to learn what happens to
    // an idle rating. "freeze" named a mechanism we do not have.
    const raw = JSON.parse(rootText) as { rating: { inactivity: { mode: string } } };
    expect(raw.rating.inactivity.mode).toBe('none');
  });
});

describe('the functions fallback copy has not drifted', () => {
  // Backend/functions/config/* is the server's fallback when Remote Config is
  // unreachable. It is hand-maintained: nothing generates it, so nothing but a
  // test will notice when someone edits one copy and not the other.
  it('is byte-identical to the source of truth', () => {
    expect(readFileSync(FALLBACK_CONFIG, 'utf8')).toBe(rootText);
  });
});

describe('stake x 2 == payout + rake, over the whole shipped ladder', () => {
  // Enumerates the ladder as parsed from the shipped config rather than a copy
  // of it, so adding a stake to the config adds a case here automatically.
  it.each(economy.money.stakesCents)('holds at %d cents', (stakeCents) => {
    for (const outcome of ['posterWins', 'challengerWins', 'tie'] as const) {
      const s = settle(stakeCents, economy.money.rakeBasisPoints, outcome, economy.money.tieOddCentToPoster);
      expect(s.potCents).toBe(stakeCents * 2);
      expect(s.payoutCents + s.rakeCents).toBe(stakeCents * 2);
      expect(s.posterCreditCents + s.challengerCreditCents + s.rakeCents).toBe(stakeCents * 2);
      expect(Number.isInteger(s.rakeCents)).toBe(true);
      expect(Number.isInteger(s.payoutCents)).toBe(true);
    }
  });

  it('values did not move: the ladder is still 50c to $10', () => {
    // S-101 was a representation change. If this test ever needs editing, the
    // change was a retune and needs a decision, not a commit.
    expect(economy.money.stakesCents).toEqual([50, 100, 200, 500, 1000]);
    expect(economy.money.rakeBasisPoints).toBe(1000);
    expect(settle(50, 1000, 'posterWins').rakeCents).toBe(10);
    expect(settle(1000, 1000, 'posterWins').rakeCents).toBe(200);
  });
});
