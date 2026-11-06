# xDev shell integration: the owner's .zlogin, then ZDOTDIR is theirs again.
__xdev_ours="$ZDOTDIR"
ZDOTDIR="${XDEV_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
[[ "$ZDOTDIR" != "${XDEV_ZDOTDIR:-$HOME}" ]] && XDEV_ZDOTDIR="$ZDOTDIR"
if [[ -n "${XDEV_ZDOTDIR-}" ]]; then ZDOTDIR="$XDEV_ZDOTDIR"; else unset ZDOTDIR; fi
unset XDEV_ZDOTDIR __xdev_ours
