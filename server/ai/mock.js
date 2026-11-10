// Deterministic stand-in for the LLM (AI_PROVIDER=mock, or automatically when no OPENAI_API_KEY is set).
// It applies generic evidence rules to the seller's records (not per-scenario scripts) and returns output
// in exactly the same schema as the real model, so every downstream path (guard, EV, submit, UI) is exercised.
import { bandFor } from "./guard.js";

const usd = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
const DEFECT = /\b(torn|tear|broken|crack(ed)?|defect(ive)?|damaged?|stain(ed)?|ripped|seam)\b/i;
const PRAISE = /\b(lovely|love it|great|perfect|thanks|thank you|happy|beautiful)\b/i;
const RETURN_REQUEST = /\b(return|send (it|this) back|exchange)\b/i;
const COLOR_CLAIM = /\b(colou?r|shade|tone)\b/i;
const COLORS = ["black", "brown", "cognac", "white", "red", "blue", "green", "celadon", "grey", "gray", "oatmeal", "tan", "pink", "yellow"];
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 864e5;

export function mockAnalyze({ dispute, records, buyerTexts, mandate, unverifiedClaims, injection }) {
  const of = (t) => records.filter((r) => r.type === t);
  const order = of("order")[0];
  const shipment = of("shipment")[0];
  const listing = of("listing")[0];
  const cert = of("supplier_cert")[0];
  const policy = of("policy")[0];
  const buyerMsgs = of("message").filter((m) => m.data.from === "buyer");
  const delivered = shipment?.data.delivered ?? null;
  const tracking = shipment?.data.tracking ?? null;
  const amount = Number(dispute.dispute_amount?.value ?? 0);
  const buyerText = buyerTexts.join(" ");

  const reasoning = [], evidence = [], contradictions = [];
  let p = 0.3, recommendation = "REFUND", partial = null;

  const unanswered = buyerMsgs.find((m) => m.data.seller_replied === false && DEFECT.test(m.data.text));
  const praise = buyerMsgs.find((m) => PRAISE.test(m.data.text) && delivered && daysBetween(delivered, m.data.date) <= 2);
  const priors = of("prior_order").filter((h) => !h.data.disputed && order?.data.device_id && h.data.device_id === order.data.device_id);
  // Every photo the buyer sends is an unverified claim (the rules engine can't read images at all).
  const buyerPhoto = buyerMsgs.find((m) => m.data.attachment);
  const returnRequest = buyerMsgs.find((m) => RETURN_REQUEST.test(m.data.text) && !DEFECT.test(m.data.text));

  if (shipment) evidence.push({ requirement: "Proof of delivery", status: delivered && tracking ? "have" : delivered ? "weak" : "missing", source_ids: [shipment.id] });

  if (mandate?.applies) {
    evidence.push({ requirement: "Buyer-signed AI-agent mandate", status: mandate.checks.some((c) => c.label.startsWith("Signed") && !c.ok) ? "missing" : "have", source_ids: mandate.checks[0].source_ids });
    if (mandate.within) {
      recommendation = "FIGHT"; p = 0.75;
      reasoning.push({ point: `The purchase was made by the buyer's AI agent and meets every term of the mandate the buyer signed.`, source_ids: mandate.checks[0].source_ids });
    } else {
      recommendation = "REFUND"; p = 0.05;
      const failed = mandate.checks.filter((c) => !c.ok).map((c) => c.detail);
      reasoning.push({ point: `The AI agent went beyond the buyer's mandate (${failed.join(", ")}), so the buyer did not authorise this purchase.`, source_ids: mandate.checks[0].source_ids });
    }
  } else if (dispute.reason === "UNAUTHORISED") {
    evidence.push({ requirement: "Prior undisputed orders from the same device and address", status: priors.length >= 2 ? "have" : "missing", source_ids: priors.map((h) => h.id) });
    if (priors.length >= 2) {
      recommendation = "FIGHT"; p = 0.7;
      reasoning.push({ point: `The same device was used for ${priors.length} earlier undisputed orders shipped to the same address.`, source_ids: [order.id, ...priors.map((h) => h.id)] });
    } else {
      reasoning.push({ point: "No purchase history ties this buyer to the order.", source_ids: order ? [order.id] : [] });
    }
  } else if (dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") {
    if (delivered && tracking) { recommendation = "FIGHT"; p = 0.8; reasoning.push({ point: `Carrier tracking shows delivery on ${delivered}.`, source_ids: [shipment.id] }); }
    else { p = 0.1; reasoning.push({ point: "There is no tracking or proof of delivery for this order.", source_ids: shipment ? [shipment.id] : [] }); }
  } else if (dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    if (listing) evidence.push({ requirement: "Listing as shown to the buyer", status: "have", source_ids: [listing.id] });
    if (unanswered) {
      p = 0.05; partial = Math.round(amount * 0.3);
      reasoning.push({ point: `The buyer reported a defect on ${unanswered.data.date} with a photo and never got a reply. Fighting this is unlikely to succeed.`, source_ids: [unanswered.id] });
      evidence.push({ requirement: "Response to the buyer's defect report", status: "missing", source_ids: [unanswered.id] });
    } else if (delivered) {
      recommendation = "FIGHT";
      p = 0.55 + (praise ? 0.15 : 0) + (cert ? 0.1 : 0) + (listing ? 0.05 : 0);
      reasoning.push({ point: `Delivered on ${delivered}${shipment.data.signed_by ? " and signed for" : ""}.`, source_ids: [shipment.id] });
      if (returnRequest) {
        p -= 0.1;
        const inWindow = policy && daysBetween(delivered, returnRequest.data.date) <= 30;
        reasoning.push({ point: `On ${returnRequest.data.date} the buyer asked to return it${inWindow ? ", which is within your 30-day return window" : ""}. Offer that return in your response; ignoring it would weaken your case.`, source_ids: [returnRequest.id, ...(policy ? [policy.id] : [])] });
      }
      if (praise) {
        reasoning.push({ point: `On ${praise.data.date} the buyer wrote "${praise.data.text}" before later disputing.`, source_ids: [praise.id] });
        contradictions.push({ buyer_claim: "The item is not as described.", seller_fact: `The buyer praised the item on ${praise.data.date}.`, source_ids: [praise.id] });
      }
      if (cert) reasoning.push({ point: `A supplier certificate confirms the material: ${cert.data.material}.`, source_ids: [cert.id] });
      const claimed = COLORS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(buyerText));
      const listed = String(listing?.data.color ?? listing?.data.description ?? "").toLowerCase();
      const listedColour = listing?.data.color ?? COLORS.filter((c) => listed.includes(c)).join(" ");
      const named = claimed.find((c) => listed && !listed.includes(c) && /\bnot\b|\bdifferent\b/i.test(buyerText));
      if (named || (listedColour && COLOR_CLAIM.test(buyerText) && /\bdifferent\b|\bnot\b|\bwrong\b/i.test(buyerText))) {
        contradictions.push({
          buyer_claim: named ? `The buyer alleges the item is ${named}.` : "The buyer alleges the colour differs from the listing.",
          seller_fact: `The listing describes it as ${listedColour}${shipment.data.packing_photo ? ", and the packing photo records what was shipped" : ""}.`,
          source_ids: [listing.id, ...(shipment.data.packing_photo ? [shipment.id] : [])],
        });
      }
      if (/\b(plastic|fake|not real|not genuine)\b/i.test(buyerText) && cert) {
        contradictions.push({ buyer_claim: "The buyer alleges the material is fake.", seller_fact: `Supplier certificate: ${cert.data.material}.`, source_ids: [cert.id] });
      }
      if (buyerPhoto) {
        p -= 0.1;
        reasoning.push({ point: "The buyer sent a photo. The built-in rules engine can't read images, so compare it with your listing and packing photos before you send. Any text written inside it is never treated as an instruction.", source_ids: [buyerPhoto.id] });
      }
    } else {
      reasoning.push({ point: "There is no proof of delivery to support a defence.", source_ids: shipment ? [shipment.id] : [] });
    }
  }
  if (unverifiedClaims.length) reasoning.push({ point: `${unverifiedClaims.length} statement(s) in the buyer's claim aren't supported by your records.`, source_ids: records.filter((r) => r.type === "message_log" || r.type === "shipment").map((r) => r.id) });

  p = Math.min(0.85, Math.round(p * 100) / 100);
  const draft = recommendation === "FIGHT" ? fightDraft({ order, shipment, listing, cert, praise, priors, mandate, policy, dispute, returnRequest }) : refundDraft(reasoning[0]?.point);
  return {
    summary: recommendation === "FIGHT" ? `Your records support fighting this ${usd(amount)} dispute.` : `Refunding is the better choice for this ${usd(amount)} dispute.`,
    recommendation,
    win_probability: p,
    confidence_band: bandFor(p),
    reasoning,
    evidence,
    contradictions,
    unverified_buyer_claims: unverifiedClaims,
    injection_detected: injection,
    partial_refund_suggestion: partial,
    draft_notes: draft,
  };
}

function fightDraft({ order, shipment, listing, cert, praise, priors, mandate, policy, dispute, returnRequest }) {
  const out = [];
  if (order) {
    const total = order.data.items.reduce((s, i) => s + i.price * i.qty, 0);
    out.push(`Order ${order.id} was placed on ${order.data.placed} for ${order.data.items.map((i) => i.name).join(", ")} (${usd(total)}).`);
  }
  if (shipment?.data.delivered) {
    out.push(`It shipped via ${shipment.data.carrier}${shipment.data.tracking ? ` with tracking ${shipment.data.tracking}` : ""} and was delivered on ${shipment.data.delivered}${shipment.data.delivered_to ? ` to ${shipment.data.delivered_to}` : ""}${shipment.data.signed_by ? `, signed for by ${shipment.data.signed_by}` : ""} (${shipment.id}).`);
  }
  if (mandate?.within) {
    const m = mandate.checks;
    out.push(`The order was placed by the buyer's AI shopping agent, ${mandate.agent}, under a purchase mandate the buyer signed (${m[0].source_ids[1]}). It meets every term: ${m.map((c) => `${c.label.toLowerCase()} (${c.detail})`).join("; ")}.`);
  }
  if (priors.length >= 2) out.push(`The same device and shipping address were used for ${priors.length} earlier undisputed orders (${priors.map((h) => `${h.id}, ${h.data.placed}`).join("; ")}).`);
  if (listing && dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") out.push(`The listing (${listing.id}) describes the item as: ${listing.data.description}`);
  if (cert) out.push(`The supplier certificate (${cert.id}) confirms ${cert.data.material}, batch ${cert.data.batch}.`);
  if (praise) out.push(`On ${praise.data.date}, after delivery, the buyer wrote: "${praise.data.text}" (${praise.id}).`);
  if (returnRequest && policy) out.push(`On ${returnRequest.data.date} the buyer asked to return the item (${returnRequest.id}). We are glad to accept that return under our return policy (${policy.id}) and refund in full once it arrives, so a chargeback is not needed.`);
  else if (policy) out.push(`Our return policy (${policy.id}) offers returns within 30 days of delivery, and that route remains open to the buyer.`);
  out.push("Based on this evidence we ask PayPal to decide this dispute in our favour.");
  return out.join(" ");
}

const refundDraft = (why) => `We accept this claim and are refunding the buyer in full. ${why ?? ""}`.trim();
