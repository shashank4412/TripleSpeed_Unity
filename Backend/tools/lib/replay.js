/**
 * Tools/Replay <gameId> — fetch the stored run from Firestore, re-simulate it
 * from the seed the server issued, and print the score and outcome. This is how
 * a "you robbed me" dispute is answered. Ported from ReplayCommand.cs.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=Backend/.secrets/<key>.json \
 *   npm --workspace @redline/tools run replay -- <gameId>
 */
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { parseGameConfig, runSimulation, parseInputLog } from '@redline/sim-core';
const gameId = process.argv[2];
if (!gameId) {
    console.error('usage: replay <gameId>');
    process.exit(2);
}
if (getApps().length === 0)
    initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const matchSnap = await db.collection('redline_matches').doc(gameId).get();
if (!matchSnap.exists) {
    console.error(`no match ${gameId}`);
    process.exit(1);
}
const match = matchSnap.data();
// Score under the rules the match was stamped with. If live RC has moved on,
// say so rather than silently replaying under different rules.
const template = await getRemoteConfig().getTemplate();
const gameParam = template.parameters['redline_game']?.defaultValue;
const gameText = gameParam && 'value' in gameParam ? gameParam.value : '';
const { config, configHash } = parseGameConfig(gameText);
if (configHash !== match.configHash) {
    console.warn(`WARNING: live config ${configHash} != match config ${match.configHash}; replaying under live rules`);
}
const subs = await db.collection('redline_matches').doc(gameId).collection('submissions').get();
for (const doc of subs.docs) {
    const s = doc.data();
    const events = parseInputLog(s.inputLog);
    const r = runSimulation(config, { seed: match.seed, events, maxRunTicks: config.maxRunTicks });
    const agree = r.score === s.serverScore && r.outcome.toLowerCase() === s.outcome.toLowerCase();
    console.log(`${s.role.padEnd(10)} stored ${s.serverScore}/${s.outcome}  replay ${r.score}/${r.outcome}  ${agree ? 'MATCH' : 'MISMATCH'}`);
}
//# sourceMappingURL=replay.js.map