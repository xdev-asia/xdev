// A document with a `<head>` of style elements, and a localStorage, for tests that run without a DOM.

export type FakeEl = { id: string; textContent: string; remove(): void };

export function fakeDocument() {
  const children: FakeEl[] = [];
  const make = (): FakeEl => {
    const el: FakeEl = {
      id: "",
      textContent: "",
      remove: () => {
        const i = children.indexOf(el);
        if (i >= 0) children.splice(i, 1);
      },
    };
    return el;
  };
  return {
    head: {
      appendChild(el: FakeEl) {
        el.remove();
        children.push(el);
        return el;
      },
    },
    getElementById: (id: string) => children.find((c) => c.id === id) ?? null,
    createElement: () => make(),
    count: (id: string) => children.filter((c) => c.id === id).length,
  };
}

export function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}
