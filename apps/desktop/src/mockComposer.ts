import type { Api, ApiError, PromptTemplate } from "./api";

type ComposerApi = Pick<
  Api,
  "composerDraftGet" | "composerDraftPut" | "composerDraftClear" | "promptTemplatesList" | "promptTemplatesPut" | "promptTemplatesDelete"
>;

/** The bounds of `xdev_kit::drafts` and `xdev_kit::templates`. */
export const DRAFT_MAX_BYTES = 64 * 1024;
export const TEMPLATES_MAX = 200;
const TEMPLATE_NAME_MAX_CHARS = 80;
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function sorted(list: PromptTemplate[]): PromptTemplate[] {
  return [...list]
    .sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((t) => ({ ...t }));
}

/** In-memory drafts and prompt templates, with the Rust store's bounds and error codes. */
export function createMockComposer(seed: { templates?: PromptTemplate[] } = {}): ComposerApi {
  const drafts = new Map<string, string>();
  let templates: PromptTemplate[] = (seed.templates ?? []).map((t) => ({ ...t }));
  return {
    async composerDraftGet(tabId) {
      return drafts.get(tabId) ?? null;
    },
    async composerDraftPut(tabId, text) {
      if (tabId === "" || tabId.length > 128) return reject("kit_bad_input", "bad tab id");
      if (bytes(text) > DRAFT_MAX_BYTES) return reject("too_large");
      if (text === "") drafts.delete(tabId);
      else drafts.set(tabId, text);
    },
    async composerDraftClear(tabId) {
      return drafts.delete(tabId);
    },
    async promptTemplatesList() {
      return sorted(templates);
    },
    async promptTemplatesPut(template) {
      const name = template.name.trim();
      if (!TEMPLATE_ID.test(template.id)) return reject("kit_bad_input", "bad template id");
      if (name === "" || [...name].length > TEMPLATE_NAME_MAX_CHARS) return reject("kit_bad_input", "bad template name");
      if (bytes(template.body) > DRAFT_MAX_BYTES) return reject("too_large");
      const next = { ...template, name };
      const at = templates.findIndex((t) => t.id === template.id);
      if (at >= 0) templates[at] = next;
      else if (templates.length >= TEMPLATES_MAX) return reject("too_large");
      else templates.push(next);
      return sorted(templates);
    },
    async promptTemplatesDelete(id) {
      templates = templates.filter((t) => t.id !== id);
      return sorted(templates);
    },
  };
}
