/** What a terminal that came back after its service died shows before its own output. */
export interface Prime {
  /** The output the old terminal had saved; null when none was. */
  bytes: Uint8Array | null;
  /** One dim line saying what happened, already translated. */
  note: string;
}

const primes = new Map<string, Prime>();

/** Holds `prime` for the terminal `ptyId` until its client takes it. */
export function setPrime(ptyId: string, prime: Prime): void {
  primes.set(ptyId, prime);
}

/** The prime of `ptyId`, once: a second call gets null. */
export function takePrime(ptyId: string): Prime | null {
  const prime = primes.get(ptyId) ?? null;
  primes.delete(ptyId);
  return prime;
}

/** The note as terminal bytes: dim, on its own line, then back to normal. */
export function noteBytes(note: string): Uint8Array {
  return new TextEncoder().encode(`\x1b[0m\x1b[2m${note}\x1b[0m\r\n`);
}
