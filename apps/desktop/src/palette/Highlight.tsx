import type { JSX } from "react";
import type { Range } from "./match";

/** Text with the matched ranges in a heavier weight. */
export function Highlight(props: { text: string; hits: Range[] }): JSX.Element {
  const { text, hits } = props;
  const parts: JSX.Element[] = [];
  let at = 0;
  for (const [s, e] of hits) {
    if (s > at) parts.push(<span key={`t${at}`}>{text.slice(at, s)}</span>);
    parts.push(
      <b key={`h${s}`} className="pal-hit">
        {text.slice(s, e)}
      </b>,
    );
    at = e;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}
