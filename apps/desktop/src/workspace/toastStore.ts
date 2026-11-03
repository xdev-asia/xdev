// The toast stack: what is shown, newest last. One copy for the window; `Toasts.tsx` draws it.

export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  id: string;
  text: string;
  actions: ToastAction[];
}

export interface ToastInput {
  /** Pushing the same id again replaces that toast in place. */
  id?: string;
  text: string;
  actions?: ToastAction[];
  /** Gone after this long; default 8 s, 0 stays until closed. */
  ttlMs?: number;
}

export const MAX_TOASTS = 3;
export const DEFAULT_TTL_MS = 8000;

let toasts: Toast[] = [];
let seq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function clear(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Shows a toast; returns its id. The oldest goes when more than three would show. */
export function pushToast(input: ToastInput): string {
  const id = input.id ?? `toast-${++seq}`;
  const toast: Toast = { id, text: input.text, actions: input.actions ?? [] };
  clear(id);
  const at = toasts.findIndex((t) => t.id === id);
  const next = at >= 0 ? toasts.map((t, i) => (i === at ? toast : t)) : [...toasts, toast];
  for (const gone of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) clear(gone.id);
  toasts = next.slice(-MAX_TOASTS);
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  if (ttl > 0) timers.set(id, setTimeout(() => dismissToast(id), ttl));
  emit();
  return id;
}

export function dismissToast(id: string): void {
  clear(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Tests only. */
export function resetToastsForTests(): void {
  for (const id of [...timers.keys()]) clear(id);
  toasts = [];
  seq = 0;
  listeners.clear();
}
