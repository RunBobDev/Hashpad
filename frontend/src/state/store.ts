/**
 * A single central store holds application state. UI components subscribe to
 * it; they never hold authoritative state themselves (SPEC §5.1).
 *
 * Subscriptions are selector-based so that, for example, the status bar is not
 * woken by a theme change.
 */

export type Listener<T> = (value: T) => void;

export interface Store<S> {
  getState(): S;
  setState(updater: (prev: S) => S): void;
  subscribe<T>(selector: (state: S) => T, listener: Listener<T>): () => void;
}

/**
 * Subscriptions are stored with their generic erased. Each entry's selector and
 * listener agree on a type by construction in `subscribe`, but that pairing
 * cannot be expressed across a heterogeneous collection, so the value type is
 * narrowed to `unknown` here and restored by a cast at registration.
 */
interface Subscription<S> {
  select: (state: S) => unknown;
  notify: Listener<unknown>;
  last: unknown;
}

/**
 * `Object.is` first (cheap, and correct for primitives and stable object
 * identities); if that fails, fall back to one level of own-enumerable-key
 * comparison. The one-level depth is deliberate: a selector that builds a
 * fresh composite object each call (e.g. `{ line, col, words }`) would
 * otherwise notify on every `setState`, even when every field is identical,
 * because the object itself is always a new reference. Going any deeper would
 * let a selector hide unrelated nested state behind the same shallow check,
 * which defeats the point of selecting a narrow slice in the first place —
 * so nested objects are still compared by reference.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => Object.is(aRecord[key], bRecord[key]));
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const subscriptions = new Set<Subscription<S>>();

  return {
    getState: () => state,

    setState(updater) {
      state = updater(state);
      for (const subscription of subscriptions) {
        const next = subscription.select(state);
        if (isEqual(next, subscription.last)) continue;
        subscription.last = next;
        subscription.notify(next);
      }
    },

    subscribe<T>(selector: (state: S) => T, listener: Listener<T>) {
      const subscription: Subscription<S> = {
        select: selector,
        // Safe: `selector` and `listener` are paired on T by this signature.
        notify: listener as Listener<unknown>,
        last: selector(state),
      };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
  };
}
