/**
 * Minimal HTTP client for the Firebase emulator suite, shared by
 * Tools/Preflight and Tools/Rehearse: anonymous sign-in and callable
 * invocation over the callable wire protocol (POST {"data": ...}, read back
 * {"result": ...} / {"error": ...}), plus a liveness probe for an emulator
 * port. No firebase-admin, no client SDK — Node 20's built-in fetch is enough,
 * and it keeps both tools honest about exercising the real HTTP boundary
 * rather than a mock (the same reason functions/test/ensureAccount.test.ts
 * does it this way).
 *
 * T-002 (DevDocs/features/0002-submission-readiness/prompts/T-002-emulator-smoke.md)
 * was written to ship exactly this kind of "smoke helper" for later tasks to
 * import. It had not landed when T-203 repaired these two wrappers, so this
 * file is new rather than a duplicate of something that exists. If T-002
 * lands later, point it at this module (or fold this into whatever T-002
 * ships) rather than keeping two copies — see CLAUDE.md's rule on the sim
 * core and the rating/matchmaking assemblies: two copies of the same logic
 * drift, and the drift is the bug.
 */
export const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
export const FUNCTIONS_HOST = process.env['REDLINE_FUNCTIONS_EMULATOR_HOST'] ?? '127.0.0.1:5001';
export const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
export const PROJECT = process.env['GCLOUD_PROJECT'] ?? process.env['FIREBASE_PROJECT_ID'] ?? 'attendance-91bdd';
export const REGION = 'asia-south1';
/** Is anything answering on this host:port? Connection-refused -> false, not a throw. */
export async function reachable(hostPort) {
    try {
        await fetch(`http://${hostPort}/`);
        return true;
    }
    catch {
        return false;
    }
}
/** A brand-new anonymous user, exactly as a fresh install mints one. */
export async function signInAnonymously(authHost = AUTH_HOST) {
    const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!res.ok)
        throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
    const body = (await res.json());
    return { idToken: body.idToken, uid: body.localId };
}
/** A callable's own refusal (HttpsError) — distinct from a network or protocol failure. */
export class CallableError extends Error {
    httpStatus;
    code;
    constructor(httpStatus, code) {
        super(`callable error ${code} (http ${httpStatus})`);
        this.httpStatus = httpStatus;
        this.code = code;
    }
}
/**
 * Invoke a callable over its wire protocol. This is what the Firebase client
 * SDKs send under the hood — going straight to HTTP means no client SDK
 * dependency, and it asserts against the exact bytes a device would send
 * rather than an in-process mock of the handler.
 */
export async function callCallable(name, idToken, data, target = {}) {
    const host = target.functionsHost ?? FUNCTIONS_HOST;
    const project = target.project ?? PROJECT;
    const region = target.region ?? REGION;
    const res = await fetch(`http://${host}/${project}/${region}/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ data }),
    });
    const text = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(`${name}: non-JSON response (http ${res.status}): ${text.slice(0, 300)}`);
    }
    if (parsed.error)
        throw new CallableError(res.status, parsed.error.status);
    if (!res.ok)
        throw new Error(`${name}: http ${res.status} with no error body: ${text.slice(0, 300)}`);
    return parsed.result ?? {};
}
/** A fresh idempotency key per call — every mutating callable requires one. */
export function newIdempotencyKey(label) {
    return `rehearse-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
//# sourceMappingURL=emulator.js.map