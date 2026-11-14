type Listener<P> = (payload: P) => void

/** Tiny typed event emitter. Zero dependencies, no reliance on EventTarget. */
export class Emitter<E extends { [K in keyof E]: unknown }> {
  readonly #listeners = new Map<keyof E, Set<Listener<never>>>()

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof E>(type: K, fn: Listener<E[K]>): () => void {
    let set = this.#listeners.get(type)
    if (!set) this.#listeners.set(type, (set = new Set()))
    set.add(fn as Listener<never>)
    return () => this.off(type, fn)
  }

  once<K extends keyof E>(type: K, fn: Listener<E[K]>): () => void {
    const off = this.on(type, (p) => {
      off()
      fn(p)
    })
    return off
  }

  off<K extends keyof E>(type: K, fn: Listener<E[K]>): void {
    this.#listeners.get(type)?.delete(fn as Listener<never>)
  }

  protected emit<K extends keyof E>(type: K, payload: E[K]): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) {
      try {
        ;(fn as Listener<E[K]>)(payload)
      } catch (e) {
        // A throwing listener must not break delivery to others; surface it asynchronously.
        queueMicrotask(() => {
          throw e
        })
      }
    }
  }

  protected removeAllListeners(): void {
    this.#listeners.clear()
  }

  /** Number of listeners for an event (useful in tests). */
  listenerCount<K extends keyof E>(type: K): number {
    return this.#listeners.get(type)?.size ?? 0
  }
}
