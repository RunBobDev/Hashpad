import { describe, expect, it, vi } from 'vitest';
import { createStore } from './store';

interface TestState {
  count: number;
  label: string;
}

const initial: TestState = { count: 0, label: 'a' };

describe('createStore', () => {
  it('returns the initial state', () => {
    const store = createStore(initial);
    expect(store.getState()).toEqual({ count: 0, label: 'a' });
  });

  it('replaces state through the updater', () => {
    const store = createStore(initial);
    store.setState((prev) => ({ ...prev, count: 1 }));
    expect(store.getState().count).toBe(1);
  });

  it('notifies a subscriber when its selected slice changes', () => {
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe((s) => s.count, listener);

    store.setState((prev) => ({ ...prev, count: 5 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(5);
  });

  it('does not notify a subscriber when an unrelated slice changes', () => {
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe((s) => s.count, listener);

    store.setState((prev) => ({ ...prev, label: 'b' }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not notify when the selected slice is set to an equal value', () => {
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe((s) => s.count, listener);

    store.setState((prev) => ({ ...prev, count: 0 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore(initial);
    const listener = vi.fn();
    const unsubscribe = store.subscribe((s) => s.count, listener);

    unsubscribe();
    store.setState((prev) => ({ ...prev, count: 9 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('gives each subscriber its own slice', () => {
    const store = createStore(initial);
    const onCount = vi.fn();
    const onLabel = vi.fn();
    store.subscribe((s) => s.count, onCount);
    store.subscribe((s) => s.label, onLabel);

    store.setState((prev) => ({ ...prev, label: 'z' }));

    expect(onCount).not.toHaveBeenCalled();
    expect(onLabel).toHaveBeenCalledWith('z');
  });
});
