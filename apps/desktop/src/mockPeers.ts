import type {
  Api,
  ApiError,
  NearbyHost,
  PairOfferView,
  PeerActivity,
  PeerConfirm,
  PeerPairRequest,
  PeerPairResult,
  PeerProject,
  PeerRole,
  PeersState,
  PeerTerm,
  PeerTermClosed,
  PeerView,
} from "./api";

type PeersApi = Pick<
  Api,
  | "peersState"
  | "peersSetEnabled"
  | "peersList"
  | "peersNearby"
  | "peerPairStart"
  | "peerPairCancel"
  | "peerPairJoin"
  | "peerPairConfirm"
  | "peerSetRole"
  | "peerRename"
  | "peerRemove"
  | "peerProjects"
  | "peerTerms"
  | "peerTermAttach"
  | "peerTermDetach"
  | "peerTermWrite"
  | "peerAgentStart"
  | "peerConfirmReply"
  | "onPeersChanged"
  | "onPeersNearby"
  | "onPeerPairRequest"
  | "onPeerPairResult"
  | "onPeerActivity"
  | "onPeerConfirm"
  | "onPeerTermClosed"
>;

export type MockPeers = PeersApi & {
  /** Another computer joins this one's open offer: emits `peers://pair-request` and resolves with its request id. */
  __peersPairRequest(name?: string): Promise<string>;
  /** The link to `peerId` drops: it goes offline, its attached terminals close, `peers://changed` fires. */
  __peersDrop(peerId: string): void;
  /** A paired computer acts here: emits `peers://activity`. */
  __peersActivity(ev?: Partial<PeerActivity>): void;
  /** A paired computer asks before acting here: emits `peers://confirm` and resolves with its request id. */
  __peersConfirm(ev?: Partial<Omit<PeerConfirm, "requestId">>): Promise<string>;
};

/** The code `build-box` shows; joining it with this code pairs. */
export const MOCK_PAIR_CODE = "7K4QM-2XD9P";
/** The SAS both screens show while pairing with `build-box`. */
export const MOCK_PAIR_SAS = "482 913";
/** How often an attached terminal gets a line, and how long the other side takes to confirm. */
const LINE_MS = 500;
const CONFIRM_MS = 300;

const RANK: Record<PeerRole, number> = { none: 0, viewer: 1, operator: 2, admin: 3 };

function reject(code: ApiError["code"]): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

type Listeners<T> = Set<(v: T) => void>;

function emitTo<T>(set: Listeners<T>, v: T) {
  for (const cb of set) cb(structuredClone(v));
}

function on<T>(set: Listeners<T>, cb: (v: T) => void): Promise<() => void> {
  set.add(cb);
  return Promise.resolve(() => void set.delete(cb));
}

/** Paired computers in memory: this one is `this-pc`; `studio-mac` is paired and online; `build-box` is nearby and pairing. */
export function createMockPeers(): MockPeers {
  const enc = new TextEncoder();
  let seq = 0;
  const next = (prefix: string) => `${prefix}-${++seq}`;
  let state: PeersState = {
    enabled: true,
    bind: "lan",
    port: 47821,
    hostId: "this-pc",
    hostName: "this-pc",
    fingerprint: "K4QM-2XD9-P7HR-W3TB",
    pairing: false,
  };
  const peers: PeerView[] = [
    // We are Operator on studio-mac; it is Viewer here.
    { id: "studio-mac", name: "studio-mac", kind: "desktop", role: "viewer", theirRole: "operator", online: true, lastSeenMs: Date.now(), sameXdevId: true },
  ];
  const nearby: NearbyHost[] = [
    { hostId: "studio-mac", name: null, pairing: false, paired: true },
    { hostId: "build-box", name: "build-box", pairing: true, paired: false },
  ];
  const projects: Record<string, PeerProject[]> = {
    "studio-mac": [{ id: "app", name: "app", path: null }],
    "build-box": [{ id: "api", name: "api", path: null }],
  };
  const terms: Record<string, PeerTerm[]> = {
    "studio-mac": [
      { id: "review", title: "review", agent: "reviewer", state: "idle", projectId: "app" },
      { id: "shell", title: "shell", agent: null, state: "running", projectId: "app" },
    ],
    "build-box": [],
  };
  // Pairing this computer started as a joiner, by request id.
  const joins = new Map<string, { hostId: string; grantBack: boolean }>();
  // Pairing requests other computers made to this one's offer.
  const requests = new Map<string, PeerPairRequest>();
  const confirms = new Set<string>();
  const streams = new Map<string, { timer: ReturnType<typeof setInterval>; onData: (b: Uint8Array) => void }>();
  let offer: PairOfferView | null = null;

  const changed: Listeners<PeersState> = new Set();
  const nearbyCbs: Listeners<NearbyHost[]> = new Set();
  const pairRequest: Listeners<PeerPairRequest> = new Set();
  const pairResult: Listeners<PeerPairResult> = new Set();
  const activity: Listeners<PeerActivity> = new Set();
  const confirm: Listeners<PeerConfirm> = new Set();
  const termClosed: Listeners<PeerTermClosed> = new Set();

  const emitChanged = () => emitTo(changed, state);
  const emitNearby = () => emitTo(nearbyCbs, nearby);
  const find = (id: string) => peers.find((p) => p.id === id);
  const key = (peerId: string, termId: string) => `${peerId}\u0000${termId}`;

  /** The peer, when it is online and gave us at least `need`. */
  function reach(peerId: string, need: PeerRole): PeerView | ApiError["code"] {
    const p = find(peerId);
    if (!p) return "not_found";
    if (!p.online) return "peer_offline";
    if (RANK[p.theirRole ?? "none"] < RANK[need]) return "peer_role";
    return p;
  }

  function stop(peerId: string, termId: string, reason: string | null) {
    const k = key(peerId, termId);
    const s = streams.get(k);
    if (!s) return;
    clearInterval(s.timer);
    streams.delete(k);
    if (reason) emitTo(termClosed, { peerId, termId, reason });
  }

  function addPeer(p: PeerView) {
    const at = peers.findIndex((x) => x.id === p.id);
    if (at >= 0) peers[at] = p;
    else peers.push(p);
    projects[p.id] ??= [];
    terms[p.id] ??= [];
  }

  return {
    async peersState() {
      return structuredClone(state);
    },
    async peersSetEnabled(on) {
      state = on
        ? { ...state, enabled: true, port: state.port ?? 47821 }
        : { ...state, enabled: false, port: null, pairing: false };
      if (!on) offer = null;
      emitChanged();
      return structuredClone(state);
    },
    async peersList() {
      return structuredClone(peers);
    },
    async peersNearby() {
      return structuredClone(nearby);
    },
    async peerPairStart(bind) {
      state = { ...state, enabled: true, bind, port: state.port ?? 47821, pairing: true };
      const host = bind === "localhost" ? "127.0.0.1" : bind === "tailscale" ? "100.101.7.12" : "192.168.1.20";
      offer = {
        code: "H3RW8-5MNTA",
        link: "xdev://pair?d=bW9jay1vZmZlcg",
        expiresAtMs: Date.now() + 5 * 60_000,
        candidates: [`${host}:${state.port}`],
      };
      emitChanged();
      return structuredClone(offer);
    },
    async peerPairCancel() {
      offer = null;
      requests.clear();
      if (!state.pairing) return;
      state = { ...state, pairing: false };
      emitChanged();
    },
    async peerPairJoin(target, code, grantBack) {
      const hostId = target.kind === "nearby" ? target.hostId : target.link.startsWith("xdev://pair?") ? "build-box" : null;
      if (hostId === null) return reject("bad_arg");
      const host = nearby.find((n) => n.hostId === hostId);
      if (!host) return reject("peer_offline");
      if (!host.pairing) return reject("pair_busy");
      if (code.trim().toUpperCase() !== MOCK_PAIR_CODE) return reject("pair_code");
      const requestId = next("join");
      joins.set(requestId, { hostId, grantBack });
      return { requestId, sas: MOCK_PAIR_SAS, name: host.name ?? hostId };
    },
    async peerPairConfirm(requestId, accept, role) {
      const join = joins.get(requestId);
      if (join) {
        joins.delete(requestId);
        const name = nearby.find((n) => n.hostId === join.hostId)?.name ?? join.hostId;
        // The host confirms on its side after a moment.
        setTimeout(() => {
          if (!accept) {
            emitTo(pairResult, { ok: false, name, error: "pair_rejected" });
            return;
          }
          addPeer({
            id: join.hostId,
            name,
            kind: "desktop",
            role: join.grantBack ? role : "none",
            theirRole: "operator",
            online: true,
            lastSeenMs: Date.now(),
            sameXdevId: false,
          });
          const n = nearby.find((x) => x.hostId === join.hostId);
          if (n) Object.assign(n, { pairing: false, paired: true, name: null });
          emitTo(pairResult, { ok: true, name, error: null });
          emitChanged();
          emitNearby();
        }, CONFIRM_MS);
        return;
      }
      const req = requests.get(requestId);
      if (!req) return reject("not_found");
      requests.delete(requestId);
      if (!accept) {
        emitTo(pairResult, { ok: false, name: req.name, error: "pair_rejected" });
        return;
      }
      // The offer is single use.
      offer = null;
      state = { ...state, pairing: false };
      addPeer({ id: next("peer"), name: req.name, kind: req.kind, role, theirRole: null, online: true, lastSeenMs: Date.now(), sameXdevId: false });
      emitTo(pairResult, { ok: true, name: req.name, error: null });
      emitChanged();
    },
    async peerSetRole(peerId, role) {
      const p = find(peerId);
      if (!p) return reject("not_found");
      p.role = role;
      emitChanged();
      return structuredClone(p);
    },
    async peerRename(peerId, name) {
      const p = find(peerId);
      if (!p) return reject("not_found");
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 64) return reject("bad_name");
      p.name = trimmed;
      emitChanged();
      return structuredClone(p);
    },
    async peerRemove(peerId) {
      const at = peers.findIndex((p) => p.id === peerId);
      if (at < 0) return reject("not_found");
      for (const t of terms[peerId] ?? []) stop(peerId, t.id, "removed");
      peers.splice(at, 1);
      const n = nearby.find((x) => x.hostId === peerId);
      if (n) n.paired = false;
      emitChanged();
    },
    async peerProjects(peerId) {
      const p = reach(peerId, "viewer");
      if (typeof p === "string") return reject(p);
      return structuredClone(projects[peerId] ?? []);
    },
    async peerTerms(peerId) {
      const p = reach(peerId, "viewer");
      if (typeof p === "string") return reject(p);
      return structuredClone(terms[peerId] ?? []);
    },
    async peerTermAttach(peerId, termId, onData) {
      const p = reach(peerId, "viewer");
      if (typeof p === "string") return reject(p);
      const term = terms[peerId]?.find((t) => t.id === termId);
      if (!term) return reject("not_found");
      stop(peerId, termId, null);
      let n = 0;
      const timer = setInterval(() => onData(enc.encode(`${term.title} on ${p.name}: line ${++n}\r\n`)), LINE_MS);
      streams.set(key(peerId, termId), { timer, onData });
      onData(enc.encode(`\x1b[2m${term.title} on ${p.name}\x1b[0m\r\n`));
      return { cols: 100, rows: 30 };
    },
    async peerTermDetach(peerId, termId) {
      stop(peerId, termId, null);
    },
    async peerTermWrite(peerId, termId, data) {
      const p = reach(peerId, "operator");
      if (typeof p === "string") return reject(p);
      if (!terms[peerId]?.some((t) => t.id === termId)) return reject("not_found");
      // The remote terminal echoes what was typed.
      streams.get(key(peerId, termId))?.onData(new Uint8Array(data));
      emitTo(activity, { peer: state.hostName, action: "typed", target: termId });
    },
    async peerAgentStart(peerId, projectId, profileId, prompt) {
      const p = reach(peerId, "operator");
      if (typeof p === "string") return reject(p);
      if (!projects[peerId]?.some((x) => x.id === projectId)) return reject("not_found");
      const term: PeerTerm = { id: next("term"), title: prompt ? prompt.slice(0, 32) : profileId, agent: profileId, state: "running", projectId };
      (terms[peerId] ??= []).push(term);
      return structuredClone(term);
    },
    async peerConfirmReply(requestId) {
      if (!confirms.delete(requestId)) return reject("not_found");
    },
    onPeersChanged: (cb) => on(changed, cb),
    onPeersNearby: (cb) => on(nearbyCbs, cb),
    onPeerPairRequest: (cb) => on(pairRequest, cb),
    onPeerPairResult: (cb) => on(pairResult, cb),
    onPeerActivity: (cb) => on(activity, cb),
    onPeerConfirm: (cb) => on(confirm, cb),
    onPeerTermClosed: (cb) => on(termClosed, cb),
    async __peersPairRequest(name = "dev-laptop") {
      if (!state.pairing || !offer) throw new Error("no open offer");
      const req: PeerPairRequest = { requestId: next("pair"), name, kind: "desktop", sas: "271 604" };
      requests.set(req.requestId, req);
      emitTo(pairRequest, req);
      return req.requestId;
    },
    __peersDrop(peerId) {
      const p = find(peerId);
      if (!p) return;
      for (const t of terms[peerId] ?? []) stop(peerId, t.id, "offline");
      p.online = false;
      p.lastSeenMs = Date.now();
      emitChanged();
    },
    __peersActivity(ev) {
      emitTo(activity, { peer: "studio-mac", action: "typed", target: "review", ...ev });
    },
    async __peersConfirm(ev) {
      const req: PeerConfirm = { requestId: next("confirm"), peer: "studio-mac", action: "start an agent", target: "app", ...ev };
      confirms.add(req.requestId);
      emitTo(confirm, req);
      return req.requestId;
    },
  };
}
