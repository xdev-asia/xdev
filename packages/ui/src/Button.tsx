import type { ButtonHTMLAttributes } from "react";

export function Button({ style, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      style={{
        background: "var(--x-color-accent)",
        color: "var(--x-color-on-accent)",
        border: 0,
        borderRadius: "var(--x-radius-md)",
        padding: "var(--x-space-2) var(--x-space-4)",
        font: "inherit",
        cursor: "pointer",
        ...style,
      }}
    />
  );
}
