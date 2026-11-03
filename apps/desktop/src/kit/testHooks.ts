import type { ReactElement } from "react";

/**
 * A small stand-in for React's hooks, so a component's function can be called directly and its
 * element tree read, without a DOM. State lives in `values`, in call order, and is kept between
 * draws; effects are collected and run by hand. Only active between `draw` and its return.
 */
export const hooks = { active: false, values: [] as unknown[], cursor: 0, effects: [] as Array<{ run: () => void | (() => void); deps?: unknown[]; at: number }>, seen: [] as Array<unknown[] | undefined> };

export function patchReact(react: typeof import("react")): typeof import("react") {
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return index;
  };
  return {
    ...react,
    useState: ((initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const index = slot(initial);
      const set = (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? (value as (v: unknown) => unknown)(hooks.values[index]) : value;
      };
      return [hooks.values[index], set];
    }) as typeof react.useState,
    useRef: ((initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const index = slot({ current: initial });
      return hooks.values[index];
    }) as typeof react.useRef,
    useMemo: ((make: () => unknown, deps: unknown[]) => (hooks.active ? make() : react.useMemo(make, deps))) as typeof react.useMemo,
    useCallback: ((fn: unknown, deps: unknown[]) => (hooks.active ? fn : react.useCallback(fn as () => void, deps))) as typeof react.useCallback,
    useEffect: ((effect: () => void | (() => void), deps?: unknown[]) =>
      hooks.active ? void hooks.effects.push({ run: effect, deps, at: hooks.effects.length }) : react.useEffect(effect, deps)) as typeof react.useEffect,
  };
}

export type Node = ReactElement<Record<string, any>>;

export function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

export const textOf = (node: Node): string =>
  nodes(node.props.children)
    .map((n) => (typeof n.props.children === "string" ? n.props.children : ""))
    .join("") + (typeof node.props.children === "string" ? node.props.children : "");

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A mounted component: `draw()` calls it again with the state it kept. */
export function mount<P>(component: (props: P) => ReactElement, props: () => P) {
  hooks.values = [];
  hooks.seen = [];
  hooks.cursor = 0;
  hooks.effects = [];
  const draw = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.active = true;
    try {
      return component(props());
    } finally {
      hooks.active = false;
    }
  };
  const view = {
    draw,
    all: () => nodes(draw()),
    /** Draws, runs the effects of that draw, waits for what they started, and returns the tree of the next draw. */
    async settle() {
      draw();
      for (const effect of hooks.effects) {
        const before = hooks.seen[effect.at];
        const same = effect.deps !== undefined && before !== undefined && effect.deps.length === before.length && effect.deps.every((d, i) => Object.is(d, before[i]));
        hooks.seen[effect.at] = effect.deps ?? [];
        if (!same) effect.run();
      }
      await tick();
      return nodes(draw());
    },
  };
  return view;
}
