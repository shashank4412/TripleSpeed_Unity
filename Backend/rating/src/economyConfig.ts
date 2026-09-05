/**
 * Parses the `redline_economy` Remote Config JSON into the typed settings the
 * functions and the proof both need. Ported from EconomyConfig.cs.
 *
 * All money is INTEGER CENTS, including in the source JSON. There is no
 * conversion step here and there must never be one again: the config authored
 * dollars (0.50, 1.00, ...) until S-101 and converted with `Math.round(v * 100)`,
 * which is exact for the ladder that happened to be there and silently wrong for
 * the next value someone adds (`Math.round(1.005 * 100) === 100`). Because the
 * conversion ran once at startup, such an error would have become a wrong
 * constant for the lifetime of the process — every preview, every settlement and
 * every ledger row consistently wrong, with nothing to compare against.
 *
 * The key is named `stakeCents` rather than `stakes` so the unit is unmissable
 * at the point of authoring. A key whose unit you have to look up is a key
 * someone will one day read wrong.
 */
import type { EloSettings } from './elo.js';
import type { MatchmakingSettings, RoleAsymmetrySettings } from './matchmakingSettings.js';
import type { CollusionPolicy } from './collusion.js';
import type { LeagueSettings } from './leagues.js';

export interface MoneySettings {
  readonly currency: string;
  /** The stake ladder, in cents, ascending. */
  readonly stakesCents: readonly number[];
  /** 1000 = 10%. pot = stake*2; rake = round-half-even(pot * bp / 10000). */
  readonly rakeBasisPoints: number;
  /** A tie's odd remainder cent goes to this side. Always the poster (ADR 0002). */
  readonly tieOddCentToPoster: boolean;
  /** How long a posted challenge stays answerable before it expires and refunds. */
  readonly challengeTtlSeconds: number;
  /** How long after committing a player has to submit before the run is ABANDONED(0). */
  readonly noSubmissionWindowSeconds: number;
}

export interface EconomyConfig {
  readonly money: MoneySettings;
  readonly rating: EloSettings;
  readonly leagues: LeagueSettings;
  readonly matchmaking: MatchmakingSettings;
  readonly roleAsymmetry: RoleAsymmetrySettings;
}

/**
 * Reads a money amount that is already a whole number of cents, and refuses
 * anything else by naming the key. No arithmetic, no rounding mode, no epsilon:
 * a value either is an integer or the config is wrong, and a config that is
 * wrong about money must fail at parse rather than be repaired at parse.
 */
function cents(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where} must be a number of cents, got ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `${where} must be an integer number of cents, got ${value}. ` +
        `Money is authored in cents: write 50 for fifty cents, not 0.50.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${where} = ${value} exceeds the exact-integer range (2^53)`);
  }
  return value;
}

/** Rake basis points: an integer in [0, 10000]. 1000 bp = 10%. */
function basisPoints(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error(`${where} must be an integer in [0, 10000], got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}.${key} must be a number`);
  return v;
}

function bool(o: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : fallback;
}

function obj(o: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const v = o[key];
  if (typeof v !== 'object' || v === null) throw new Error(`${where}.${key} must be an object`);
  return v as Record<string, unknown>;
}

export function parseEconomyConfig(text: string): EconomyConfig {
  const root = JSON.parse(text) as Record<string, unknown>;

  const money = obj(root, 'money', 'economy');
  const rating = obj(root, 'rating', 'economy');
  const mm = obj(root, 'matchmaking', 'economy');
  const role = obj(root, 'roleAsymmetry', 'economy');

  const stakesRaw = money['stakeCents'];
  if (!Array.isArray(stakesRaw)) throw new Error('economy.money.stakeCents must be an array');
  const stakesCents = stakesRaw
    .map((s, i) => cents(s, `economy.money.stakeCents[${i}]`))
    .sort((a, b) => a - b);
  // A stake of zero or less is not a stake. Caught here rather than at settle(),
  // which would otherwise throw per-match on a config a reviewer edited live.
  for (const s of stakesCents) {
    if (s <= 0) throw new Error(`economy.money.stakeCents contains a non-positive stake: ${s}`);
  }

  const tie = obj(money, 'tie', 'economy.money');
  const noSub = obj(money, 'noSubmission', 'economy.money');

  const kFactorsRaw = rating['kFactors'];
  if (!Array.isArray(kFactorsRaw)) throw new Error('economy.rating.kFactors must be an array');
  const kFactors = kFactorsRaw.map((b) => {
    const band = b as Record<string, unknown>;
    return {
      maxMatches: typeof band['maxMatches'] === 'number' ? (band['maxMatches'] as number) : null,
      maxRating: typeof band['maxRating'] === 'number' ? (band['maxRating'] as number) : null,
      k: num(band, 'k', 'economy.rating.kFactors[]'),
    };
  });

  const leagues = obj(rating, 'leagues', 'economy.rating');
  const boundariesRaw = leagues['boundaries'];
  if (!Array.isArray(boundariesRaw)) throw new Error('economy.rating.leagues.boundaries must be an array');

  const band = obj(mm, 'band', 'economy.matchmaking');
  const recent = obj(mm, 'recentOpponent', 'economy.matchmaking');
  const npp = obj(mm, 'newPlayerProtection', 'economy.matchmaking');
  const collusionRaw = obj(mm, 'collusion', 'economy.matchmaking');

  const collusion: CollusionPolicy = {
    blockSameAccount: collusionRaw['sameAccount'] === 'block',
    blockSameDevice: collusionRaw['sameDeviceFingerprint'] === 'block',
    blockSamePaymentInstrument: collusionRaw['samePaymentInstrument'] === 'block',
    sharedIpWindowMinutes: num(collusionRaw, 'sharedIpWindowMinutes', 'economy.matchmaking.collusion'),
  };

  const parsed: EconomyConfig = {
    money: {
      currency: typeof money['currency'] === 'string' ? (money['currency'] as string) : 'USD',
      stakesCents,
      // Basis points are not cents but they are on the money path: a fractional
      // bp would reintroduce a float into the rake multiply. settle() rejects
      // one too; this rejects it once, at parse, rather than once per match.
      rakeBasisPoints: basisPoints(money['rakeBasisPoints'], 'economy.money.rakeBasisPoints'),
      tieOddCentToPoster: (tie['oddCentGoesTo'] ?? 'poster') === 'poster',
      challengeTtlSeconds: num(money, 'challengeTtlSeconds', 'economy.money'),
      noSubmissionWindowSeconds: num(noSub, 'windowSeconds', 'economy.money.noSubmission'),
    },
    rating: {
      initial: num(rating, 'initial', 'economy.rating'),
      floor: num(rating, 'floor', 'economy.rating'),
      ceiling: typeof rating['ceiling'] === 'number' ? (rating['ceiling'] as number) : null,
      provisionalMatches: num(rating, 'provisionalMatches', 'economy.rating'),
      kFactors,
    },
    leagues: { boundaries: (boundariesRaw as unknown[]).map(Number) },
    matchmaking: {
      exactStakeOnly: (mm['stakeMatch'] ?? 'exact') === 'exact',
      band: {
        initial: num(band, 'initial', 'economy.matchmaking.band'),
        widenPer10s: num(band, 'widenPer10s', 'economy.matchmaking.band'),
        cap: num(band, 'cap', 'economy.matchmaking.band'),
      },
      recentOpponent: {
        maxMatches: num(recent, 'maxMatches', 'economy.matchmaking.recentOpponent'),
        windowHours: num(recent, 'windowHours', 'economy.matchmaking.recentOpponent'),
      },
      newPlayerProtection: {
        matches: num(npp, 'matches', 'economy.matchmaking.newPlayerProtection'),
        excludeTopDecile: bool(npp, 'excludeTopDecile', true),
      },
      collusion,
    },
    roleAsymmetry: {
      hideTargetFromChallenger: bool(role, 'hideTargetFromChallenger', true),
    },
  };

  return parsed;
}

/** Display tiers, parsed on demand (nothing in settlement or matchmaking reads them). */
export function parseLeagueBoundaries(text: string): number[] {
  const root = JSON.parse(text) as Record<string, unknown>;
  const rating = obj(root, 'rating', 'economy');
  const leagues = obj(rating, 'leagues', 'economy.rating');
  const boundaries = leagues['boundaries'];
  if (!Array.isArray(boundaries)) throw new Error('economy.rating.leagues.boundaries must be an array');
  return boundaries.map(Number);
}
