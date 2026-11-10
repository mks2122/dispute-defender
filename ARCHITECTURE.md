# Architecture: Dispute Defender

Status: complete for the hackathon (milestones 1 to 4): inbox and seeding, AI analysis with the fact-checking guard, approve-to-PayPal, responsive dashboard, deploy config.
Owner: planner. Changes to boundaries or invariants in this document need a reviewer pass.

## 1. What the system does
A seller-side agent for PayPal disputes. It does five things:
1. Pulls the merchant's disputes from the PayPal Disputes API.
2. Joins each dispute to the seller's own records: listing, order, shipment, messages, AI-agent mandates.
3. Asks an LLM (OpenAI GPT-5.6 Luna) for a structured, cited assessment.
4. Checks the model's draft against those records.
5. Submits evidence or accepts the claim through PayPal, **but only after the seller approves.**

## 2. Context
```
                ┌──────────────────────────── Dispute Defender (one Node process) ───────────────────────────┐
 Seller ──HTTPS─▶ web (React + AG Grid, static) ──/api──▶ routes ─┬─▶ view ───────┐                          │
 (browser)      │                                                  ├─▶ pool ───────┤                          │
                │                                                  ├─▶ ai/* ──┼─▶ OpenAI API (Luna)      │
                │                                                  └─▶ submit ┤                          │
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
| AI analyses and drafts | Local `analyses` | Can be regenerated |

**Invariant:** losing the SQLite file loses nothing that matters. On a fresh boot, sync rebuilds the pool and the inbox from PayPal plus the catalog. Render keeps the DB in `/tmp` on purpose.

## 4. Components and boundaries
Server modules form layers, and **dependencies only point downward**:

| Layer | Modules | May import | Responsibility |
|---|---|---|---|
| HTTP | `index.js`, `routes.js`, `auth.js` | everything below | Routing, auth, error shape, security headers, shutdown |
| Application | `pool.js`, `sync.js`, `view.js`, `ai/*`, `submit.js` | integration and data layers | Batch, pool and reset rules, sync state machine, view models, AI orchestration, the approval gate |
| Integration | `paypal/client.js`, `paypal/seed.js`, `ai/openai.js` | data layer | All network I/O to PayPal and OpenAI (timeouts, retries, error types), plus sandbox seeding |
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

`GET /api/activity` is the dashboard feed. It is limited to an allowlist of event names, with no detail payload. `GET /api/status` reports the environment, model, sync state and reserve, with the merchant id masked and no secrets.

### 5.3a Web app (dashboard)
**Routing.** A React single-page app with hash routing (`#/overview`, `#/disputes`, `#/needs`, `#/responded`, `#/activity`, `#/settings`). It polls `/api/disputes` every 10 s.

**Layout:**
- Sidebar navigation on desktop, an icon rail at ≤1024 px, and a top bar with a slide-over menu at ≤760 px.
- The disputes table (AG Grid) becomes a card list at ≤900 px.
- AG Grid is **lazy-loaded** with the disputes page, so the first load is about 58 KB gzipped; vendor chunks are split for caching.

**Case sheet:**
- It is a modal: background `inert`, focus moved in and restored on close.
- Esc closes the top dialog only.
- One editable draft per decision.
- The live guard runs via `/validate`.
- Sending is a two-step confirm.

**Visual language.** Neutral greys. Colour is reserved for errors (guard failures) and warnings (injection, unverified claims). State is shown as a dot plus a label. Light and dark modes use the same tokens.

### 5.4 Analysis
**When it runs.** Sync auto-analyses every inbox dispute that has no analysis yet. `POST /api/disputes/:id/analyze` re-runs it and needs auth, because a real model costs money.

**Input** (`ai/analyze.js#buildInput`, `ai/prompt.js`):
- TRUSTED:
  - seller records, each with its id;
  - for logged buyer messages, only their id, date and attachment metadata;
  - code-computed checks: the AI-agent mandate check (`ai/mandate.js`), unverified buyer claims and the injection flag (`ai/facts.js`).
- UNTRUSTED:
  - the buyer's PayPal notes;
  - the text of every buyer message, sanitized so it can't close our delimiters;
  - buyer photos, labelled untrusted.
- Buyer text never enters the system prompt.

**Provider** (`config.aiProviderName`):
- `openai` when `OPENAI_API_KEY` is set (`ai/openai.js`): GPT-5.6 Luna, strict JSON schema, images as data URLs.
- Otherwise `mock` (`ai/mock.js`): deterministic, generic rules over the records, with the same output contract.
- If the real model fails (timeout after one retry, refusal, malformed JSON, schema violation, model unavailable), **the mock stands in** and the reason is stored in `analyses.fallback`.

**Post-processing:**
- Validate against the schema (`ai/schema.js`).
- Recompute the confidence band from the probability.
- Compute EV.
- Run the guard (§7).
- Merge code-detected injection and unverified claims.
- Add warnings, for example "FIGHT with a negative EV".

The result is stored in `analyses`, and the call is audited (provider, model, latency, token usage; never the prompt).

`POST /api/disputes/:id/validate {notes}` re-runs the guard on the seller's edited text. It is pure and needs no auth, and notes are capped at 4,000 characters.

### 5.5 Approve and submit
`POST /api/disputes/:id/submit {decision: "FIGHT"|"REFUND", notes, analysisId}` requires auth. `submit.js` then:
1. Validates: `decision` is a string key, the notes are 1–2,000 characters, and `analysisId` is the **latest** analysis (409 otherwise). The guard runs on the notes for both decisions (422 + `errors[]`).
2. Atomically **claims** the dispute with `INSERT OR IGNORE` into `submissions` (status `pending`). A second claim gets 409.
3. Re-GETs the dispute and acts **only on a live link**: `provide_evidence` or `accept_claim`. If the link is missing, or the GET fails, the claim is released before anything is sent.
4. Sends:
   - FIGHT → `provide-evidence`, multipart. The evidence types are verified in the sandbox:

     | Situation | Evidence type |
     |---|---|
     | UNAUTHORISED | `DETAILS_OF_PURCHASE` |
     | Shipment with a tracking number and a carrier PayPal recognises | `PROOF_OF_FULFILLMENT` + tracking |
     | Anything else | `OTHER` |

     The generated PDF evidence packet is attached (`evidence/pdf.js`).
   - REFUND → `accept-claim` `{note, accept_claim_type: "REFUND"}`.
5. Records the outcome:
   - 2xx → `done`.
   - PayPal 4xx → claim released (nothing happened, so the seller may retry).
   - Timeout, 5xx or network error → `unknown`, **never resent**.
6. Sync's `reconcileSubmissions` handles `unknown` rows once they are 10 minutes old:
   - If the dispute shows seller evidence, or is no longer waiting, it marks them `done`.
   - Otherwise it releases them.
   - A `pending` row is never touched unless it is older than 10 minutes, which can only happen after a crash. It then becomes `unknown`.

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
| Buyer text (PayPal notes, messages, image text) | Prompt injection, faked facts, XSS | Kept in the UNTRUSTED prompt section, with delimiters sanitized. Code-side injection detection. The guard never lets buyer-authored text verify a fact (§8). React escapes all text (`dangerouslySetInnerHTML` is banned). |
| Secrets (PayPal, OpenAI, session) | Leaking into logs, responses or the client bundle | Env only. `PayPalError` never holds the response body. Error responses are generic (500, or 502 + PayPal debug id), and body-parser errors stay inside the API router's handler. `npm test` scans committable files and the bundle. |
| PayPal API | Rate limits, 5xx, token expiry | Token cache keyed by `expires_in`, a single 401 refresh, backoff on 429/5xx **for GETs and idempotent creates only**, a 25 s timeout on every call. |
| Our own retries | Sending a dispute action twice | No automatic retries on dispute actions, plus the UNIQUE submission row. |

## 8. AI contract
**Model.** `AI_MODEL` (default `gpt-5.6-luna`). It is not checked at boot: a `model_not_found` error at call time falls back to the mock (§5.4).

**Output schema** (`ai/schema.js`), strict JSON, validated again on receipt:
```
{summary, recommendation: FIGHT|REFUND, win_probability (0..1), confidence_band: low|medium|high,
 reasoning:[{point, source_ids[]}], evidence:[{requirement, status: have|weak|missing, source_ids[]}],
 contradictions:[{buyer_claim, seller_fact, source_ids[]}], unverified_buyer_claims[],
 injection_detected, partial_refund_suggestion (number|null), draft_notes}
```

**Expected value.** EV(fight) = p · amount − `AI_TIME_COST_USD` (default $10); EV(refund) = 0. The chargeback fee is sunk either way.

**Guard** (`ai/guard.js` + `ai/facts.js`):
- Text is NFKC-normalised, and Arabic-Indic digits are mapped to ASCII.
- Facts extracted:
  - tracking numbers: contiguous, grouped (each group must contain a digit), or anything introduced by the word "tracking";
  - money: `$`, `€`, `£`, `USD`, `dollars`;
  - dates: ISO, `/`-separated, `Mon D, YYYY`, `D Mon YYYY`, and year-less `Mon D` and `M/D`;
  - record ids: known prefixes in any case, or `ABC-1234`.
- Each fact must match **seller-asserted** data. Buyer message text never verifies a fact.
- A buyer quote (`The buyer alleges "…"`) is exempt only if it is a genuine substring of the buyer's own words and at most 300 characters.
- Claims that an agreement, refund, compensation or return happened need a supporting seller record.
- **Known limit:** names, quantities, times and relative durations are not machine-checked. The seller reviews every draft before sending.

**Timeouts.** OpenAI calls time out after 30 s, with one retry on timeout, 429 or 5xx. The analysis is read-only, so the retry is safe.

## 9. Deployment
Render web service (`render.yaml`): `npm ci && npm run build`, then `npm start`, health check at `/api/health`, Node 22, free plan (it sleeps after 15 minutes idle and takes about a minute to wake; the cache is rebuilt and disputes are re-analysed on each wake). Secrets are set in the dashboard, and `SESSION_SECRET` is generated by Render. The SQLite cache lives in `/tmp` and is rebuilt from PayPal on boot (§3). On SIGTERM the server drains requests, clears its timers, stops any refill and closes the DB. Deploying is a manual step for the owner. Nothing in the repo deploys or publishes automatically.

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
| 8 | Deterministic mock model behind the same contract | The demo works with no key, with no outage and at no cost, and it exercises the guard, EV and submit paths exactly like the real model | Recorded responses (go stale, no coverage of new disputes) |
| 9 | Neutral dashboard with sidebar tabs | Disputes are operational work: density, scannability and keyboard access beat decoration (user feedback on the first pass) | Marketing-style hero page with coloured pills |

## 11. Known limits and tech debt
- Product images are illustrations rendered from `scripts/store-images/svgs.mjs` (no real photography). To regenerate them: run the script, build, render each SVG at 800×800 in a browser, and save it as PNG in `web/public/store/`.
- The guard does not machine-check names, quantities, times or relative durations (§8). The seller reviews every draft.
- The AG Grid chunk is about 950 KB minified (265 KB gzip). It is lazy-loaded, but Vite still warns about its size.
- Single-seller demo: no PayPal OAuth onboarding, and no real carrier tracking API.
