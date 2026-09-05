/**
 * gameConfig — public, unauthenticated HTTP read of the LIVE `redline_game`
 * Remote Config value and its hash.
 *
 * `redline_game` is already shipped verbatim to every client, so there is
 * nothing secret here. This endpoint exists so the Editor loopback backend
 * (`EditorLoopbackBackend`) — which cannot use the Firebase Remote Config SDK,
 * because its async calls never complete in the macOS Editor — can still pick
 * up config changes made from the hosting page. `redline_economy` is
 * server-only and is never returned here.
 *
 * No cache: it reads the template directly so a publish from the editor page
 * shows up on the next request.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { parseGameConfig } from '@redline/sim-core';
import { readFileSync } from 'node:fs';

function fallbackGameText(): string {
  return readFileSync(new URL('../../config/redline.game.json', import.meta.url), 'utf8');
}

export const gameConfigFn = onRequest({ region: 'asia-south1', cors: true }, async (_req, res) => {
  let gameJson: string;
  try {
    const tpl = await getRemoteConfig().getTemplate();
    const dv = tpl.parameters['redline_game']?.defaultValue as { value?: string } | undefined;
    gameJson = dv && typeof dv.value === 'string' ? dv.value : fallbackGameText();
  } catch {
    gameJson = fallbackGameText();
  }

  const { configHash } = parseGameConfig(gameJson);
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ gameJson, configHash });
});
