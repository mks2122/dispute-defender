// The only module allowed to write to the console (lint-enforced).
// Rule (ENGINEERING-PRACTICES §5): never log secrets, tokens, cookies or PayPal response bodies.
// PayPal errors are logged as status + issue + debug_id only.

const fmt = (scope, msg) => `[${scope}] ${msg}`;

/** Safe one-line description of any error, for logs. Never includes response bodies. */
export function describeError(err) {
  if (err?.name === "PayPalError") return `PayPal ${err.status}${err.issue ? ` ${err.issue}` : ""}${err.debugId ? ` debug_id=${err.debugId}` : ""} (${err.endpoint})`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "request timed out";
  return err?.message ?? String(err);
}

export const log = {
  info: (scope, msg) => console.log(fmt(scope, msg)),
  warn: (scope, msg) => console.warn(fmt(scope, msg)),
  /** Logs a safe description; the stack only for non-PayPal (i.e. our own) errors. */
  error: (scope, msg, err) => {
    if (!err) return console.error(fmt(scope, msg));
    const safe = describeError(err);
    console.error(fmt(scope, `${msg}: ${safe}`));
    if (err?.name !== "PayPalError" && err?.stack) console.error(err.stack);
  },
};
