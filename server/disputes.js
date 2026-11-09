// Pure predicates over PayPal dispute JSON (data layer: no imports, no I/O).
// Single definitions, used by seed, sync, pool and view.

export const STUCK_AFTER_MS = 15 * 60_000;

export const isResolved = (d) => d?.status === "RESOLVED" || !!d?.dispute_outcome;
export const isActionable = (d) => d?.status === "WAITING_FOR_SELLER_RESPONSE";
export const sellerHasActed = (d) => (d?.evidences ?? []).some((e) => e.source === "SUBMITTED_BY_SELLER");
export const ageMs = (d, fallbackIso) => Date.now() - new Date(d?.create_time ?? fallbackIso ?? Date.now()).getTime();

/** Still on its way to WAITING (OPEN or UNDER_REVIEW, untouched, younger than the stuck window). */
export const isProcessing = (d, fallbackIso) =>
  ["OPEN", "UNDER_REVIEW"].includes(d?.status) && !sellerHasActed(d) && !isResolved(d) && ageMs(d, fallbackIso) < STUCK_AFTER_MS;

/** A pool dispute that will never be handed out: resolved, already acted on, or stuck past the window. */
export const isDeadInPool = (d, fallbackIso) => isResolved(d) || sellerHasActed(d) || (!isActionable(d) && !isProcessing(d, fallbackIso));
