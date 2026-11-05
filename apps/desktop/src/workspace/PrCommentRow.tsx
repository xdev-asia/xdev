import { useState } from "react";
import type { JSX } from "react";
import { Comment, Icon, IconButton, Menu, ReactionBar, type IconName } from "@xdev-asia/ui";
import type { PrComment, Reaction } from "@/api";
import { renderMarkdown } from "@/doc/markdown";
import { useI18n } from "@/i18n";
import { ago } from "./ago";
import { botMenuAction, copyText, handle, isBot, locationLabel, openLine } from "./prComments";

const NO_LINKS = () => null;
const COPIED_MS = 1500;

/** The design system has no thumbs or faces, and emoji are out; each reaction takes the nearest icon. */
const REACTIONS: readonly { content: Reaction; icon: IconName }[] = [
  { content: "THUMBS_UP", icon: "check-circle" },
  { content: "THUMBS_DOWN", icon: "close" },
  { content: "LAUGH", icon: "sparkle" },
  { content: "CONFUSED", icon: "help" },
  { content: "HEART", icon: "star" },
  { content: "HOORAY", icon: "zap" },
  { content: "ROCKET", icon: "play" },
  { content: "EYES", icon: "eye" },
];

/** One comment: who, when, where, what, with copy, resolve, a menu and reactions. */
export function PrCommentRow(props: {
  comment: PrComment;
  now: number;
  overrides: readonly string[];
  /** Set on the first comment of a review thread: the row offers Resolve or Unresolve. */
  canResolve: boolean;
  disabled?: boolean;
  onResolve: (threadId: string, resolved: boolean) => void;
  onReact: (nodeId: string, content: Reaction, on: boolean) => void;
  onMarkBot: (login: string, mark: boolean) => void;
  onOpen: (path: string, line: number | null) => void;
  /** Under the body: the reply box or the reply button. */
  footer?: JSX.Element | null;
}): JSX.Element {
  const { comment: c, now, overrides, canResolve, disabled = false } = props;
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const where = locationLabel(c);
  const action = botMenuAction(c.author, overrides);
  const state = c.resolved ? "resolved" : c.outdated ? "outdated" : undefined;

  function copy(): void {
    void navigator.clipboard.writeText(copyText(c)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  }

  const reactions = REACTIONS.map(({ content, icon }) => {
    const r = c.reactions.find((x) => x.content === content);
    return { key: content, label: t(`prc.react.${content}`), symbol: <Icon name={icon} size={14} />, count: r?.count ?? 0, mine: r?.mine ?? false };
  });

  return (
    <div className="ws-prc-row" data-comment={c.id}>
      <Comment
        author={handle(c.author)}
        time={ago(Date.parse(c.createdAt), now, t)}
        bot={isBot(c, overrides)}
        botLabel={t("prc.bot")}
        state={state}
        stateLabel={state ? t(`prc.state.${state}`) : undefined}
        location={
          where && c.path ? (
            <button type="button" className="ws-prc-where" title={t("prc.open", { location: where })} onClick={() => props.onOpen(c.path as string, openLine(c))}>
              {where}
            </button>
          ) : undefined
        }
        actions={
          <>
            <IconButton icon={copied ? "check" : "copy"} label={copied ? t("prc.copied") : t("prc.copy")} onClick={copy} />
            {canResolve && c.threadId && (
              <IconButton
                icon={c.resolved ? "undo" : "check-circle"}
                label={c.resolved ? t("prc.unresolve") : t("prc.resolve")}
                disabled={disabled}
                data-resolve={c.threadId}
                onClick={() => props.onResolve(c.threadId as string, !c.resolved)}
              />
            )}
            {action && (
              <span className="ws-prc-more">
                <IconButton icon="more" label={t("prc.more")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
                {menu && (
                  <Menu
                    label={t("prc.more")}
                    items={[
                      {
                        label: t(action === "mark" ? "prc.markBot" : "prc.unmarkBot"),
                        onSelect: () => {
                          setMenu(false);
                          props.onMarkBot(c.author, action === "mark");
                        },
                      },
                    ]}
                  />
                )}
              </span>
            )}
          </>
        }
        footer={
          <>
            <ReactionBar
              label={t("prc.react.group")}
              items={reactions}
              disabled={disabled}
              onToggle={(key) => {
                const r = c.reactions.find((x) => x.content === key);
                props.onReact(c.nodeId, key as Reaction, !(r?.mine ?? false));
              }}
            />
            {props.footer}
          </>
        }
      >
        <div className="preview-body ws-prc-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body, "", NO_LINKS) }} />
      </Comment>
    </div>
  );
}
