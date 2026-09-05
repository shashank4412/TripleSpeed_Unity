/**
 * The questions the matchmaker asks about the world, and the in-memory answer
 * to them. Ported from IChallengeInventory.cs + InMemoryChallengeInventory.cs.
 *
 * Four narrow queries, never a repository that hands back an aggregate: EVERY
 * decision is made in Matchmaker, and this only answers facts. That is what lets
 * the Firestore and in-memory implementations be swapped without changing a
 * single matchmaking outcome — which is the Liskov claim the 50,000-match proof
 * rests on. Account ids are Firebase uids (strings); time is epoch milliseconds.
 */
import type { CollusionPolicy, CollusionLink } from './collusion.js';

/** One posted challenge, as the matchmaker sees it. */
export interface Challenge {
  /** The Game ID. Also the stable tiebreak that makes ranking deterministic. */
  readonly matchId: string;
  readonly stakeCents: number;
  /** What the creator banked. The number a challenger must beat. */
  readonly bankedScore: number;
  readonly creatorAccountId: string;
  readonly creatorRating: number;
  readonly creatorProvisional: boolean;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Decimal string of the 64-bit seed. */
  readonly seed: string;
}

/** A player arriving to answer a challenge. */
export interface Challenger {
  readonly accountId: string;
  readonly rating: number;
  readonly settledMatches: number;
  readonly stakeCents: number;
}

export interface IChallengeInventory {
  /** Every open challenge at exactly this stake, oldest first then by match id. Total order is part of the contract. */
  openAtStake(stakeCents: number): Promise<readonly Challenge[]>;
  /** How many times this account has faced each opponent since `sinceMs`. Absent means zero. */
  recentOpponentCounts(accountId: string, sinceMs: number): Promise<ReadonlyMap<string, number>>;
  /** Accounts believed to be the same person as this one, and why. */
  linkedAccounts(accountId: string, policy: CollusionPolicy, nowMs: number): Promise<ReadonlyMap<string, CollusionLink>>;
  /** The rating at the 90th percentile of the live population — the floor of the top decile. */
  topDecileRating(): Promise<number>;
}

/** Postgres' percentile_disc(0.9) index: first value whose cumulative share reaches the fraction. */
export function discretePercentileIndex(count: number, fraction: number): number {
  return Math.min(Math.max(Math.ceil(fraction * count) - 1, 0), count - 1);
}

/**
 * The inventory the proof runs on. Lives beside the interface, not inside the
 * proof, so a divergence from the Firestore implementation is obvious.
 */
export class InMemoryChallengeInventory implements IChallengeInventory {
  private readonly open = new Map<string, Challenge>();
  private readonly meetings = new Map<string, Array<{ opponent: string; at: number }>>();
  private readonly devices = new Map<string, string>();
  private readonly instruments = new Map<string, string | null>();
  private readonly sightings = new Map<string, Array<{ ip: string; at: number }>>();
  private readonly ratings = new Map<string, number>();
  private readonly byIp = new Map<string, Array<{ account: string; at: number }>>();
  private readonly openByStake = new Map<number, Set<string>>();

  post(challenge: Challenge): void {
    this.open.set(challenge.matchId, challenge);
    let atStake = this.openByStake.get(challenge.stakeCents);
    if (!atStake) this.openByStake.set(challenge.stakeCents, (atStake = new Set()));
    atStake.add(challenge.matchId);
  }

  take(matchId: string): void {
    const challenge = this.open.get(matchId);
    if (!challenge) return;
    this.open.delete(matchId);
    this.openByStake.get(challenge.stakeCents)?.delete(matchId);
  }

  get openChallenges(): readonly Challenge[] {
    return [...this.open.values()];
  }

  tryGetCreator(matchId: string): string | null {
    return this.open.get(matchId)?.creatorAccountId ?? null;
  }

  recordMeeting(a: string, b: string, atMs: number): void {
    this.meetingsOf(a).push({ opponent: b, at: atMs });
    this.meetingsOf(b).push({ opponent: a, at: atMs });
  }

  register(accountId: string, deviceFingerprint: string, paymentInstrument: string | null = null, rating = 1200): void {
    this.devices.set(accountId, deviceFingerprint);
    this.instruments.set(accountId, paymentInstrument);
    this.ratings.set(accountId, rating);
  }

  setRating(accountId: string, rating: number): void {
    this.ratings.set(accountId, rating);
  }

  recordIp(accountId: string, ip: string, atMs: number): void {
    let mine = this.sightings.get(accountId);
    if (!mine) this.sightings.set(accountId, (mine = []));
    mine.push({ ip, at: atMs });

    let atAddress = this.byIp.get(ip);
    if (!atAddress) this.byIp.set(ip, (atAddress = []));
    atAddress.push({ account: accountId, at: atMs });
  }

  openAtStake(stakeCents: number): Promise<readonly Challenge[]> {
    const atStake = this.openByStake.get(stakeCents);
    if (!atStake) return Promise.resolve([]);
    const list = [...atStake]
      .map((id) => this.open.get(id)!)
      .sort((a, b) => a.createdAt - b.createdAt || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0));
    return Promise.resolve(list);
  }

  recentOpponentCounts(accountId: string, sinceMs: number): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const { opponent, at } of this.meetingsOf(accountId)) {
      if (at < sinceMs) continue;
      counts.set(opponent, (counts.get(opponent) ?? 0) + 1);
    }
    return Promise.resolve(counts);
  }

  linkedAccounts(accountId: string, policy: CollusionPolicy, _nowMs: number): Promise<ReadonlyMap<string, CollusionLink>> {
    const links = new Map<string, CollusionLink>();
    // Weakest first, so a stronger signal overwrites it.
    if (policy.sharedIpWindowMinutes > 0) this.addSharedIp(accountId, policy, links);
    if (policy.blockSamePaymentInstrument) this.addSameInstrument(accountId, links);
    if (policy.blockSameDevice) this.addSameDevice(accountId, links);
    links.delete(accountId);
    return Promise.resolve(links);
  }

  topDecileRating(): Promise<number> {
    if (this.ratings.size === 0) return Promise.resolve(Number.MAX_SAFE_INTEGER);
    const sorted = [...this.ratings.values()].sort((a, b) => a - b);
    return Promise.resolve(sorted[discretePercentileIndex(sorted.length, 0.9)]!);
  }

  private addSharedIp(accountId: string, policy: CollusionPolicy, links: Map<string, CollusionLink>): void {
    const windowMs = policy.sharedIpWindowMinutes * 60_000;
    for (const { ip, at: mine } of this.sightings.get(accountId) ?? []) {
      for (const { account: other, at: theirs } of this.byIp.get(ip) ?? []) {
        if (other === accountId) continue;
        if (Math.abs(mine - theirs) <= windowMs) links.set(other, 'sharedIp');
      }
    }
  }

  private addSameInstrument(accountId: string, links: Map<string, CollusionLink>): void {
    const mine = this.instruments.get(accountId);
    if (mine == null) return; // null never matches null
    for (const [other, theirs] of this.instruments) {
      if (other !== accountId && theirs === mine) links.set(other, 'samePaymentInstrument');
    }
  }

  private addSameDevice(accountId: string, links: Map<string, CollusionLink>): void {
    const mine = this.devices.get(accountId);
    if (mine == null) return;
    for (const [other, theirs] of this.devices) {
      if (other !== accountId && theirs === mine) links.set(other, 'sameDevice');
    }
  }

  private meetingsOf(accountId: string): Array<{ opponent: string; at: number }> {
    let list = this.meetings.get(accountId);
    if (!list) this.meetings.set(accountId, (list = []));
    return list;
  }
}
