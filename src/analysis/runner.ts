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
  model_path: string;
  device: "cpu" | "auto";
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
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        if (stdout.length > 20_000_000) child.kill();
      });
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on("error", error => reject(error));
      child.stdin.on("error", () => { /* Process errors are reported by child/close. */ });
      child.on("close", (code, signalName) => {
        try {
          if (!stdout.trim()) {
            throw new Error(`Python worker produced no output (${signalName ? `killed by ${signalName}` : `exit ${code}`})${stderr ? `: ${stderr.slice(-500)}` : ""}`);
          }
          const lines = stdout.trim().split(/\r?\n/);
          const response = JSON.parse(lines.at(-1) ?? "{}") as { ok?: boolean; error?: string; result?: unknown };
          if (!response.ok) throw new Error(response.error || stderr || "Python analysis failed.");
          resolve(response.result as T);
        } catch (error) {
          reject(new Error(`${(error as Error).message}${code ? ` (exit ${code})` : ""}${stderr ? `: ${stderr.slice(-500)}` : ""}`));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }
}
