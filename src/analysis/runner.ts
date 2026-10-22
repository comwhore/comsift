import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import backendSource from "./backend.py";

export interface ProfileRecord {
  id: string;
  dataset: string;
  row: number;
  fields: Record<string, string>;
  raw: Record<string, string>;
  /** Column block the record came from (e.g. FOLLOWING / FOLLOWERS / IN COMMON). */
  section?: string;
}
export interface CandidatePair {
  left_id: string;
  right_id: string;
  match_weight?: number;
  match_probability?: number;
  /** Combined multi-field evidence (username, name, URL, bio…; 0–1). A review signal, not a probability. */
  evidence_score?: number;
  evidence: Record<string, unknown>;
}
export interface JinaRanking { source_id: string; id: string; score: number; rank: number }
export interface AnalysisResult { records: ProfileRecord[]; pairs: CandidatePair[]; jina: JinaRanking[] }
export type AnalysisMode = "splink" | "jina" | "combined";

export interface AnalyzeRequest {
  action: "analyze";
  datasets: Array<{ name: string; csv: string }>;
  mappings: Record<string, Record<string, string>>;
  mode: AnalysisMode;
  threshold: number;
  low_threshold?: number;
  allow_primary_name_candidates?: boolean;
  compare_within?: boolean;
  model_path: string;
  device: "cpu" | "auto";
}

function parseEnvelope(stdout: string): { ok: boolean; error: string } | null {
  try {
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { ok?: unknown }).ok !== "boolean") return null;
    const { ok, error } = parsed as { ok: boolean; error?: unknown };
    if (error !== undefined && typeof error !== "string") return null;
    return { ok, error: error ?? "" };
  } catch { return null; }
}

export class AnalysisRunner {
  constructor(private pythonCommand: string) {}

  async run<T>(request: object, signal?: AbortSignal): Promise<T> {
    const runDir = await fs.mkdtemp(join(tmpdir(), "comsift-analysis-"));
    const script = join(runDir, "backend.py");
    try {
      await fs.writeFile(script, backendSource, { mode: 0o600 });
    const command = this.pythonCommand.trim();
    if (!command) throw new Error("Configure a Python executable in settings.");
    const parts = command.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(part => part.replace(/^["']|["']$/g, "")) ?? [];
    const executable = parts.shift();
    if (!executable) throw new Error("Invalid Python command.");
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(executable, [...parts, script], {
        shell: false, windowsHide: true, signal,
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      });
      let outputTooLarge = false;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        if (stdout.length > 20_000_000) { outputTooLarge = true; child.kill(); }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on("error", error => reject(error));
      child.stdin.on("error", () => { /* Process errors are reported by child/close. */ });
      child.on("close", (code, signalName) => {
        try {
          if (signal?.aborted) throw new Error("Python analysis was cancelled.");
          if (outputTooLarge) throw new Error("Python worker response too large.");
          // The worker reports handled errors as a JSON envelope and exits 1; show that message, not just the exit code.
          const reported = parseEnvelope(stdout);
          if (reported && !reported.ok) throw new Error(reported.error || "Python analysis failed.");
          if (code !== 0 || signalName) throw new Error(`Python worker failed (${signalName ?? `exit ${code}`})`);
          if (!stdout.trim()) {
            throw new Error(`Python worker produced no output (exit ${code})${stderr ? `: ${stderr.slice(-500)}` : ""}`);
          }
          const lines = stdout.trim().split(/\r?\n/);
          const parsed = JSON.parse(lines.at(-1) ?? "{}") as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Python response envelope.");
          const response = parsed as Record<string, unknown>;
          if (typeof response.ok !== "boolean" || (response.error !== undefined && typeof response.error !== "string")) {
            throw new Error("Invalid Python response envelope.");
          }
          if (!response.ok) throw new Error(typeof response.error === "string" && response.error ? response.error : "Python analysis failed.");
          if (!("result" in response)) throw new Error("Python response has no result.");
          resolve(response.result as T);
        } catch (error) {
          reject(new Error(`${error instanceof Error ? error.message : String(error)}${code ? ` (exit ${code})` : ""}${stderr ? `: ${stderr.slice(-500)}` : ""}`));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }
}
