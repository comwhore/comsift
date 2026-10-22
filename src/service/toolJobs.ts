interface PublicationBatch { active: number; published: boolean }
export interface ToolJobTicket {
  publish<T>(apply: (replacePrevious: boolean) => Promise<T>): Promise<T>;
  finish(): void;
}
/** Serialize publication, not external processes. Overlapping runs share a source batch. */
export class ToolPublicationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private batches = new Map<string, PublicationBatch>();
  begin(source: string): ToolJobTicket {
    const batch = this.batches.get(source) ?? { active: 0, published: false };
    batch.active++; this.batches.set(source, batch);
    let finished = false;
    return {
      publish: <T>(apply: (replacePrevious: boolean) => Promise<T>) => this.run(async () => {
        const result = await apply(!batch.published);
        batch.published = true;
        return result;
      }),
      finish: () => {
        if (finished) return;
        finished = true;
        batch.active--;
        if (!batch.active && this.batches.get(source) === batch) this.batches.delete(source);
      },
    };
  }
  private run<T>(publish: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(publish, publish);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
