import type { NetworkSettings } from "@/api";

export type UrlProblem = "scheme" | "invalid";

const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:"];
const MIRROR_SCHEMES = ["http:", "https:"];

function check(raw: string, schemes: string[]): UrlProblem | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/\s/.test(value)) return "invalid";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (!schemes.includes(url.protocol)) return "scheme";
  return url.hostname ? undefined : "invalid";
}

/** Empty is fine (no proxy). Mirrors the check the app runs when it stores the value. */
export const proxyProblem = (raw: string): UrlProblem | undefined => check(raw, PROXY_SCHEMES);
export const mirrorProblem = (raw: string): UrlProblem | undefined => check(raw, MIRROR_SCHEMES);

/** One host pattern per line (commas also split); blank and repeated entries drop out. */
export function parseBypass(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const item = part.trim();
    if (item && !/\s/.test(item) && !out.some((o) => o.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

export interface NetworkDraft {
  proxyUrl: string;
  noProxy: string;
  nodeMirror: string;
  machineName: string;
}

export const toDraft = (s: NetworkSettings): NetworkDraft => ({
  proxyUrl: s.proxyUrl,
  noProxy: s.noProxy.join("\n"),
  nodeMirror: s.nodeMirror,
  machineName: s.machineName,
});

export const fromDraft = (d: NetworkDraft): NetworkSettings => ({
  proxyUrl: d.proxyUrl.trim(),
  noProxy: parseBypass(d.noProxy),
  nodeMirror: d.nodeMirror.trim(),
  machineName: d.machineName.trim(),
});
