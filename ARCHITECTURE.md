# Architecture: Dispute Defender

Status: milestone 1 is implemented. Sections marked **(M2)** or **(M3)** are designed and not yet built.
Owner: planner. Changes to boundaries or invariants in this document need a reviewer pass.

## 1. What the system does
A seller-side agent for PayPal disputes. It does five things:
1. Pulls the merchant's disputes from the PayPal Disputes API.
2. Joins each dispute to the seller's own records: listing, order, shipment, messages, AI-agent mandates.
3. Asks an LLM (OpenAI GPT-5.6 Luna) for a structured, cited assessment **(M2)**.
4. Checks the model's draft against those records **(M2)**.
5. Submits evidence or accepts the claim through PayPal, **but only after the seller approves (M2).**

## 2. Context
```
                ┌──────────────────────────── Dispute Defender (one Node process) ───────────────────────────┐
 Seller ──HTTPS─▶ web (React + AG Grid, static) ──/api──▶ routes ─┬─▶ view ───────┐                          │
 (browser)      │                                                  ├─▶ pool ───────┤                          │
                │                                                  ├─▶ ai/* (M2) ──┼─▶ OpenAI API (Luna)      │
                │                                                  └─▶ submit (M2) ┤                          │
                │                 sync loop (30s) ─────────────────────────────────┼─▶ paypal/client ─▶ PayPal REST (sandbox)
                │                 seed / refill ───────────────────────────────────┘        ▲                │
                │                                                   db (SQLite cache) ◀─────┘ store/catalog  │
                └────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Sources of truth
| Data | Source of truth | Local copy |
|---|---|---|
| Dispute state, allowed actions, deadline, buyer claim | **PayPal** (`GET /v1/customer/disputes/{id}`) | `disputes.raw` (a cache, refreshed every 30 s) |
| Dispute → scenario link | **PayPal**: the order's `custom_id = dd:<scenario>` on the capture | `disputes.scenario` (a cache) |
| Seller records (listing, order, shipment, messages, mandates) | **`server/store/catalog.js`** (committed) | — |
| Which disputes the inbox shows (batch / pool / retired) | Local `disputes.batch` | Can be rebuilt from PayPal (§6) |
| What the seller approved and submitted | Local `submissions` (UNIQUE per dispute) plus PayPal `evidences[]` | — |
| AI analyses and drafts **(M2)** | Local `analyses` | Can be regenerated |

**Invariant:** losing the SQLite file loses nothing that matters. On a fresh boot, sync rebuilds the pool and the inbox from PayPal plus the catalog. Render keeps the DB in `/tmp` on purpose.

## 4. Components and boundaries
Server modules form layers, and **dependencies only point downward**:

| Layer | Modules | May import | Responsibility |
|---|---|---|---|
| HTTP | `index.js`, `routes.js`, `auth.js` | everything below | Routing, auth, error shape, security headers, shutdown |
| Application | `pool.js`, `sync.js`, `view.js`, `ai/*` (M2), `submit.js` (M2) | integration and data layers | Batch, pool and reset rules, sync state machine, view models, AI orchestration, the approval gate |
| Integration | `paypal/client.js`, `paypal/seed.js`, `ai/openai.js` (M2) | data layer | All network I/O to PayPal and OpenAI (timeouts, retries, error types), plus sandbox seeding |
| Data | `db.js`, `disputes.js` (pure predicates), `util.js`, `log.js`, `config.js`, `store/catalog.js` | nothing above | Persistence, locks, shared predicates, logging, configuration, static seller data |

Rules, with the check that enforces each:
- **Only the integration layer makes network calls.** Lint bans `fetch` everywhere in `server/` except `server/paypal/**` and `server/ai/**`. Only `paypal/client.js` calls PayPal.
- **Only `db.js` runs SQL.** Lint bans importing `node:sqlite` elsewhere. The raw handle is exported only as `__testDb`, and lint bans that import in server code.
- **Only `log.js` writes to the console**, enforced by `no-console`. It logs PayPal errors as status, issue and debug_id only, never response bodies.
- **The web app talks only to `/api`.** It never sees PayPal or OpenAI credentials, and `npm test` scans the build and every committable file for secrets.
- **Routes stay thin.** They validate input, call one application function, and shape the response. Business rules such as the reset cooldown live in `pool.js`.

## 5. Key flows

### 5.1 Seeding (sandbox demo data)
`seed.js` → `createCardSale` (order + capture with `custom_id`) → `createChargeback` (`process-chargeback`, with the buyer note in `processor_info.notes`) → a placeholder row in `pool` → `waitUntilActionable` (GET by id every 20 s, 15-minute timeout).
- Chargeback reason depends on **code + card brand** (verified):

  | Code | Card brand | Resulting reason |
  |---|---|---|
  | 1330 | Visa | NOT_AS_DESCRIBED |
  | 4853 | Mastercard | NOT_AS_DESCRIBED |
  | 4837 | Mastercard | UNAUTHORISED |
  | 4855 | Mastercard | NOT_RECEIVED |
  | 13.1 | Visa | NOT_RECEIVED |

  4837 with Visa and 10.4 both become OTHER, which never becomes actionable.
- Single-flight across processes, using an **atomic SQLite lock** (`locks` table; conditional upsert, 20-minute TTL, released in `finally`).
- An hourly cap (`MAX_SEEDS_PER_HOUR`) counts **attempts**, not successes, because a failed chargeback has already created a real sale.
- Seeding refuses to run unless `PAYPAL_BASE` is the sandbox host.
- On shutdown, `stopRefill()` ends any in-progress refill at its next step.

### 5.2 Sync loop (every 30 s, non-overlapping)
1. List all disputes (paginated). For each unknown id: GET it, then GET its capture and read `custom_id`, then classify it (§6).
   - **Only a 404 on the capture means "not ours".** Any other error skips the dispute until the next tick.
2. Refresh every non-resolved dispute in the pool and the active batch, using GET by id with concurrency 4.
   - Every per-dispute failure is logged.
   - The UI receives only a generic count ("2 of 9 PayPal refresh call(s) failed"), never PayPal's text.
3. `retireDeadPoolRows`: pool disputes that are resolved, already acted on, or stuck for more than 15 minutes are retired, so sync stops polling them.
4. `topUpBatch`: any scenario missing from the inbox gets a fresh pool dispute.
5. `ensureRefill`: if the pool is short, start a guarded background refill.

### 5.3 Inbox and case view
`GET /api/disputes` returns the rows of the active batch through `view.toRow`. A corrupt row is skipped and logged; the request does not fail. `GET /api/disputes/:id` returns `view.toCase`, which carries:
- the buyer claims, taken from PayPal `evidences[source=SUBMITTED_BY_BUYER]` and marked untrusted;
- the seller records;
- the live PayPal links;
- the evidence types PayPal requested;
- the audit trail.

### 5.4 Analysis (M2)
`POST /api/disputes/:id/analyze` → `ai/analyze.js` builds the prompt:
- TRUSTED: the seller records, each with its id.
- UNTRUSTED: the buyer claims, the buyer messages, and text inside buyer images.
- the evidence checklist for the reason.

Luna returns structured output (JSON schema, §8). `ai/guard.js` then checks it:
- every number, date, id and amount in `draft_notes` must match a seller record;
- anything sourced only from a buyer can appear only as "buyer alleges…".

If the check fails, approval is blocked. The analysis is stored. A cached hero analysis is the fallback when the model is unavailable.

### 5.5 Approve and submit (M2)
`POST /api/disputes/:id/submit {draftId, approvedHash}` requires auth, then:
1. Insert a `submissions` row. The UNIQUE constraint wins any double click or second tab.
2. Re-GET the dispute and pick the action **from its live links only**:
   - FIGHT → `provide-evidence` (multipart: notes ≤2000 characters, carrier from PayPal's enum, evidence type chosen per reason, one store document).
   - REFUND → `accept-claim` `{accept_claim_type: "REFUND"}`.
3. Dispute actions are **never retried automatically**. A timeout is recorded as "unknown". The UI then re-GETs the dispute (its `evidences[]` show `SUBMITTED_BY_SELLER`) before it offers another attempt.

## 6. State machines

**PayPal dispute (as observed in the sandbox):**
```
OPEN ─~1m─▶ UNDER_REVIEW ─~4m─▶ WAITING_FOR_SELLER_RESPONSE ──provide-evidence──▶ UNDER_REVIEW ─(adjudicate)─▶ RESOLVED
                                         └──────accept-claim──────────▶ UNDER_REVIEW ─────────────────────────▶ RESOLVED
```

**Local placement (`disputes.batch`):**
```
seed ─▶ pool ──(WAITING, no submission)──▶ <active batch> ──(next reset, if acted on)──▶ retired
           └──(stuck >15m / resolved / not ours)──▶ retired
```
- **Reset** never shrinks the inbox. For each scenario it takes a fresh pool dispute if there is one, and otherwise carries over the current untouched dispute.
- **Classifying a dispute seen for the first time:**

  | Condition | Placement |
  |---|---|
  | Not ours, or resolved, or the seller already acted | retired |
  | WAITING or OPEN | pool |
  | UNDER_REVIEW and less than 15 min old | pool |
  | Anything else | retired |

**Seller-facing phase (`view.phaseOf`):** `PROCESSING → ACTION_NEEDED → SUBMITTED → RESOLVED`.

## 7. Trust boundaries and security model
| Boundary | Threat | Control |
|---|---|---|
| Browser → `/api` writes | Anyone who has the public URL | Passcode → HMAC-signed, HttpOnly, SameSite=Lax cookie, Secure in prod. Login limited to 10 attempts per IP per 15 min. Reset has a persisted cooldown, checked and set synchronously, so concurrent requests can't interleave. |
| Buyer text (PayPal notes, messages, image text) | Prompt injection, faked facts, XSS | Kept in the UNTRUSTED prompt section. The guard rejects buyer-only facts. React escapes all text (`dangerouslySetInnerHTML` is banned). |
| Secrets (PayPal, OpenAI, session) | Leaking into logs, responses or the client bundle | Env only. `PayPalError` never holds the response body. Error responses are generic (500, or 502 + PayPal debug id), and body-parser errors stay inside the API router's handler. `npm test` scans committable files and the bundle. |
| PayPal API | Rate limits, 5xx, token expiry | Token cache keyed by `expires_in`, a single 401 refresh, backoff on 429/5xx **for GETs and idempotent creates only**, a 25 s timeout on every call. |
| Our own retries | Sending a dispute action twice | No automatic retries on dispute actions, plus the UNIQUE submission row. |

## 8. AI contract (M2)
- Model `AI_MODEL` (default `gpt-5.6-luna`), checked at boot via `/v1/models`. Falls back to text-only, then to the cached analysis.
- The output schema is strict JSON:
  ```
  {reason_assessment, evidence:[{requirement, status, source_ids[]}], contradictions[],
   win_probability, confidence_band, recommendation: FIGHT|REFUND, partial_refund_suggestion?,
   draft_notes, citations:[{claim, source_id}]}
  ```
- EV(fight) = p · amount − time cost; EV(refund) = 0. The chargeback fee is sunk either way.
- 30 s timeout, one retry, then "manual review". The model's output is never shown as fact without its citations.

## 9. Deployment
Render web service (`render.yaml`): `npm ci && npm run build`, then `npm start`, health check at `/api/health`, Node 22, Starter plan (no cold starts during judging). On SIGTERM the server drains requests, clears its timers and closes the DB.

## 10. Decisions (ADR log)
| # | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 1 | `node:sqlite` (built in) | No native build on Windows or Render | better-sqlite3 (native toolchain) |
| 2 | Polling instead of webhooks | Removes the signature-verification surface. 30 s latency is fine for a seller. | Webhooks (agreed cut in the debate) |
| 3 | `custom_id` linking plus a committed catalog | The state survives a DB wipe or redeploy | Render persistent disk |
| 4 | Pre-warmed pool | Chargebacks need about 5 min to become actionable, so judges must never wait | Seeding on demand |
| 5 | Only actions linked by PayPal | Avoids 422s and matches what PayPal allows (no partial offers on chargebacks) | Hard-coded action list |
| 6 | Sorting by EV at risk | The sandbox due date is fixed for every dispute, so a deadline sort would be fake | A simulated deadline |
| 7 | GPT-5.6 Luna | Cheap ($0.20/$1.20 per MTok), structured output and vision | — |

## 11. Known tech debt (tracked; fix before M4)
- The 1.1 MB JS bundle: lazy-load AG Grid or use manual chunks.
- Product images for the vision check (M3).
