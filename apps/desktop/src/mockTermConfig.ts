import type { Api, ApiError, ConfigKind, CustomScheme, TermConfigPreview } from "./api";
import type { SettingsEmit } from "./mockSettings";
import { TERMINAL_SCHEMES } from "./terminal/terminalThemes";

type TermConfigApi = Pick<Api, "termConfigDetect" | "termConfigRead" | "termConfigSaveScheme">;

const DEMO_PATHS: Record<ConfigKind, string> = {
  ghostty: "/demo/.config/ghostty/config",
  kitty: "/demo/.config/kitty/kitty.conf",
};

function fail(code: ApiError["code"]): ApiError {
  return { code };
}

/** The demo has a Ghostty config and no Kitty one; "Choose file" reads either from any path. */
export function createMockTermConfig(emit: SettingsEmit = () => {}): TermConfigApi {
  const preview = (kind: ConfigKind, path: string): TermConfigPreview => ({
    kind,
    path,
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    cursorStyle: "bar",
    cursorBlink: false,
    scrollback: kind === "kitty" ? 5000 : null,
    paddingPx: 6,
    backgroundOpacity: 0.9,
    themeName: null,
    scheme: { id: `custom-${kind}-import`, name: `${kind === "kitty" ? "Kitty" : "Ghostty"} import`, mode: "dark", colors: TERMINAL_SCHEMES[0]!.colors },
  });
  return {
    async termConfigDetect() {
      return { ghostty: DEMO_PATHS.ghostty, kitty: null };
    },
    async termConfigRead(kind, path) {
      if (path === null && kind === "kitty") throw fail("not_found");
      return preview(kind, path ?? DEMO_PATHS[kind]);
    },
    async termConfigSaveScheme(kind, path): Promise<CustomScheme> {
      const out = preview(kind, path ?? DEMO_PATHS[kind]).scheme!;
      emit(["terminal"]);
      return out;
    },
  };
}
