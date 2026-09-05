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
export declare const AUTH_HOST: string;
export declare const FUNCTIONS_HOST: string;
export declare const FIRESTORE_HOST: string;
export declare const PROJECT: string;
export declare const REGION = "asia-south1";
/** Is anything answering on this host:port? Connection-refused -> false, not a throw. */
export declare function reachable(hostPort: string): Promise<boolean>;
/** A brand-new anonymous user, exactly as a fresh install mints one. */
export declare function signInAnonymously(authHost?: string): Promise<{
    idToken: string;
    uid: string;
}>;
/** A callable's own refusal (HttpsError) — distinct from a network or protocol failure. */
export declare class CallableError extends Error {
    readonly httpStatus: number;
    readonly code: string;
    constructor(httpStatus: number, code: string);
}
export interface CallableTarget {
    functionsHost?: string;
    project?: string;
    region?: string;
}
/**
 * Invoke a callable over its wire protocol. This is what the Firebase client
 * SDKs send under the hood — going straight to HTTP means no client SDK
 * dependency, and it asserts against the exact bytes a device would send
 * rather than an in-process mock of the handler.
 */
export declare function callCallable(name: string, idToken: string | null, data: Record<string, unknown>, target?: CallableTarget): Promise<Record<string, unknown>>;
/** A fresh idempotency key per call — every mutating callable requires one. */
export declare function newIdempotencyKey(label: string): string;
//# sourceMappingURL=emulator.d.ts.map