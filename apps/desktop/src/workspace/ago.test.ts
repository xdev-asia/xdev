import { expect, it } from "vitest";
import { translate } from "../i18n";
import { ago } from "./ago";

const NOW = 1_000_000_000;
const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const vi = (key: string, vars?: Record<string, string | number>) => translate("vi", key, vars);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

it("ago has boundaries at 59 s, 60 s, 59 min and 24 h", () => {
  expect(ago(NOW, NOW, t)).toBe("just now");
  expect(ago(NOW - 59 * SEC, NOW, t)).toBe("just now");
  expect(ago(NOW - 60 * SEC, NOW, t)).toBe("1 min");
  expect(ago(NOW - 59 * MIN, NOW, t)).toBe("59 min");
  expect(ago(NOW - 60 * MIN, NOW, t)).toBe("1 h");
  expect(ago(NOW - 23 * HOUR - 59 * MIN, NOW, t)).toBe("23 h");
  expect(ago(NOW - 24 * HOUR, NOW, t)).toBe("1 d");
  expect(ago(NOW - 3 * DAY - HOUR, NOW, t)).toBe("3 d");
});

it("ago treats a time in the future as just now, and reads in vi", () => {
  expect(ago(NOW + 5 * MIN, NOW, t)).toBe("just now");
  expect(ago(NOW - 5 * MIN, NOW, vi)).toBe("5 phút");
  expect(ago(NOW, NOW, vi)).toBe("vừa xong");
  expect(ago(NOW - 2 * HOUR, NOW, vi)).toBe("2 giờ");
  expect(ago(NOW - 3 * DAY, NOW, vi)).toBe("3 ngày");
});
