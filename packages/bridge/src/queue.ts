/** Coda asincrona minima: push da chiunque, consumo con for await. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}
