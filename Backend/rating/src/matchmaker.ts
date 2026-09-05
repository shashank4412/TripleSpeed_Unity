/**
 * Selects a posted challenge for an arriving player. Ported verbatim from
 * src/Redline.Rating/Matchmaker.cs.
 *
 * Not queue pairing: the pool is a live inventory of challenges that already
 * have a number attached, and an arriving challenger is selected INTO one. Every
 * decision is here and none is behind IChallengeInventory, which is what lets
 * the proof run this exact class over dictionaries and have the result mean
 * something about the server.
 */
import type { IChallengeInventory, Challenge, Challenger } from './challengeInventory.js';
import type { CollusionLink } from './collusion.js';
import type { MatchmakingSettings } from './matchmakingSettings.js';
import type { IClock } from './clock.js';

export type ExclusionReason =
  | 'outsideRatingBand'
  | 'recentOpponent'
  | 'sameAccount'
  | 'sameDevice'
  | 'samePaymentInstrument'
  | 'sharedIp'
  | 'newPlayerProtection';

export interface Excluded {
  readonly matchId: string;
  readonly reason: ExclusionReason;
}

export type MatchmakingOutcome = 'matched' | 'postOwnChallenge';

export interface MatchmakingResult {
  readonly outcome: MatchmakingOutcome;
  readonly selected: Challenge | null;
  /** How many open challenges existed at this stake before any filter. */
  readonly considered: number;
  /** Every rejected candidate and the first rule that rejected it. */
  readonly excluded: readonly Excluded[];
  /** The widest band any candidate was judged against. */
  readonly ratingBandCap: number;
}

export class Matchmaker {
  constructor(
    private readonly inventory: IChallengeInventory,
    private readonly clock: IClock,
    private readonly settings: MatchmakingSettings,
  ) {}

  async select(challenger: Challenger): Promise<MatchmakingResult> {
    const now = this.clock.nowMs();

    const candidates = await this.inventory.openAtStake(challenger.stakeCents);

    const recent = await this.inventory.recentOpponentCounts(
      challenger.accountId,
      now - this.settings.recentOpponent.windowHours * 3_600_000,
    );
    const linked = await this.inventory.linkedAccounts(challenger.accountId, this.settings.collusion, now);

    const isNew =
      this.settings.newPlayerProtection.excludeTopDecile &&
      challenger.settledMatches < this.settings.newPlayerProtection.matches;
    const topDecileFloor = isNew ? await this.inventory.topDecileRating() : Number.MAX_SAFE_INTEGER;

    const excluded: Excluded[] = [];
    const survivors: Array<{ challenge: Challenge; ratingDistance: number }> = [];
    let widestBand = 0;

    for (const candidate of candidates) {
      const band = this.bandFor(candidate, now);
      if (band > widestBand) widestBand = band;

      const reason = this.reject(candidate, challenger, band, recent, linked, isNew, topDecileFloor);
      if (reason) {
        excluded.push({ matchId: candidate.matchId, reason });
        continue;
      }
      survivors.push({ challenge: candidate, ratingDistance: Math.abs(candidate.creatorRating - challenger.rating) });
    }

    survivors.sort(
      (a, b) =>
        a.ratingDistance - b.ratingDistance ||
        a.challenge.createdAt - b.challenge.createdAt ||
        (a.challenge.matchId < b.challenge.matchId ? -1 : a.challenge.matchId > b.challenge.matchId ? 1 : 0),
    );

    const selected = survivors[0]?.challenge ?? null;

    return {
      outcome: selected ? 'matched' : 'postOwnChallenge',
      selected,
      considered: candidates.length,
      excluded,
      ratingBandCap: widestBand,
    };
  }

  /** The band a challenge is currently willing to accept — widens with age, capped. */
  bandFor(challenge: Challenge, nowMs: number): number {
    const ageSeconds = Math.max(0, (nowMs - challenge.createdAt) / 1000);
    const widened =
      this.settings.band.initial + this.settings.band.widenPer10s * Math.floor(ageSeconds / 10);
    return Math.min(widened, this.settings.band.cap);
  }

  /** The first rule that rejects this candidate, or null. Ordered most-certain first. */
  private reject(
    candidate: Challenge,
    challenger: Challenger,
    band: number,
    recent: ReadonlyMap<string, number>,
    linked: ReadonlyMap<string, CollusionLink>,
    isNew: boolean,
    topDecileFloor: number,
  ): ExclusionReason | null {
    if (this.settings.collusion.blockSameAccount && candidate.creatorAccountId === challenger.accountId) {
      return 'sameAccount';
    }

    const link = linked.get(candidate.creatorAccountId);
    const collusion = link ? exclusionFor(link) : null;
    if (collusion) return collusion;

    if ((recent.get(candidate.creatorAccountId) ?? 0) >= this.settings.recentOpponent.maxMatches) {
      return 'recentOpponent';
    }

    if (isNew && candidate.creatorRating >= topDecileFloor) return 'newPlayerProtection';

    if (Math.abs(candidate.creatorRating - challenger.rating) > band) return 'outsideRatingBand';

    return null;
  }
}

function exclusionFor(link: CollusionLink): ExclusionReason | null {
  switch (link) {
    case 'sameAccount':
      return 'sameAccount';
    case 'sameDevice':
      return 'sameDevice';
    case 'samePaymentInstrument':
      return 'samePaymentInstrument';
    case 'sharedIp':
      return 'sharedIp';
    default:
      return null;
  }
}
