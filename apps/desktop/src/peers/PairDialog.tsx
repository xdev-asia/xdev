import { Button, Checkbox, CodeInput, Dialog, EmptyState, Field, ListRow, PairingCode, Segmented, Tabs, groupCode } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api, JoinTarget, LinkBind, NearbyHost, PairOfferView, PairPending } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { codeText, errorText, formatCountdown } from "./peersModel";
import { SasCheck } from "./SasCheck";

const TICK_MS = 1000;
const BINDS: LinkBind[] = ["localhost", "lan", "tailscale"];

type JoinStep = { kind: "form" } | { kind: "sas"; pending: PairPending; answered: boolean } | { kind: "done"; name: string };

/** The code this computer shows and how long it holds; when the time is up, a New code button instead. */
export function HostCode(props: { t: (key: string, vars?: Record<string, string | number>) => string; code: string; remainingMs: number; onCopy(): void; onNew(): void }): JSX.Element {
  const { t } = props;
  if (props.remainingMs <= 0) {
    return (
      <>
        <p role="status">{t("peers.pair.expired")}</p>
        <div>
          <Button type="button" variant="secondary" onClick={props.onNew}>
            {t("peers.pair.newCode")}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p>{t("peers.pair.code")}</p>
      <PairingCode value={props.code} label={t("peers.pair.code")} copyLabel={t("peers.pair.copyLink")} onCopy={props.onCopy} />
      <p className="settings-hint" role="status">
        {t("peers.pair.expires", { time: formatCountdown(props.remainingMs) })}
      </p>
      <div>
        <Button type="button" variant="secondary" onClick={props.onCopy}>
          {t("peers.pair.copyLink")}
        </Button>
      </div>
    </>
  );
}

/** Pair a computer: show a code here, or join the code another computer shows. */
export function PairDialog(props: { api: Api; onClose(): void; onPaired(): void }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [tab, setTab] = useState<"host" | "join">("host");
  const [bind, setBind] = useState<LinkBind>("lan");
  const [offer, setOffer] = useState<PairOfferView | null>(null);
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [hostDone, setHostDone] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const [nearby, setNearby] = useState<NearbyHost[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [code, setCode] = useState("");
  const [grantBack, setGrantBack] = useState(false);
  const [step, setStep] = useState<JoinStep>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const joinName = useRef("");

  // The clock for the countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // An open offer on the Show a code tab; leaving the tab or the dialog cancels it.
  useEffect(() => {
    if (tab !== "host") return;
    let live = true;
    setOffer(null);
    setError(undefined);
    api
      .peerPairStart(bind)
      .then((o) => {
        if (live) setOffer(o);
      })
      .catch((e: unknown) => {
        if (live) setError(errorText(t, e));
      });
    return () => {
      live = false;
      void api.peerPairCancel().catch(() => {});
    };
    // `t` changes with the language only; a new code is not wanted then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tab, bind, nonce]);

  // Computers that show a pair dialog now.
  useEffect(() => {
    let live = true;
    api
      .peersNearby()
      .then((l) => {
        if (live) setNearby(l);
      })
      .catch(() => {});
    const off = api.onPeersNearby((l) => setNearby(l));
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [api]);

  // How a pairing ended, on either side.
  useEffect(() => {
    const off = api.onPeerPairResult((res) => {
      setBusy(false);
      if (res.ok) {
        const name = res.name ?? joinName.current;
        setHostDone(name);
        setStep({ kind: "done", name });
        props.onPaired();
      } else {
        setStep({ kind: "form" });
        setError(codeText(t, res.error ?? "other", res.name ?? joinName.current));
      }
    });
    return () => {
      void off.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const target = (): JoinTarget | null => (picked ? { kind: "nearby", hostId: picked } : link.trim() ? { kind: "link", link: link.trim() } : null);
  const ready = target() !== null && code.length === 10 && !busy;

  async function join(): Promise<void> {
    const to = target();
    if (!to) return;
    setBusy(true);
    setError(undefined);
    try {
      // The code goes as it is shown, in two groups: `7K4QM-2XD9P`.
      const pending = await api.peerPairJoin(to, groupCode(code, 5).join("-"), grantBack);
      joinName.current = pending.name;
      setStep({ kind: "sas", pending, answered: false });
    } catch (e) {
      setError(errorText(t, e, nearby.find((n) => n.hostId === picked)?.name ?? ""));
    } finally {
      setBusy(false);
    }
  }

  async function answer(pending: PairPending, accept: boolean): Promise<void> {
    if (accept) setStep({ kind: "sas", pending, answered: true });
    else setStep({ kind: "form" });
    try {
      await api.peerPairConfirm(pending.requestId, accept, grantBack ? "viewer" : "none");
    } catch (e) {
      setStep({ kind: "form" });
      setError(errorText(t, e, pending.name));
    }
  }

  function copyLink(): void {
    if (!offer) return;
    void navigator.clipboard.writeText(offer.link).then(() => pushToast({ text: t("peers.pair.linkCopied") }));
  }

  const remaining = offer ? offer.expiresAtMs - now : 0;

  // One primary per surface: the dialog's own button changes with the step.
  let confirmLabel = t("peers.pair.close");
  let cancelLabel: string | null = null;
  let confirmDisabled = false;
  let onConfirm = props.onClose;
  let onCancel = props.onClose;
  if (tab === "join" && step.kind === "form") {
    confirmLabel = t("peers.pair.join");
    cancelLabel = t("peers.pair.close");
    confirmDisabled = !ready;
    onConfirm = () => void join();
  } else if (tab === "join" && step.kind === "sas") {
    const { pending, answered } = step;
    confirmLabel = t("peers.pair.match");
    cancelLabel = t("peers.pair.noMatch");
    confirmDisabled = answered;
    onConfirm = () => void answer(pending, true);
    onCancel = () => void answer(pending, false);
  }

  return (
    <Dialog
      modal
      title={t("peers.pair.title")}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      confirmDisabled={confirmDisabled}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body="plain"
    >
      <div className="peers-pair" data-testid="pair-dialog">
        {step.kind !== "done" && !(tab === "join" && step.kind === "sas") && (
          <Tabs
            label={t("peers.pair.title")}
            idPrefix="peers-pair"
            value={tab}
            onChange={(id) => {
              setTab(id as "host" | "join");
              setError(undefined);
            }}
            items={[
              { id: "host", label: t("peers.pair.tab.host") },
              { id: "join", label: t("peers.pair.tab.join") },
            ]}
          />
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {tab === "host" && (
          <div role="tabpanel" id="peers-pair-panel-host" aria-labelledby="peers-pair-tab-host" className="peers-pair">
            {hostDone !== null ? (
              <p role="status">{t("peers.pair.done", { name: hostDone })}</p>
            ) : (
              <>
                <Segmented
                  label={t("peers.network")}
                  options={BINDS.map((b) => ({ value: b, label: t(`peers.network.${b}`) }))}
                  value={bind}
                  onChange={(v) => setBind(v as LinkBind)}
                />
                {offer && <HostCode t={t} code={offer.code} remainingMs={remaining} onCopy={copyLink} onNew={() => setNonce(nonce + 1)} />}
              </>
            )}
          </div>
        )}
        {tab === "join" && step.kind === "form" && (
          <div role="tabpanel" id="peers-pair-panel-join" aria-labelledby="peers-pair-tab-join" className="peers-pair">
            <p>{t("peers.pair.nearby")}</p>
            {nearby.filter((n) => n.pairing).length === 0 ? (
              <EmptyState title={t("peers.pair.nearbyEmpty")} />
            ) : (
              <ul className="settings-list">
                {nearby
                  .filter((n) => n.pairing)
                  .map((n) => (
                    <ListRow
                      key={n.hostId}
                      as="li"
                      title={n.name ?? n.hostId}
                      selected={picked === n.hostId}
                      onClick={() => setPicked(picked === n.hostId ? null : n.hostId)}
                    />
                  ))}
              </ul>
            )}
            <Field label={t("peers.pair.pasteLink")} value={link} autoComplete="off" onChange={(e) => setLink(e.target.value)} />
            <CodeInput
              length={10}
              groupSize={5}
              value={code}
              onChange={setCode}
              label={t("peers.pair.codeLabel")}
              invalid={error !== undefined}
            />
            <Checkbox
              label={t("peers.pair.grantBack", { name: nearby.find((n) => n.hostId === picked)?.name ?? t("peers.pair.otherComputer") })}
              checked={grantBack}
              onChange={(e) => setGrantBack(e.target.checked)}
            />
          </div>
        )}
        {tab === "join" && step.kind === "sas" && <SasCheck sas={step.pending.sas} name={step.pending.name} waiting={step.answered} />}
        {tab === "join" && step.kind === "done" && <p role="status">{t("peers.pair.done", { name: step.name })}</p>}
      </div>
    </Dialog>
  );
}
