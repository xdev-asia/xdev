import type { Api, PtyInfo } from "@/api";
import type { PtyClient } from "@/terminal/ptyClient";

type Write = (bytes: Uint8Array, rendered: () => void) => void;

const INFO = (id: string): PtyInfo => ({
  id,
  pid: null,
  program: "remote",
  agent: false,
  profile: "shell",
  permissions: "default",
  account: null,
  accountSource: null,
  hooks: false,
  hookEvents: [],
  cli: null,
  promptAfter: null,
});

/**
 * The part of `PtyClient` the xterm view calls, over a terminal of another computer: output comes from
 * `peerTermAttach`, input goes to `peerTermWrite` only while `controlling` is true, and a resize is not sent.
 */
export class PeerTermClient {
  controlling = false;
  private write: Write | null = null;
  private disposed = false;
  readonly id: string;

  constructor(
    private readonly api: Pick<Api, "peerTermAttach" | "peerTermDetach" | "peerTermWrite">,
    private readonly peerId: string,
    private readonly termId: string,
  ) {
    this.id = `peer:${peerId}:${termId}`;
  }

  get spawned(): boolean {
    return false;
  }

  async start(_cwd: string, _profile: string, _cols: number, _rows: number, write: Write): Promise<PtyInfo> {
    this.write = write;
    await this.attach();
    return INFO(this.id);
  }

  /** Attaches again after the link dropped; the caller clears the screen first. */
  async attach(): Promise<void> {
    if (this.disposed) throw new Error("disposed");
    await this.api.peerTermAttach(this.peerId, this.termId, (bytes) => this.write?.(bytes, () => {}));
  }

  async input(text: string): Promise<void> {
    if (!this.controlling || this.disposed) return;
    await this.api.peerTermWrite(this.peerId, this.termId, new TextEncoder().encode(text));
  }

  async resize(): Promise<void> {}

  /** A mount that was undone and done again (StrictMode) uses the same client: it is live once more. */
  revive(): void {
    this.disposed = false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.api.peerTermDetach(this.peerId, this.termId).catch(() => {});
  }

  /** The xterm view takes this as its client. */
  asPty(): PtyClient {
    return this as unknown as PtyClient;
  }
}
