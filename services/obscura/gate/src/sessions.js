// Tracks open WebSocket sessions (CDP connections) for the
// OBSCURA_MAX_SESSIONS limit and for closing them on shutdown.

/**
 * @param {{ max: number }} options max 0 means unlimited
 */
export function createSessionRegistry({ max }) {
  const active = new Map();
  let nextId = 1;

  return Object.freeze({
    max,
    get active() {
      return active.size;
    },
    /**
     * Reserves a slot before connecting upstream so concurrent upgrades cannot
     * exceed the limit. Returns null when the limit is reached.
     * @returns {{ id: number, attach: (close: () => void) => void, release: () => void }|null}
     */
    tryAcquire() {
      if (max > 0 && active.size >= max) return null;
      const id = nextId;
      nextId += 1;
      active.set(id, () => {});
      return Object.freeze({
        id,
        attach(close) {
          if (active.has(id)) active.set(id, close);
        },
        release() {
          active.delete(id);
        },
      });
    },
    closeAll() {
      for (const close of [...active.values()]) close();
    },
  });
}
