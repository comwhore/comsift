// Pure helpers: stable pair identity and cross-run evidence memory.
import type { AnalysisResult, ProfileRecord, CandidatePair } from "./runner";

export interface PairHistoryEntry {
  first: string;
  runs: number;
  score: number;
  prev?: number;
  signals: string[];
  gained: string[];
}
export type PairHistory = Record<string, PairHistoryEntry>;

function recordKey(record: ProfileRecord): string {
  const fields = record.fields;
  const fallback = Object.entries(fields).filter(([key, value]) => key !== "platform" && value.trim())
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("|");
  const handle = (fields.username || fields.display_name || fallback || record.id).toLowerCase().replace(/\s+/g, " ").trim();
  return `${(fields.platform || record.dataset).toLowerCase()}|${handle}`;
}

/** Identity that survives row shifts between scans: platform+handle of both sides. */
export function pairKey(left: ProfileRecord, right: ProfileRecord): string {
  return [recordKey(left), recordKey(right)].sort().join(" ↔ ");
}

export function pairEvidenceScore(pair: CandidatePair): number {
  return Math.max(pair.match_probability ?? 0, pair.evidence_score ?? 0);
}

export function pairSignals(pair: CandidatePair): string[] {
  const signals = (pair.evidence as { signals?: Record<string, number> } | undefined)?.signals;
  return signals ? Object.keys(signals) : [];
}

/** Fold one finished run into the history; returns the new history (input is not mutated). */
export function mergeRun(history: PairHistory, result: AnalysisResult, now: string): PairHistory {
  const records = new Map(result.records.map(record => [record.id, record]));
  const next: PairHistory = { ...history };
  for (const pair of result.pairs) {
    const left = records.get(pair.left_id), right = records.get(pair.right_id);
    if (!left || !right) continue;
    const key = pairKey(left, right);
    const before = history[key];
    const score = pairEvidenceScore(pair);
    const signals = pairSignals(pair);
    next[key] = {
      first: before?.first ?? now,
      runs: (before?.runs ?? 0) + 1,
      score,
      prev: before?.score,
      signals,
      gained: before ? signals.filter(name => !before.signals.includes(name)) : [],
    };
  }
  return next;
}
