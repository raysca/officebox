import { vi } from "vitest";

type Listener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  media: string;
  matches: boolean;
  listeners: Set<Listener>;
}

/**
 * A drivable matchMedia for jsdom, which has none. Every query starts as not matching (light, narrow
 * screen, motion allowed); `setMediaQuery` flips one and notifies its listeners.
 */
const lists: FakeMediaQueryList[] = [];
const overrides = new Map<string, boolean>();

export function installMatchMedia() {
  lists.length = 0;
  overrides.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => {
      const list: FakeMediaQueryList = { media, matches: overrides.get(media) ?? false, listeners: new Set() };
      lists.push(list);
      return {
        get matches() {
          return list.matches;
        },
        media,
        onchange: null,
        addEventListener: (_type: "change", listener: Listener) => list.listeners.add(listener),
        removeEventListener: (_type: "change", listener: Listener) => list.listeners.delete(listener),
        addListener: (listener: Listener) => list.listeners.add(listener),
        removeListener: (listener: Listener) => list.listeners.delete(listener),
        dispatchEvent: () => false,
      };
    }),
  );
}

/** Sets whether `media` matches, for existing and future lists, and fires their change listeners. */
export function setMediaQuery(media: string, matches: boolean) {
  overrides.set(media, matches);
  for (const list of lists) {
    if (list.media !== media || list.matches === matches) continue;
    list.matches = matches;
    for (const listener of list.listeners) listener({ matches, media } as MediaQueryListEvent);
  }
}
