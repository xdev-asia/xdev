import { invoke } from "@tauri-apps/api/core";
import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";

export function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // Rejects when the page runs in a plain browser via `vite dev`.
    invoke<string>("app_version").then(setVersion, () => setVersion(null));
  }, []);

  return (
    <main className="shell">
      <h1>xDev</h1>
      <p className="muted">Local-first project knowledge for humans and AI agents.</p>
      <Button disabled title="Not available yet">
        Open folder
      </Button>
      <p className="version">{version ? `v${version}` : "browser preview"}</p>
    </main>
  );
}
