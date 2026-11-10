# Engineering practices

These rules apply to every change. Most are enforced by `npm run check`, which runs lint, unit tests and the secret scan. The rest are checked at the review gate (§9). If a rule and the code disagree, the code is the bug.

## 1. Principles
1. **PayPal is the source of truth.** Local state is a cache that can be rebuilt (ARCHITECTURE §3).
2. **Nothing reaches PayPal without a person's click.** The AI recommends; the seller decides.
3. **Fail loud on the server, fail safe for the user.** Log the details server-side and show the user a calm, generic message.
4. **The simplest thing that is correct.** No speculative abstractions. Three similar lines beat a premature helper.

## 2. Code style
- Node 22 ESM, plain JavaScript, no TypeScript build step. JSDoc goes on exported functions whose contract isn't obvious.
- Use named exports. The exceptions are React components and Vite config.
- Modules stay small and single-purpose, and they respect the layer rules in ARCHITECTURE §4 (dependencies point down; only the integration layer does network I/O; only `db.js` runs SQL on the local cache; only `mirror.js` talks to Turso).
- Comments explain **why**, never what. Remove dead code; don't comment it out.
- Leave no unused variables or imports (eslint `no-unused-vars`).
- Server code logs only through `server/log.js`, which lint enforces with `no-console`. Use `log.info/warn/error(scope, msg, err)`.

## 3. Errors
- Never use an empty `catch`. Every catch either handles a **specific** case, such as `if (e.status !== 404) throw e`, or adds context and rethrows. `catch { /* reason */ }` is allowed only with a comment explaining why ignoring is correct.
- PayPal failures are `PayPalError` with `status`, `issue` and `debugId`. Map them deliberately in routes, and never forward the raw message to the client.
- API error shape: `{ error: string }`. 4xx messages are written for the user. 5xx messages are generic, and the 502 for PayPal carries only `debugId`.
- A transient failure must never cause a permanent state change, such as retiring a dispute or burning a cooldown.

## 4. External calls
- Every `fetch` has a timeout (`AbortSignal.timeout`): PayPal 25 s, OpenAI 30 s, token 15 s.
- Retries: GETs and calls explicitly marked `idempotent` (order creation with `PayPal-Request-Id`) only, with exponential backoff that honours `Retry-After`. **Dispute actions are never retried automatically.**
- Before any dispute action, re-GET the dispute and act only on a link PayPal currently offers.
- Keep the evidence payload within PayPal's limits: notes ≤2000 characters, `carrier_name` from PayPal's enum, `evidence_type` valid for the reason.

## 5. Security and secrets (no leaks)
- Secrets live only in environment variables. `.env` is git-ignored, and `.env.example` documents every variable without values.
- Never log secrets, tokens, cookies, passcodes or full request headers. Log PayPal `debug_id`, not response bodies containing personal data.
- Never send secrets to the browser. `npm test` scans `web/dist` for every secret-looking env value and for `PAYPAL_`/`OPENAI_` key patterns, and fails the build on a match.
- Every state-changing route uses `requireAuth`. GET routes have no side effects.
- Cookies are `HttpOnly; SameSite=Lax; Secure` (in prod), HMAC-signed, with a 12 h TTL. Passcode comparison is constant-time on hashes.
- Input: route params go only to `db.js` prepared statements (never string-built SQL). Body size is capped at 1 MB.
- Output: React text rendering only. `dangerouslySetInnerHTML`, `eval` and `new Function` are banned by lint.
- Security headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, and no `x-powered-by`.

## 6. Resource hygiene (no leaks)
- Every long-lived timer has an owner that clears it: React effects return cleanup, and the server clears the sync interval on SIGTERM.
- Awaited sleeps are bounded: retry waits are capped at 10 s, and refill pauses end early on shutdown via `stopRefill()`.
- Every in-memory map is bounded, for example the login limiter resets itself above 5,000 keys.
- Single-flight guards:
  - sync: `running` flag;
  - refill: an atomic SQLite lock with a TTL, shared across processes;
  - reset: synchronous check-and-set of a persisted cooldown;
  - submission (M2): a UNIQUE row.
- Graceful shutdown: SIGTERM stops the timers, drains HTTP and closes SQLite, with a 10 s hard exit.
- React effects never set state after unmount (`alive` flag or AbortController).

## 7. AI rules (M2 onward)
- Structured output against a JSON schema only, validated on receipt. Treat a parse failure like a timeout and fall back to manual review.
- Prompts have explicit TRUSTED and UNTRUSTED sections. Buyer text never goes in the system prompt.
- `ai/guard.js` must pass before the Approve button enables, and the reasons for any failure are shown to the seller.
- Win probability is shown as a low/med/high band with reasons. Never show a bare number as a promise.
- Every AI call is recorded with model, token usage, latency and outcome, and without the prompt contents.

## 8. Testing
| Suite | Location | Runs in `npm test` | Purpose |
|---|---|---|---|
| Unit | `tests/unit/*.test.js` (`node:test`) | yes | Logic and contracts: view, pool and sync placement, auth, the PayPal client retry policy (fake PayPal), routes error mapping (in-process server), util; guard and EV in M2. Uses a temp SQLite DB, and **external network calls throw**. |
| Secret scan | `tests/unit/secret-scan.test.js` | yes | `.env` is git-ignored. No `.env` secret value or key-shaped string appears in any committable file (`git ls-files --cached --others --exclude-standard`) or in `web/dist`. |
| Smoke | `scripts/smoke.mjs` (`npm run smoke`) | no (needs a running server) | The app shell is served, 404s are correct, auth is required on writes, security headers are present. |
| Edge / adversarial | `tests/edge/*.mjs` | no (needs the sandbox + a running server) | Written by the edge-case tester: auth abuse, injection, odd disputes, API quirks. |
| Sandbox probes | `scripts/*.mjs` | no | Prove PayPal behaviour before code depends on it. |

- Every bug fix comes with a test that fails without the fix.
- Every new branch in the pool, sync or guard logic gets a unit test.
- Tests never call the live sandbox. Sandbox behaviour is recorded in fixtures or probes.

## 9. Review gate (per milestone)
A milestone is done when all of these hold:
1. `npm run check` is green: lint, unit tests and the secret scan.
2. The **reviewer** agent has reviewed the diff against this file and ARCHITECTURE.md, and every blocker and major finding is fixed or explicitly deferred in ARCHITECTURE §11.
3. The **edge-case tester** agent has run `tests/edge/` against a live server, and the failures are fixed or recorded.
4. Any disagreement between the two goes through one debate round (the conference room). Facts get settled by a sandbox probe, not by argument.
5. ARCHITECTURE.md is updated if a boundary, flow, invariant or decision changed.
6. The planner has checked the UI in a real browser (screenshots) with no console errors.

## 10. Git and commits
- Small commits with an imperative subject (`Fix pool top-up after DB wipe`), and a body explaining why.
- Never commit `.env`, `data/`, `web/dist/`, logs or probe output (see `.gitignore`).
- The license file is at the repo root (MIT), as the hackathon rules require.
