export {};
/**
 * WHY THERE IS NO --project live HERE
 *
 * A genuine live-readiness check ("is the deployed project ready") needs to:
 * confirm the last `firebase deploy --only firestore:rules,firestore:indexes`
 * actually landed (the Admin SDK has no "list deployed rules" call; it needs
 * either the Firebase Management API or shelling out to `firebase
 * firestore:indexes` and parsing its output), and reach each gen2 function's
 * actual Cloud Run URL, which is not a predictable path the way gen1's
 * `https://<region>-<project>.cloudfunctions.net/<name>` was — it has to be
 * discovered per function, normally via `firebase functions:list` or the
 * console, after a deploy. Building that discovery is real, separate work,
 * not a read-only local check, and this task's constraints rule out deploying
 * anything to find out. `Tools/Rehearse --url <base>` has the same gap for the
 * same reason — see its header comment.
 */
//# sourceMappingURL=preflight.d.ts.map