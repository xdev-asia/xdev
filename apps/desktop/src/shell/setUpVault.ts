import type { Api, DocEntry } from "../api";

export type Starter = { file: string; content: string };

/** Creates the folder (with the starter doc when it is empty), opens it and starts git tracking. */
export async function setUpVault(api: Api, path: string, starter: Starter): Promise<DocEntry[]> {
  await api.createVault(path, starter.file, starter.content);
  const docs = await api.openVault(path);
  try {
    if ((await api.vcsState()).status === "no_repo") await api.initRepo();
  } catch {
    // Without git the folder still works; the Changes view explains and offers tracking later.
  }
  return docs;
}
