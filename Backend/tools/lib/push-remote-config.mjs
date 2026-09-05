/**
 * Publishes Backend/config/redline.game.json and Backend/config/redline.economy.json to Remote
 * Config as the redline_game / redline_economy JSON parameters, scoped to the
 * game app by a condition. Also rewrites Backend/remoteconfig.template.json so
 * the committed template matches what is live.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=Backend/.secrets/<key>.json \
 *   node Backend/tools/lib/push-remote-config.mjs [--write] [--publish]
 *
 * --write   : only regenerate the local template file
 * --publish : actually publish to the project (otherwise dry-run/validate)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getRemoteConfig } from 'firebase-admin/remote-config';

const root = new URL('../../../', import.meta.url);
const gameText = readFileSync(new URL('Backend/config/redline.game.json', root), 'utf8');
const economyText = readFileSync(new URL('Backend/config/redline.economy.json', root), 'utf8');

const template = {
  conditions: [
    {
      name: 'redline_android',
      expression: "app.id == '1:623191754889:android:123c4e45c137c6b6441e58'",
      tagColor: 'BLUE',
    },
  ],
  parameters: {
    redline_game: {
      defaultValue: { value: gameText },
      description: 'Game rules. Byte-identical to Backend/config/redline.game.json; hashed and stamped on every match.',
      valueType: 'JSON',
    },
    redline_economy: {
      defaultValue: { value: economyText },
      description: 'Money/rating/matchmaking. Byte-identical to Backend/config/redline.economy.json. Server-only.',
      valueType: 'JSON',
    },
  },
  parameterGroups: {},
  version: { description: 'redline config push' },
};

const outPath = fileURLToPath(new URL('Backend/remoteconfig.template.json', root));
writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
console.log(`wrote ${outPath}`);

if (process.argv.includes('--write')) process.exit(0);

if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
const rc = getRemoteConfig();
const live = await rc.getTemplate();
live.conditions = template.conditions;
live.parameters['redline_game'] = template.parameters.redline_game;
live.parameters['redline_economy'] = template.parameters.redline_economy;

const validated = await rc.validateTemplate(live);
console.log('template validated OK');

if (process.argv.includes('--publish')) {
  const published = await rc.publishTemplate(validated);
  console.log(`published version ${published.version?.versionNumber}`);
} else {
  console.log('dry run — pass --publish to publish');
}
