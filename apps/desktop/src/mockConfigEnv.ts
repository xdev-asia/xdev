import type { EnvPreviewRow, ImportPreview, SectionPreview } from "@xdev/bindings";
import type { Api, ApiError } from "./api";

type ConfigEnvApi = Pick<
  Api,
  | "configExport"
  | "configImportPreview"
  | "configImportApply"
  | "repoEnvSecrets"
  | "repoEnvSecretSet"
  | "repoEnvSecretClear"
  | "repoEnvPreview"
>;

export type MockConfigEnv = ConfigEnvApi & {
  // The file the open dialog hands back; `configImportPreview` reads it.
  __importPath(): string;
  // Replaces the contents of a file the mock can open.
  __setFile(path: string, doc: unknown): void;
  // The documents `configExport` wrote, newest last.
  __configExports(): { path: string; doc: Record<string, unknown> }[];
  // The next `configExport` is cancelled, as if the person closed the dialog.
  __cancelNextConfigExport(): void;
  // The stored secret values, by `repoId:key`. For tests only: the real api never returns a value.
  __secrets(): Record<string, string>;
};

/** The file `pickFile` offers in the mock: a proxy, an unknown key, an unknown section and a secret. */
export const DEMO_IMPORT_PATH = "/demo/xdev-settings.json";
const DEMO_IMPORT = {
  xdev: 1,
  exported: "2026-01-01T00:00:00Z",
  sections: {
    network: { proxyUrl: "http://127.0.0.1:8080", machineName: "demo-box", futureField: 1, token: "do-not-import" },
    mystery: { a: 1 },
  },
};

/** The sections the mock can export, as the keys of `settings.json`. */
const SECTIONS = ["network", "terminal", "editor"] as const;
const SECRET_NAME = /(token|secret|password|passwd|credentials?|apikey|authorization|cookie|privatekey|accesskey|sessionkey)$|^auth$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripSecrets(value: unknown): { value: unknown; removed: number } {
  if (Array.isArray(value)) {
    let removed = 0;
    const out: unknown[] = [];
    for (const item of value) {
      if ((item as { secret?: unknown } | null)?.secret === true) {
        removed += 1;
        continue;
      }
      const s = stripSecrets(item);
      removed += s.removed;
      out.push(s.value);
    }
    return { value: out, removed };
  }
  if (typeof value === "object" && value !== null) {
    let removed = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_NAME.test(k.replace(/[_-]/g, ""))) {
        removed += 1;
        continue;
      }
      const s = stripSecrets(v);
      removed += s.removed;
      out[k] = s.value;
    }
    return { value: out, removed };
  }
  return { value, removed: 0 };
}

function shown(v: unknown): string {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject({ code, ...(detail === undefined ? {} : { detail }) });
}

type Deps = {
  // The sections the mock can export, by name.
  sections: () => Promise<Record<string, Record<string, unknown>>>;
  // Applies one imported section.
  applySection: (name: string, value: Record<string, unknown>) => Promise<void>;
  // The repo's Environment rows.
  repoEnv: (repoId: string) => Promise<{ key: string; value: string; secret: boolean }[] | null>;
};

/** Config export and import, and the project environment's secrets, in memory. */
export function createMockConfigEnv(deps: Deps): MockConfigEnv {
  const files = new Map<string, unknown>([[DEMO_IMPORT_PATH, structuredClone(DEMO_IMPORT)]]);
  const exports: { path: string; doc: Record<string, unknown> }[] = [];
  const secrets = new Map<string, string>();
  let cancelNext = false;

  async function plan(path: string): Promise<{ preview: ImportPreview; file: Record<string, Record<string, unknown>> }> {
    const file = files.get(path) as Record<string, unknown> | undefined;
    if (file === undefined || typeof file !== "object" || file === null) return reject("config_shape");
    if (file.xdev === undefined) return reject("config_version");
    if (file.xdev !== 1) return reject("config_version", String(file.xdev));
    const incoming = file.sections;
    if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) return reject("config_shape");
    const current = await deps.sections();
    const sections: SectionPreview[] = [];
    const unknownSections: string[] = [];
    for (const [name, raw] of Object.entries(incoming)) {
      const cur = current[name];
      if (!cur) {
        unknownSections.push(name);
        continue;
      }
      const clean = stripSecrets(raw);
      const section: SectionPreview = { section: name, changes: [], unknown: [], secretsRemoved: clean.removed, invalid: false };
      for (const [k, v] of Object.entries(clean.value as Record<string, unknown>)) {
        if (!(k in cur)) section.unknown.push(k);
        else if (JSON.stringify(cur[k]) !== JSON.stringify(v)) section.changes.push({ path: k, from: shown(cur[k]), to: shown(v) });
      }
      sections.push(section);
    }
    return {
      preview: { exported: typeof file.exported === "string" ? file.exported : "", sections, unknownSections },
      file: incoming as Record<string, Record<string, unknown>>,
    };
  }

  return {
    async configExport(chosen) {
      const all = await deps.sections();
      const out: Record<string, unknown> = {};
      for (const name of SECTIONS) {
        if (chosen.includes(name) && all[name]) out[name] = stripSecrets(all[name]).value;
      }
      if (Object.keys(out).length === 0) return reject("config_sections");
      if (cancelNext) {
        cancelNext = false;
        return null;
      }
      const doc = { xdev: 1, exported: new Date(0).toISOString(), sections: out };
      const path = `/demo/export-${exports.length + 1}.json`;
      exports.push({ path, doc: structuredClone(doc) });
      files.set(path, structuredClone(doc));
      return { path, sections: Object.keys(out) };
    },
    async configImportPreview(path) {
      return (await plan(path)).preview;
    },
    async configImportApply(path, chosen) {
      const { preview, file } = await plan(path);
      const applied: string[] = [];
      for (const s of preview.sections) {
        if (!chosen.includes(s.section) || s.invalid) continue;
        const known: Record<string, unknown> = {};
        const clean = stripSecrets(file[s.section]).value as Record<string, unknown>;
        for (const [k, v] of Object.entries(clean)) if (!s.unknown.includes(k)) known[k] = v;
        await deps.applySection(s.section, known);
        applied.push(s.section);
      }
      return { applied };
    },
    async repoEnvSecrets(repoId) {
      const rows = await deps.repoEnv(repoId);
      if (!rows) return reject("repo_unknown", repoId);
      return rows.filter((r) => r.secret && secrets.has(`${repoId}:${r.key}`)).map((r) => r.key);
    },
    async repoEnvSecretSet(repoId, key, value) {
      const rows = await deps.repoEnv(repoId);
      if (!rows) return reject("repo_unknown", repoId);
      if (!rows.some((r) => r.secret && r.key === key) || value.includes("\0")) return reject("bad_env", key);
      secrets.set(`${repoId}:${key}`, value);
    },
    async repoEnvSecretClear(repoId, key) {
      secrets.delete(`${repoId}:${key}`);
    },
    async repoEnvPreview(repoId) {
      const rows = await deps.repoEnv(repoId);
      if (!rows) return reject("repo_unknown", repoId);
      const out: EnvPreviewRow[] = [];
      for (const r of rows) {
        if (!ENV_KEY.test(r.key) || r.key.startsWith("XDEV_")) continue;
        if (r.secret && !secrets.has(`${repoId}:${r.key}`)) continue;
        out.push({ key: r.key, value: r.secret ? "••••••••" : r.value, secret: r.secret, overrides: false });
      }
      return out;
    },
    __importPath: () => DEMO_IMPORT_PATH,
    __setFile: (path, doc) => void files.set(path, structuredClone(doc)),
    __configExports: () => structuredClone(exports),
    __cancelNextConfigExport: () => {
      cancelNext = true;
    },
    __secrets: () => Object.fromEntries(secrets),
  };
}
