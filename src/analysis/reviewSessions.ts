/** In-memory live review controllers; persisted tabs fall back to their Markdown snapshot. */
export interface LiveReviewSession {
  mount(host: HTMLElement): void;
  unmount(): void;
}
const sessions = new Map<string, LiveReviewSession>();
let next = 0;
export function registerReviewSession(session: LiveReviewSession): string {
  const id = `review-${Date.now()}-${++next}`;
  sessions.set(id, session);
  return id;
}
export function reviewSession(id: string): LiveReviewSession | undefined { return sessions.get(id); }
export function forgetReviewSession(id: string): void { sessions.delete(id); }
