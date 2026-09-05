/**
 * The Game ID a player reads aloud, and the road seed both players run.
 * Ported from src/Redline.Data/GameId.cs.
 */
import { randomInt, randomBytes } from 'node:crypto';

// Crockford base32 minus I, L, O and U: unambiguous when read out, and U is
// dropped so a random code cannot spell something unfortunate.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 10; // 50 bits

/** A fresh Game ID. Cryptographic, so matches cannot be enumerated. */
export function nextGameId(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * A road seed as a decimal string of a 64-bit unsigned value. Real entropy:
 * a predictable seed would let a player scout the road before staking, which is
 * the whole game. Everything downstream of the seed is deterministic.
 */
export function nextSeed(): string {
  return BigInt('0x' + randomBytes(8).toString('hex')).toString();
}
