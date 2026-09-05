/**
 * preview — the lobby's live payout figure. Computed by the SAME `settle()` the
 * settlement transaction calls, so "the number previewed is the number paid" is
 * true by construction (the one economy figure a client ever sees).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireUid } from '../shared/auth.js';
import { loadConfig } from '../shared/config.js';
import { settle } from '@redline/rating';

export const previewFn = onCall<{ stakeCents: number }>({ region: 'asia-south1' }, async (request) => {
  requireUid(request);
  const { economy } = await loadConfig();
  const stakeCents = request.data?.stakeCents;

  if (!economy.money.stakesCents.includes(stakeCents as number)) {
    throw new HttpsError('invalid-argument', 'Stake is not on the configured ladder.');
  }

  const win = settle(stakeCents!, economy.money.rakeBasisPoints, 'posterWins');
  const tie = settle(stakeCents!, economy.money.rakeBasisPoints, 'tie', economy.money.tieOddCentToPoster);

  return {
    stakeCents,
    potCents: win.potCents,
    rakeCents: win.rakeCents,
    winCents: win.payoutCents,
    tiePosterCents: tie.posterCreditCents,
    tieChallengerCents: tie.challengerCreditCents,
  };
});
