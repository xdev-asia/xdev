# xDev shell integration: the owner's .zprofile.
__xdev_ours="$ZDOTDIR"
ZDOTDIR="${XDEV_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
[[ "$ZDOTDIR" != "${XDEV_ZDOTDIR:-$HOME}" ]] && XDEV_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__xdev_ours"
