# xDev shell integration for zsh. xDev points ZDOTDIR here; each file reads the owner's file of
# the same name from their own folder, which is never changed. The hooks are in .zshrc.
__xdev_ours="$ZDOTDIR"
ZDOTDIR="${XDEV_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
[[ "$ZDOTDIR" != "${XDEV_ZDOTDIR:-$HOME}" ]] && XDEV_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__xdev_ours"
