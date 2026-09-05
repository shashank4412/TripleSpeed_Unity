/**
 * Firestore document shapes. Timestamps are stored as Firestore Timestamps;
 * the rating layer works in epoch ms and converts on read.
 */
import type { Timestamp } from 'firebase-admin/firestore';

export type MatchState = 'created' | 'open' | 'answered' | 'settled' | 'expired' | 'rolledBack';
export type MatchRole = 'poster' | 'challenger';

export interface AccountDoc {
  displayName: string;
  deviceFingerprint: string;
  paymentInstrument: string | null;
  lastSeenIp: string | null;
  rating: number;
  ratedMatches: number;
  balanceCents: number;
  createdAt: Timestamp;
}

export interface MatchDoc {
  stakeCents: number;
  state: MatchState;
  posterUid: string;
  challengerUid: string | null;
  seed: string;
  configHash: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  answeredAt: Timestamp | null;
  settledAt: Timestamp | null;
  posterIp: string | null;
  rollbackReason?: string;
  rolledBackAt?: Timestamp;
}

export interface ChallengeDoc {
  stakeCents: number;
  bankedScore: number;
  creatorUid: string;
  creatorRating: number;
  creatorProvisional: boolean;
  createdAt: Timestamp;
  seed: string;
}

export interface SubmissionDoc {
  role: MatchRole;
  inputLog: string;
  clientClaimedScore: number | null;
  serverScore: number;
  outcome: string;
  rejectedInputs: number;
  configHash: string;
  receivedAt: Timestamp;
}

export interface ResultDoc {
  score: number;
  outcome: string;
  /**
   * The opponent's score and outcome, denormalised onto THIS side's own
   * result doc at settlement time. Firestore rules gate `result/{uid}` on
   * `request.auth.uid == uid`, so a client can never read the opponent's own
   * result doc directly — without this the result screen would have no way
   * to show "You 512 / Opponent 480" at all. Written once, at settlement,
   * from data the settlement transaction already holds; it is display data
   * only and never feeds back into money or rating.
   */
  opponentScore: number;
  opponentOutcome: string;
  /** won | lost | draw, from THIS side's perspective. See money.tie in the economy config for the draw rule. */
  result: 'won' | 'lost' | 'draw';
  potCents: number;
  rakeCents: number;
  creditedCents: number;
  netCents: number;
  ratingBefore: number;
  ratingAfter: number;
  ratingDelta: number;
}

export interface TtlDoc {
  matchId: string;
  kind: 'challenge' | 'submission';
  /** Firestore TTL policy watches this field. */
  expireAt: Timestamp;
}
