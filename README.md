# Dispute Defender

**Stripe sellers get AI help with disputes. PayPal sellers don't.** Dispute Defender is an AI agent that reads each PayPal dispute, gathers the seller's own evidence, works out whether the case is worth fighting, drafts the response, and submits it through the PayPal Disputes API after the seller approves.

Mastercard reports that about **46% of chargebacks are accepted without a fight**. Small sellers lose the money because building a case by hand takes longer than the dispute is worth.

> Built for the PayPal AI Hackathon (Devpost), November 2026. Status: **milestone 1 of 4 done**: live PayPal inbox, sandbox seeding and the case view. The AI analysis lands in milestone 2. See [ARCHITECTURE.md](ARCHITECTURE.md) and [ENGINEERING-PRACTICES.md](ENGINEERING-PRACTICES.md).

## What works today
- **Live PayPal dispute inbox** (AG Grid). It pulls real sandbox disputes from the Disputes API and sorts them by money at risk. For each dispute it shows the PayPal deadline and the actions PayPal currently allows.
- **Case view.** The buyer's claim, quoted from PayPal and marked as unverified, next to every seller record with a citable ID: listing, order, shipment, messages, prior orders, and AI-agent purchase mandates.
- **Sandbox dispute generator.** It makes real card sales, then files real chargebacks through PayPal's sandbox `process-chargeback`, using 8 scenarios that cover not received, not as described, unauthorized, AI-agent purchases and prompt-injection attacks.
- **Pre-warmed pool.** PayPal needs about 5 minutes before a new chargeback can be answered, so "Reset demo" swaps in disputes that are already actionable.
- **Rebuilds itself after a wipe.** Every order carries `custom_id = dd:<scenario>`, so a wiped database is rebuilt from PayPal alone (dispute → capture → custom_id → store records).

## Run it locally
Requires Node 22.13+ and a PayPal developer account.
1. Create a **United States** sandbox business account and a sandbox app linked to it (developer.paypal.com → Testing Tools → Sandbox Accounts, then Apps & Credentials).
2. `cp .env.example .env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `DEMO_PASSCODE`.
3. `npm install`
4. `npm run seed`. This creates 8 sandbox disputes (about 5 minutes until PayPal makes them actionable). The running server puts them in the inbox automatically.
5. `npm run build && npm run start:local`, then open http://localhost:3000

For development: run `npm run dev` (API) and `npm run dev:web` (Vite on :5173) together.

## How it uses PayPal
| API | Used for |
|---|---|
| `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}` | Inbox, case details, live allowed actions (HATEOAS links) |
| `POST /v1/customer/disputes/{id}/provide-evidence` | Submitting the approved evidence *(milestone 2)* |
| `POST /v1/customer/disputes/{id}/accept-claim` | Refunding when fighting isn't worth it *(milestone 2)* |
| `POST /v2/checkout/orders` (+ capture), `GET /v2/payments/captures/{id}` | Demo sales; mapping a dispute back to its store order |
| `POST /v2/customer-support/process-chargeback` (sandbox only) | Generating realistic demo chargebacks |

## Sandbox notes (learned the hard way)
- Sandbox accounts must be **US**. India-based sandbox accounts fail card payments, checkout and Send Money.
- A new chargeback goes OPEN → UNDER_REVIEW (about 1 min) → WAITING_FOR_SELLER_RESPONSE (about 4–5 min).
- Chargeback reason codes depend on code **and card brand**: `1330`(Visa)/`4853`(MC) → not as described, `4837` **with Mastercard** → unauthorized (with Visa it becomes "other" and gets stuck), `4855`(MC)/`13.1`(Visa) → not received. `10.4` → "other" gets stuck, so don't use it.
- The sandbox gives every chargeback the same fixed `seller_response_due_date`.

## License
MIT
