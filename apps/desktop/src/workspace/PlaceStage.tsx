import type { JSX } from "react";
import type { Api } from "@/api";
import { AccountsView } from "@/components/AccountsView";
import { AgentKitView, type KitHost } from "@/components/AgentKitView";
import { SquadsView } from "@/components/SquadsView";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import type { Place } from "@/shell/places";
import type { TasksRequest } from "@/shell/useShellViews";
import { BoardHost, type BoardWiring } from "@/tasks/board/BoardHost";

export type PlaceStageProps = {
  api: Api;
  view: Place;
  // The places shown at least once; a place mounts on first show and then stays.
  mounted: ReadonlySet<Place>;
  tasks: TasksRequest | null;
  board: BoardWiring;
  kit: KitHost;
  onOpenTask(id: string): void;
  onOpenAgentContext(): void;
};

/** The Tasks, Squads, Kit and Accounts places on the main stage. Hidden rather than unmounted once shown. */
export function PlaceStage(props: PlaceStageProps): JSX.Element {
  const { api, view, mounted, board, kit } = props;
  const tasks: TasksRequest = props.tasks ?? { seq: 0 };
  const away = (p: Place) => view !== p;
  const focused = tasks.task !== undefined;
  const boardKey = tasks.task ? `${tasks.task}:${tasks.seq}` : tasks.boardTask || tasks.decompose || tasks.tab ? `board:${tasks.seq}` : "";
  return (
    <>
      {mounted.has("tasks") && (
        <section className="ws-place ws-tasks" hidden={away("tasks")}>
          <SurfaceBoundary id="page.tasks" surface="Tasks" titleKey="boundary.page.title">
            <BoardHost
              key={boardKey}
              api={api}
              repos={board.repos}
              defaultRepo={board.defaultRepo}
              sessions={board.sessions}
              current={board.current}
              onStart={board.onStart}
              onOpenTab={board.onOpenTab}
              onDecompose={board.onDecompose}
              // An agent task asks for Agent runs; a request with a tab names it; the default is the Board.
              initialTab={focused ? "runs" : tasks.tab}
              initialRun={tasks.task}
              initialTask={focused ? undefined : tasks.boardTask}
              initialDecompose={focused ? undefined : tasks.decompose}
            />
          </SurfaceBoundary>
        </section>
      )}
      {mounted.has("squads") && (
        <section className="ws-place ws-squads" hidden={away("squads")}>
          <SurfaceBoundary id="page.squads" surface="Squads" titleKey="boundary.page.title">
            <SquadsView api={api} onOpenTask={props.onOpenTask} />
          </SurfaceBoundary>
        </section>
      )}
      {mounted.has("kit") && (
        <section className="ws-place ws-kit kitview" hidden={away("kit")}>
          <SurfaceBoundary id="page.kit" surface="Agent kit" titleKey="boundary.page.title">
            <AgentKitView
              api={api}
              worktree={kit.worktree}
              request={kit.open}
              onRequestHandled={kit.onOpened}
              onSendToAgent={kit.onSendToAgent}
              canSend={kit.canSend}
              onOpenContext={props.onOpenAgentContext}
            />
          </SurfaceBoundary>
        </section>
      )}
      {mounted.has("accounts") && (
        <section className="ws-place ws-accounts" hidden={away("accounts")}>
          <SurfaceBoundary id="page.accounts" surface="AI accounts" titleKey="boundary.page.title">
            <AccountsView api={api} />
          </SurfaceBoundary>
        </section>
      )}
    </>
  );
}
