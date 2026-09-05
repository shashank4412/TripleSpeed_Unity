/**
 * adminConfig — read and publish the Remote Config parameters
 * (`redline_game` / `redline_economy`) from the hosted editor page
 * (`Backend/hosting/`). An operator tool, NOT part of the game.
 *
 * `get` is open to any signed-in caller (the config is not a secret). `publish`
 * can rewrite the live game economy, so:
 *   - it is gated by a passphrase, `RC_ADMIN_KEY`, read from the environment
 *     (`Backend/functions/.env`, gitignored). If it is unset publish is refused;
 *   - every publish is written to `redline_config_audit`;
 *   - it preserves the rest of the Remote Config template (conditions, any
 *     other params) and only swaps the two parameter values — exactly like
 *     `Backend/tools/lib/push-remote-config.mjs`.
 *
 * A passphrase is not real authorization. If this project ever ships for real,
 * delete this handler, its `index.ts` export, and the Hosting site.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { db } from '../shared/firebase.js';
import { requireUid } from '../shared/auth.js';

interface Req {
  action: 'get' | 'publish';
  passphrase: string;
  gameJson?: string;
  economyJson?: string;
}

type Template = Awaited<ReturnType<ReturnType<typeof getRemoteConfig>['getTemplate']>>;

function paramText(tpl: Template, name: string): string {
  const dv = tpl.parameters?.[name]?.defaultValue as { value?: string } | undefined;
  return dv && typeof dv.value === 'string' ? dv.value : '';
}

export const adminConfigFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
    const uid = requireUid(request);
    const d = request.data ?? ({} as Req);

    const rc = getRemoteConfig();
    const tpl = await rc.getTemplate();

    // Reading is open to any signed-in caller: redline_game is already shipped
    // to every client, and redline_economy is not a credential. Writing needs
    // the passphrase.
    if (d.action === 'get') {
      return {
        gameJson: paramText(tpl, 'redline_game'),
        economyJson: paramText(tpl, 'redline_economy'),
        version: tpl.version?.versionNumber ?? null,
      };
    }

    if (d.action !== 'publish') {
      throw new HttpsError('invalid-argument', "action must be 'get' or 'publish'.");
    }

    const key = process.env['RC_ADMIN_KEY'];
    if (!key) {
      throw new HttpsError('failed-precondition', 'adminConfig publish is not configured (RC_ADMIN_KEY unset).');
    }
    if (!d.passphrase || d.passphrase !== key) {
      throw new HttpsError('permission-denied', 'Wrong passphrase.');
    }

    const changed: string[] = [];
    for (const [name, text] of [
      ['redline_game', d.gameJson],
      ['redline_economy', d.economyJson],
    ] as const) {
      if (typeof text !== 'string') continue;
      try {
        JSON.parse(text);
      } catch (e) {
        throw new HttpsError('invalid-argument', `${name} is not valid JSON: ${(e as Error).message}`);
      }
      if (!tpl.parameters[name]) {
        throw new HttpsError('failed-precondition', `Remote Config has no parameter '${name}'.`);
      }
      tpl.parameters[name].defaultValue = { value: text };
      changed.push(name);
    }

    if (changed.length === 0) {
      throw new HttpsError('invalid-argument', 'Nothing to publish — send gameJson and/or economyJson.');
    }

    const validated = await rc.validateTemplate(tpl);
    const published = await rc.publishTemplate(validated);
    const version = published.version?.versionNumber ?? null;

    await db.collection('redline_config_audit').add({
      uid,
      at: Date.now(),
      version,
      changed,
    });

    return { ok: true, version, changed };
  },
);
