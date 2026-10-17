import type { AnalysisResult, CandidatePair } from "./runner";
import { pairKey, pairEvidenceScore, pairSignals } from "./history";

export interface RunSummary { fresh: number; updated: number; low: number; rerun: boolean }

/** Discard orphaned pairs before displaying them or enabling decision actions. */
export function loadedPairs(result: AnalysisResult): CandidatePair[] {
  const ids = new Set(result.records.map(record => record.id));
  return result.pairs.filter(pair => ids.has(pair.left_id) && ids.has(pair.right_id));
}

export function runSummary(previous: AnalysisResult | null, next: AnalysisResult, threshold: number, floor: number): RunSummary {
  const index = (result: AnalysisResult) => {
    const records = new Map(result.records.map(record => [record.id, record]));
    return new Map(loadedPairs(result).map(pair => [pairKey(records.get(pair.left_id)!, records.get(pair.right_id)!), pair]));
  };
  const old = previous ? index(previous) : new Map<string, CandidatePair>();
  let fresh = 0, updated = 0, low = 0;
  for (const [key, pair] of index(next)) {
    const score = pairEvidenceScore(pair);
    if (score >= floor && score < threshold) low++;
    if (score < threshold) continue;
    const before = old.get(key);
    if (!before || pairEvidenceScore(before) < threshold) fresh++;
    else if (score - pairEvidenceScore(before) >= 0.01 || pairSignals(pair).some(signal => !pairSignals(before).includes(signal))) updated++;
  }
  return { fresh, updated, low, rerun: previous !== null };
}
