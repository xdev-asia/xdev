import type { Api, PtyAttached, PtyInfo, PtyProfile } from "@/api";

/** Output is acknowledged in steps this big; Rust pauses a terminal at 4 MB unacknowledged. */
export const ACK_BYTES = 256 * 1024;

/** A channel message as bytes, whichever shape the IPC layer delivered it in. */
export function toBytes(msg: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return Uint8Array.from(msg);
}

type Write = (bytes: Uint8Array, rendered: () => void) => void;

/** Lines the client writes itself, in the UI's language. */
export interface PtyNotes {
  /** Before the replay of an attach whose ring had dropped output. */
  truncated?: string;
}

/** One terminal tab's pty: input, size and flow control, without any view. */
export class PtyClient {
  private unacked = 0;
  private size: [number, number] | null = null;
  private readonly encoder = new TextEncoder();
  private started: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private live = false;
  /** Typed once the pty exists; a tab that is not on screen has none yet. */
  private queued: string[] = [];
  // Output drawn so far, counted from the pty's first byte; an attach starts at its seq.
  private drawn = 0;
  // Set by `attach`: a later `start` binds the view to it instead of spawning.
  private attached: { info: PtyInfo; truncated: boolean; noted: boolean } | null = null;
  // Where output goes; until a view is there, it waits in `pending`.
  private sink: Write | null = null;
  private pending: Uint8Array[] = [];
  // While an attach waits for its reply: output can come first, and the truncated line goes before it.
  private holding = false;
  // Set by `attachOnStart`: the seq a later `start` attaches from instead of spawning.
  private attachFrom: number | null = null;

  constructor(
    private readonly api: Api,
    readonly id: string,
    /** An agent session id the pty continues (`--resume`); a restart of the client keeps it. */
    private readonly resume?: string,
  ) {}

  /**
   * Starts the pty, or, after `attach`, binds `write` to the attached one: what arrived meanwhile is
   * written first, and the size is nudged so a full-screen program redraws.
   */
  async start(
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: Write,
    account: string | null = null,
    notes: PtyNotes = {},
  ): Promise<PtyInfo> {
    if (!this.attached && this.attachFrom !== null) {
      // A failed attach is the start's failure; a later start tries again, it never spawns.
      await this.attach(this.attachFrom);
      this.attachFrom = null;
    }
    if (this.attached) return this.bind(cols, rows, write, notes);
    const run = this.spawn(cwd, profileId, cols, rows, write, account);
    this.started = run.catch(() => {});
    return run;
  }

  /**
   * Takes over the terminal service's pty with this id, its output from byte `fromSeq` on. Without
   * `write` the output waits for `start`. Rejects with `pty_gone` when the service does not hold it.
   */
  async attach(fromSeq: number, write?: Write, notes: PtyNotes = {}): Promise<PtyAttached> {
    if (this.disposed) throw new Error("disposed");
    if (write) this.sink = write;
    this.holding = true;
    const run = this.api.ptyAttach(this.id, fromSeq, (bytes) => this.deliver(bytes));
    this.started = run.catch(() => {});
    let got: PtyAttached;
    try {
      got = await run;
    } catch (e) {
      this.holding = false;
      this.pending = [];
      throw e;
    }
    this.holding = false;
    this.drawn = got.seq;
    this.live = true;
    for (const text of this.queued.splice(0)) void this.input(text).catch(() => {});
    this.attached = { info: got.info, truncated: got.truncated, noted: false };
    this.note(notes);
    this.flush();
    return got;
  }

  /**
   * For an attach that failed for a reason other than `pty_gone` (the service busy, restarting):
   * `start` attaches from `fromSeq` instead of spawning, so the tab never starts a second pty.
   */
  attachOnStart(fromSeq: number): void {
    this.attachFrom = fromSeq;
    this.drawn = fromSeq;
  }

  /** Output bytes drawn so far, counted from the pty's first byte: where a later attach replays from. */
  get seq(): number {
    return this.drawn;
  }

  private bind(cols: number, rows: number, write: Write, notes: PtyNotes): PtyInfo {
    const { info } = this.attached!;
    this.sink = write;
    this.note(notes);
    this.flush();
    this.size = [cols, rows];
    void this.api
      .ptyResize(this.id, Math.max(1, cols - 1), rows)
      .then(() => this.api.ptyResize(this.id, cols, rows))
      .catch(() => {});
    return info;
  }

  /** The truncated line, once, before any replayed byte; it is not the pty's, so it is never acked. */
  private note(notes: PtyNotes): void {
    const a = this.attached;
    if (!a || a.noted || !this.sink) return;
    a.noted = true;
    if (a.truncated && notes.truncated) this.sink(this.encoder.encode(`${notes.truncated}\r\n`), () => {});
  }

  private deliver(bytes: Uint8Array): void {
    if (!this.sink || this.holding) this.pending.push(bytes);
    else this.sink(bytes, () => this.rendered(bytes.length));
  }

  private flush(): void {
    for (const bytes of this.pending.splice(0)) this.deliver(bytes);
  }

  private async spawn(
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: (bytes: Uint8Array, rendered: () => void) => void,
    account: string | null,
  ): Promise<PtyInfo> {
    // A view that mounts and unmounts in one tick (StrictMode in dev) never starts a pty.
    await Promise.resolve();
    if (this.disposed) throw new Error("disposed");
    const info = await this.api.ptySpawn(this.id, cwd, profileId, account, cols, rows, (bytes) =>
      // Acked once the terminal has drawn it, so a slow view pauses the pty.
      write(bytes, () => this.rendered(bytes.length)),
      this.resume,
    );
    this.size = [cols, rows];
    this.live = true;
    for (const text of this.queued.splice(0)) void this.input(text).catch(() => {});
    return info;
  }

  /** True once a pty was spawned, so its kill reports an exit. */
  get spawned(): boolean {
    return this.live;
  }

  private rendered(length: number): void {
    this.drawn += length;
    this.unacked += length;
    while (this.unacked >= ACK_BYTES) {
      this.unacked -= ACK_BYTES;
      // A failed ack means the pty is gone; its exit event says so.
      void this.api.ptyAck(this.id, ACK_BYTES).catch(() => {});
    }
  }

  /** `input` now when the pty is running, else as soon as it has started. */
  typeWhenReady(text: string): void {
    if (this.live) void this.input(text).catch(() => {});
    else this.queued.push(text);
  }

  input(text: string): Promise<void> {
    return this.api.ptyWrite(this.id, this.encoder.encode(text));
  }

  /** A resize to the size it has is dropped, unless `force` (Reset Terminal asks the program to redraw). */
  async resize(cols: number, rows: number, force = false): Promise<void> {
    if (!force && this.size?.[0] === cols && this.size[1] === rows) return;
    this.size = [cols, rows];
    await this.api.ptyResize(this.id, cols, rows);
  }

  /** Kills the pty, after a spawn still in flight has landed. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.queued = [];
    return this.started.then(() => this.api.ptyKill(this.id)).catch(() => {});
  }
}
