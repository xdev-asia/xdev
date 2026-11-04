// A fixed table of shortcodes. A name or title typed as `:rocket: login` keeps the emoji in the
// title; the branch and folder name use the code word instead.
export const EMOJI: Record<string, string> = {
  rocket: "🚀",
  sparkles: "✨",
  bug: "🐛",
  fire: "🔥",
  wrench: "🔧",
  hammer: "🔨",
  gear: "⚙️",
  zap: "⚡",
  boom: "💥",
  tada: "🎉",
  white_check_mark: "✅",
  x: "❌",
  warning: "⚠️",
  lock: "🔒",
  key: "🔑",
  memo: "📝",
  books: "📚",
  pencil2: "✏️",
  art: "🎨",
  lipstick: "💄",
  recycle: "♻️",
  truck: "🚚",
  package: "📦",
  bookmark: "🔖",
  label: "🏷️",
  mag: "🔍",
  bulb: "💡",
  construction: "🚧",
  test_tube: "🧪",
  microscope: "🔬",
  chart_with_upwards_trend: "📈",
  broom: "🧹",
  wastebasket: "🗑️",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
  globe_with_meridians: "🌐",
  iphone: "📱",
  computer: "💻",
  seedling: "🌱",
  coffee: "☕",
};

const VS16 = /️/g;

/** Replaces each `:code:` that is in the table; any other text between colons stays. */
export function expandShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_]+):/g, (whole, code: string) => (Object.hasOwn(EMOJI, code) ? EMOJI[code] : whole));
}

/** The emoji become their code words, then lowercase, runs of other characters become one hyphen, ends trimmed. */
export function slugFromTitle(title: string): string {
  let text = title.replace(VS16, "");
  for (const [code, emoji] of Object.entries(EMOJI)) text = text.split(emoji.replace(VS16, "")).join(` ${code} `);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether the text holds an emoji from the table. */
export function hasEmoji(text: string): boolean {
  const plain = text.replace(VS16, "");
  return Object.values(EMOJI).some((e) => plain.includes(e.replace(VS16, "")));
}
