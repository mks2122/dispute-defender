# Devpost submission kit

Draft text for the Devpost form and a shot-by-shot script for the demo video, which must be under 3 minutes. Nothing here is published automatically. Copy what you need.

---

## Project name
Dispute Defender

## Tagline (under 200 characters)
An AI agent that fights the PayPal chargebacks worth fighting, refunds the rest, and fact-checks every response against the seller's records before it's sent.

## Inspiration
About 46% of chargebacks are accepted without a fight (Mastercard, 2025). Big merchants pay for dispute services; small sellers just lose the money. Fighting a $110 chargeback means digging through tracking pages, listing history and old messages, then writing a case for a reviewer. Stripe sellers now get AI help with this. PayPal sellers don't. Disputes are also changing: buyers' AI agents now make purchases, and nobody knows how to argue "my agent bought it without permission."

## What it does
Dispute Defender connects to a seller's PayPal disputes, then for each dispute:
1. **Reads the buyer's claim** straight from PayPal and treats it as an unverified claim, never an instruction.
2. **Checks it against the seller's own records**: shipment and tracking, the listing as the buyer saw it, supplier certificates, the message log, and earlier orders from the same device and address. For AI-agent purchases it also checks the mandate the buyer signed.
3. **Recommends Fight or Refund**, with an AI-estimated win chance (not calibrated against real outcomes yet), the expected value of fighting, and, when the seller is partly at fault, an optional goodwill partial-refund suggestion (chargebacks themselves only take a full refund). It is honest: when the records show the buyer is right, it says refund.
4. **Drafts the response.** Every claim in it cites a record. A fact-checking guard blocks any tracking number, amount, date, signature or record id that isn't in the seller's data, any date attached to the wrong event, and any claimed agreement, refund, return, call or accusation that no record shows, including anything the buyer made up.
5. **Works beyond the demo store.** Any other dispute in the seller's PayPal account shows up too; the seller imports its records (JSON or CSV) and gets the same analysis and fact-checking.
6. **Submits through PayPal only when the seller confirms.** It sends evidence with a generated PDF packet, or accepts the claim to refund. A dispute can never be acted on twice.

## How we built it
- **PayPal:**
  - Disputes API: list and details, live HATEOAS actions, `provide-evidence` (multipart with a PDF), `accept-claim`.
  - Orders and Captures, with `custom_id` linking each dispute back to its order.
  - The sandbox `process-chargeback` endpoint, used to generate 8 realistic scenarios.
- **AI:** OpenAI **GPT-5.6 Luna** with a strict JSON schema and vision on listing and buyer photos. Prompts keep TRUSTED seller records apart from UNTRUSTED buyer content. A deterministic built-in model with the same contract keeps the demo working without a key, and takes over automatically if the model fails.
- **Code decides what must be exact:** the mandate check, expected value, injection detection, unverified-claim detection and the fact-checking guard are plain, tested code, not model output.
- **Stack:** Node 22 + Express, built-in SQLite as a rebuildable cache (PayPal is the source of truth) with an optional Turso mirror so history survives restarts, React + AG Grid for the dashboard, and Render deploy config.
- **Engineering:** 125 unit tests (contract tests against fake PayPal and fake OpenAI servers, guard bypass attempts, the submit race, a secret scan), lint rules that enforce the architecture's layers, and a reviewer agent plus an adversarial edge-case agent gating every milestone.

## Challenges
- **The sandbox's surprises:**
  - India-based sandbox accounts can't take card payments.
  - Chargeback reasons depend on the reason code *and* the card brand (Visa + 4837 gets stuck).
  - New chargebacks take about 5 minutes to become actionable, so we built a pre-warmed reserve.
  - Every dispute shares one fixed due date, so we rank by expected value instead.
- **Making the AI unable to lie.** Our adversarial agent found 18 ways to sneak a fabricated fact past the first guard: day-first dates, "99 dollars", spaced and lowercase tracking numbers, made-up record ids, and fake facts hidden inside a "buyer alleges" quote. All 34 attack drafts are now blocked.
- **Letting outsiders attack it.** Three blank-slate "judge" agents reviewed the finished build in turn, and each found ways past the fact-checker: a real date attached to the wrong event, look-alike characters, "Ocotber 26", "As you can see, we refunded…", a buyer quote followed by "which matches our label", and a product called "phone case" counting as proof of a phone call. Every one is now a regression test. They also caught that the evidence sent to PayPal named photos it didn't include; the photos are now attached.
- **Making a real model behave.** On GPT-5.6 Luna one run let the injected note talk it into a refund through a reasonable-sounding argument. We changed the prompt so fabricated buyer details weaken the buyer's case, and added a code-level backstop: any refund verdict on a dispute with an injection attempt is flagged for a second look.
- **Never acting twice.** A slow submit could have been "released" by the background sync and sent again. Claims are now atomic, and anything PayPal didn't confirm is reconciled, never resent.

## Accomplishments
- An end-to-end live flow on real PayPal sandbox disputes: dispute → AI verdict → fact-checked draft → seller confirms → evidence or refund in PayPal.
- All 8 scenarios analysed by GPT-5.6 Luna with the expected verdicts and guard-clean drafts, at about $0.0015 per analysis.
- AI-agent purchase disputes handled with a verifiable mandate check, built for the agentic-commerce era.
- Injection attacks in both buyer text and buyer images, demonstrated and defended.

## What we learned
In dispute handling, the AI's job is judgement and writing. Exact facts belong to code that can prove them. And an honest "refund this one" builds more trust than a confident fight.

## What's next
- Live PayPal OAuth for real sellers.
- Store connectors (Shopify, WooCommerce) and carrier APIs instead of pasting records.
- Real carrier tracking APIs.
- Learning which evidence wins which reason code.
- Webhooks.

## Built with
paypal-disputes-api, paypal-orders-api, openai, gpt-5.6-luna, node.js, express, sqlite, turso, react, ag-grid, vite, render

## Testing instructions for judges
1. Open the hosted URL. It runs on Render's free plan, so the first visit after a quiet spell can take about a minute to load. If you're running it yourself, follow the README's "Run it locally".
2. **Overview** shows live PayPal sandbox disputes ranked by value. Open **Leather bifold wallet**.
3. Read the verdict, click a citation chip (for example `SHP-1001`) to jump to the record, then try typing a fake tracking number into the response. The guard blocks it.
4. Click **Submit evidence → Confirm and send**. The passcode is in the submission notes. The dispute's PayPal status changes.
5. Try **Linen throw** and **Ceramic vase**, the injection attacks, and **Trekking poles** (AI agent over its mandate).
6. **Settings → Load new disputes** swaps in fresh disputes that PayPal has ready.

---

## Demo video script (2:45)
| Time | Screen | Voice-over |
|---|---|---|
| 0:00 | Title card → Overview | "Almost half of chargebacks are never contested. For small PayPal sellers, building a case takes longer than the dispute is worth. This is Dispute Defender." |
| 0:15 | Overview: KPIs, queue | "It pulls live disputes from the PayPal Disputes API and ranks them by the expected value of responding: $958 at risk, about $285 worth fighting for." (Read the two numbers on screen; they change when new disputes are loaded.) |
| 0:30 | Open Leather wallet | "The buyer says the wallet is fake leather and the wrong colour. The AI checked that against the seller's own records." |
| 0:45 | Verdict + reasoning, click a citation | "Fight: signed for on delivery, a supplier certificate confirms full-grain leather, and the buyer wrote 'it's lovely' the day it arrived. Every point cites a record." |
| 1:05 | Type a fake tracking number into the draft | "The draft is fact-checked live. Watch what happens if I add a tracking number that isn't in my records: blocked. Facts come from the seller's data, never from the model or the buyer." |
| 1:25 | Submit → confirm → status changes | "I approve, confirm, and it's submitted through PayPal's provide-evidence API with a PDF evidence packet and the seller's photos. The status updates from PayPal." |
| 1:45 | Phone case + jacket | "It's honest, too. An $18 case with no tracking: refund, because fighting costs more. A jacket the buyer reported torn, and never got a reply: refund." |
| 2:05 | Linen throw / vase photo | "Buyers try to manipulate the AI. This note claims a refund was agreed and says 'ignore all prior instructions'. This photo hides the same thing on a sticky note. Both ignored, and both fake claims flagged." |
| 2:25 | Trekking poles mandate | "And for the agentic era: when a buyer's AI agent made the purchase, we check the mandate the buyer signed. $310 is over the $150 limit, so we refund." |
| 2:40 | Overview | "Dispute Defender: fight the chargebacks worth fighting, refund the rest, and check every fact before it's sent." |

**Recording tips:**
- Use a 1440×900 window in light mode, and run Settings → Load new disputes about 10 minutes before recording.
- Keep the hero wallet dispute untouched until the submit beat.
- If `OPENAI_API_KEY` is set, show the "GPT-5.6 Luna" label in the sidebar.
