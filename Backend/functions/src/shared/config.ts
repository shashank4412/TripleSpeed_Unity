/**
 * The rules the server scores with. Remote Config is the source of truth
 * (params redline_game and redline_economy); the JSON copied into
 * Backend/functions/config/ is the fallback when RC cannot be reached, and is
 * kept byte-identical to Backend/config/redline.game.json at the repo root.
 *
 * redline_game is hashed and stamped on every match. redline_economy is
 * server-only and never returned to a client except as a payout preview.
 *
 * Cached for CONFIG_TTL_MS so a hot function does not fetch RC on every call.
 * A game-rules change therefore takes up to that long to reach the server —
 * acceptable because the client's config hash is checked on submit, so a
 * mid-change submission is rejected, not misscored.
 */
import { readFileSync } from 'node:fs';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { parseGameConfig } from '@redline/sim-core';
import type { GameConfig } from '@redline/sim-core';
import { parseEconomyConfig } from '@redline/rating';
import type { EconomyConfig } from '@redline/rating';

const CONFIG_TTL_MS = 60_000;

interface Loaded {
  gameText: string;
  gameConfig: GameConfig;
  configHash: string;
  economy: EconomyConfig;
  loadedAtMs: number;
}

let cache: Loaded | null = null;

function fallbackText(name: 'redline.game.json' | 'redline.economy.json'): string {
  return readFileSync(new URL(`../../config/${name}`, import.meta.url), 'utf8');
}

async function fetchFromRemoteConfig(): Promise<{ gameText: string; economyText: string } | null> {
  try {
    const template = await getRemoteConfig().getTemplate();
    const game = template.parameters['redline_game']?.defaultValue;
    const economy = template.parameters['redline_economy']?.defaultValue;
    const gameText = game && 'value' in game ? game.value : undefined;
    const economyText = economy && 'value' in economy ? economy.value : undefined;
    if (typeof gameText === 'string' && typeof economyText === 'string') return { gameText, economyText };
    return null;
  } catch {
    return null;
  }
}

async function load(nowMs: number): Promise<Loaded> {
  if (cache && nowMs - cache.loadedAtMs < CONFIG_TTL_MS) return cache;

  const fromRc = await fetchFromRemoteConfig();
  const gameText = fromRc?.gameText ?? fallbackText('redline.game.json');
  const economyText = fromRc?.economyText ?? fallbackText('redline.economy.json');

  const { config: gameConfig, configHash } = parseGameConfig(gameText);
  const economy = parseEconomyConfig(economyText);

  cache = { gameText, gameConfig, configHash, economy, loadedAtMs: nowMs };
  return cache;
}

export async function loadConfig(nowMs = Date.now()): Promise<Loaded> {
  return load(nowMs);
}
