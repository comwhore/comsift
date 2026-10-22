/** Failed model decisions are isolated to one source; never invent a fallback match. */
export class DecisionAttemptsError extends Error {
  constructor(public readonly attempts: number, detail: string) {
    super(`Skipped after ${attempts} decision attempts: ${detail}`);
    this.name = "DecisionAttemptsError";
  }
}

export async function retryDecision<T>(run: () => Promise<T>, signal?: AbortSignal, maxAttempts = 4): Promise<T> {
  const attempts = Math.max(1, Math.min(4, Math.floor(maxAttempts) || 1));
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await run(); }
    catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (attempt === attempts - 1) throw new DecisionAttemptsError(attempts, error instanceof Error ? error.message : "Invalid model response");
    }
  }
  throw new Error("Unreachable decision retry state");
}
