import { api } from "./api";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

/** The whole app: the workspace shell, which hosts the docs app as one of its views. */
export function App() {
  return <WorkspaceShell api={api} />;
}
