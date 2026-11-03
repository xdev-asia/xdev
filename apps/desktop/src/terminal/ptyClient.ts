import type { Api, PtyInfo, PtyProfile } from "@/api";

/** Output is acknowledged in steps this big; Rust pauses a terminal at 4 MB unacknowledged. */
export const ACK_BYTES = 256 * 1024;

/** A channel message as bytes, whichever shape the IPC layer delivered it in. */
export function toBytes(msg: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return Uint8Array.from(msg);
}

/** One terminal tab's pty: input, size and flow control, without any view. */
export class PtyClient {
  private unacked = 0;
  private size: [number, number] | null = null;
  private readonly encoder = new TextEncoder();
  private started: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private live = false;

  constructor(
    private readonly api: Api,
    readonly id: string,
    /** An agent session id the pty continues (`--resume`); a restart of the client keeps it. */
    private readonly resume?: string,
  ) {}

  async start(
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: (bytes: Uint8Array, rendered: () => void) => void,
    account: string | null = null,
  ): Promise<PtyInfo> {
    const run = this.spawn(cwd, profileId, cols, rows, write, account);
    this.started = run.catch(() => {});
    return run;
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
    return info;
  }

  /** True once a pty was spawned, so its kill reports an exit. */
  get spawned(): boolean {
    return this.live;
  }

  private rendered(length: number): void {
    this.unacked += length;
    while (this.unacked >= ACK_BYTES) {
      this.unacked -= ACK_BYTES;
      // A failed ack means the pty is gone; its exit event says so.
      void this.api.ptyAck(this.id, ACK_BYTES).catch(() => {});
    }
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
    return this.started.then(() => this.api.ptyKill(this.id)).catch(() => {});
  }
}
