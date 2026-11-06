import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeInput, formatCode, normalizeCode } from "./CodeInput";
import { PairingCode, codeGroups } from "./PairingCode";

it("CodeInput normalises 7k4qm2xd9p to 7K4QM-2XD9P", () => {
  expect(normalizeCode("7k4qm2xd9p", "crockford", 10)).toBe("7K4QM2XD9P");
  expect(formatCode("7K4QM2XD9P", 5)).toBe("7K4QM-2XD9P");
  expect(renderToStaticMarkup(<CodeInput length={10} groupSize={5} value="7K4QM2XD9P" onChange={() => {}} label="Code" />)).toContain('value="7K4QM-2XD9P"');
});

it("strips spaces and dashes, maps O to 0 and I, L to 1, drops other characters, cuts to length", () => {
  expect(normalizeCode(" 7k4-qm 2xd9p ", "crockford", 10)).toBe("7K4QM2XD9P");
  expect(normalizeCode("oIl", "crockford", 10)).toBe("011");
  expect(normalizeCode("u!u7", "crockford", 10)).toBe("7");
  expect(normalizeCode("7K4QM2XD9PAAAA", "crockford", 10)).toBe("7K4QM2XD9P");
  expect(normalizeCode("48a2 91-3", "digits", 6)).toBe("482913");
});

it("CodeInput is one real input that says when it is invalid", () => {
  const html = renderToStaticMarkup(<CodeInput length={10} value="" onChange={() => {}} label="Code" invalid />);
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-label="Code"');
});

it("PairingCode cuts the code into groups and keeps the full string for a screen reader", () => {
  expect(codeGroups("7K4QM-2XD9P", 5)).toEqual(["7K4QM", "2XD9P"]);
  expect(codeGroups("482 913", 3)).toEqual(["482", "913"]);
  const html = renderToStaticMarkup(<PairingCode value="7K4QM-2XD9P" label="Pairing code" />);
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('aria-label="Pairing code"');
  expect(html).toContain("7K4QM-2XD9P");
  expect(html).not.toContain("<button");
});

it("PairingCode shows a copy button only when asked", () => {
  expect(renderToStaticMarkup(<PairingCode value="7K4QM-2XD9P" copyLabel="Copy" onCopy={() => {}} />)).toContain('aria-label="Copy"');
});
