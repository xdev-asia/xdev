import { Button, Card, Dialog } from "@xdev-asia/ui";
import { useEffect } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { claimInterruption } from "@/onboarding/interruptions";
import { SETTLE_MS } from "@/tips/tipsModel";
import { releasesFor, wallStart } from "./featureWallModel";
import { closeFeatureWall, openFeatureWall, rememberWallVersion, setWallVersion, tryFeature, useWallState } from "./featureWallStore";
import { RELEASES, type FeatureTarget, type Release } from "./releases";

/** The wall: the cards of each release, newest first. One primary button (Close); "Try it" is quiet and opens the feature. */
export function FeatureWallView(props: { releases: readonly Release[]; onTry(target: FeatureTarget): void; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog modal title={t("wall.title")} cancelLabel={null} confirmLabel={t("wall.close")} onConfirm={props.onClose} onCancel={props.onClose} body="plain">
      {props.releases.map((release) => (
        <section key={release.version} className="wall-release" aria-label={t("wall.release", { version: release.version })}>
          <h3 className="wall-version">{t("wall.release", { version: release.version })}</h3>
          {release.cards.map((card) => {
            const target = card.tryIt;
            return (
              <Card
                key={card.id}
                title={t(card.titleKey)}
                actions={
                  target ? (
                    <Button type="button" variant="secondary" onClick={() => props.onTry(target)}>
                      {t("wall.try")}
                    </Button>
                  ) : undefined
                }
              >
                <p className="wall-text">{t(card.bodyKey)}</p>
              </Card>
            );
          })}
        </section>
      ))}
    </Dialog>
  );
}

/**
 * Reads the running version, remembers it on a first run (`firstRun`: the wizard has the screen), and opens the wall once
 * after the start settles when an update brought cards that were not seen. The Help menu opens it at any time.
 */
export function FeatureWallHost(props: { api: Pick<Api, "appVersion">; firstRun: boolean }): JSX.Element | null {
  const { api, firstRun } = props;
  const wall = useWallState();

  useEffect(() => {
    let live = true;
    api.appVersion().then(
      (v) => live && setWallVersion(v),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const version = wall.appVersion;
  const start = version === null ? "none" : wallStart({ releases: RELEASES, appVersion: version, seen: wall.seen, firstRun });
  useEffect(() => {
    if (version === null) return;
    if (start === "remember") return rememberWallVersion(version);
    if (start !== "open" || firstRun) return;
    const timer = setTimeout(() => {
      // One interruption per launch: a tour or a tip that came first keeps the wall for the next start.
      if (claimInterruption("wall")) openFeatureWall();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [version, start, firstRun]);

  if (!wall.open || version === null) return null;
  return (
    <FeatureWallView
      releases={releasesFor(RELEASES, version)}
      onTry={(target) => {
        closeFeatureWall();
        tryFeature(target);
      }}
      onClose={closeFeatureWall}
    />
  );
}
