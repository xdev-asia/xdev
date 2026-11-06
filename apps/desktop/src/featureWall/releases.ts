// What's new: the cards of each release. Static data in the app; the texts are in en.json and vi.json.

/** Where a card's "Try it" leads. The shell maps it to a page or a panel. */
export type FeatureTarget = { kind: "settings"; section: string } | { kind: "activity" };

export interface FeatureCard {
  id: string;
  titleKey: string;
  bodyKey: string;
  /** "Try it" opens the feature. */
  tryIt?: FeatureTarget;
}

export interface Release {
  /** `major.minor.patch`. */
  version: string;
  cards: readonly FeatureCard[];
}

/** Any order: the wall sorts them, newest first. */
export const RELEASES: readonly Release[] = [
  {
    version: "0.7.0",
    cards: [
      { id: "activity", titleKey: "wall.activity.title", bodyKey: "wall.activity.body", tryIt: { kind: "activity" } },
      { id: "links", titleKey: "wall.links.title", bodyKey: "wall.links.body", tryIt: { kind: "settings", section: "browser" } },
      { id: "review", titleKey: "wall.review.title", bodyKey: "wall.review.body" },
    ],
  },
  {
    version: "0.8.0",
    cards: [
      { id: "tours", titleKey: "wall.tours.title", bodyKey: "wall.tours.body" },
      { id: "tips", titleKey: "wall.tips.title", bodyKey: "wall.tips.body", tryIt: { kind: "settings", section: "general" } },
      { id: "updates", titleKey: "wall.updates.title", bodyKey: "wall.updates.body", tryIt: { kind: "settings", section: "general" } },
    ],
  },
];
