// Where a dispute's seller records come from: the store catalog for store orders (matched by custom_id),
// otherwise whatever the seller imported for it. One function so the AI, the guard, the PDF and the UI
// always see the same records.
import { scenarioByKey } from "./store/catalog.js";
import { getImportedRecords } from "./db.js";

/** @returns {{records: object[], source: "store" | "imported" | "none"}} */
export function recordsFor(row) {
  const sc = scenarioByKey(row.scenario);
  if (sc) return { records: sc.records, source: "store" };
  const imported = getImportedRecords(row.id);
  return imported?.length ? { records: imported, source: "imported" } : { records: [], source: "none" };
}
