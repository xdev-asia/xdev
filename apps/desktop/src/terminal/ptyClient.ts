import type { Api, PtyInfo, PtyProfile } from "../api";

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

  constructor(
    private readonly api: Api,
    readonly id: string,
  ) {}

  async start(
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: (bytes: Uint8Array) => void,
  ): Promise<PtyInfo> {
    const info = await this.api.ptySpawn(this.id, cwd, profileId, cols, rows, (bytes) => {
      write(bytes);
      this.unacked += bytes.length;
      while (this.unacked >= ACK_BYTES) {
        this.unacked -= ACK_BYTES;
        // A failed ack means the pty is gone; its exit event says so.
        void this.api.ptyAck(this.id, ACK_BYTES).catch(() => {});
      }
    });
    this.size = [cols, rows];
    return info;
  }

  input(text: string): Promise<void> {
    return this.api.ptyWrite(this.id, this.encoder.encode(text));
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.size?.[0] === cols && this.size[1] === rows) return;
    this.size = [cols, rows];
    await this.api.ptyResize(this.id, cols, rows);
  }

  dispose(): void {
    void this.api.ptyKill(this.id);
  }
}
