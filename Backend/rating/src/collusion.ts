/**
 * What the server is willing to believe makes two accounts the same person.
 * Ported from Collusion.cs.
 *
 * Every value comes from `matchmaking.collusion` in the economy config -- a
 * reviewer will turn one of these off on a screen share and re-run.
 *
 * Both consumers need it and only one has a database: joinMatch applies it
 * directly, and the matchmaker applies it through IChallengeInventory --
 * including inside the proof, which has no server at all.
 */
export interface CollusionPolicy {
  /** Refuse a player answering their own challenge. */
  readonly blockSameAccount: boolean;
  /** Refuse two accounts that have ever shared a device fingerprint. */
  readonly blockSameDevice: boolean;
  /** Refuse two accounts funded by the same instrument. */
  readonly blockSamePaymentInstrument: boolean;
  /** Refuse two accounts seen at one address within this many minutes. Zero disables. */
  readonly sharedIpWindowMinutes: number;
}

/** Why two accounts are believed to be one person. `none` means they are not. */
export type CollusionLink = 'none' | 'sameAccount' | 'sameDevice' | 'samePaymentInstrument' | 'sharedIp';
