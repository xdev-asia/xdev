# xDev shell integration: the owner's .zshrc, then the hooks.
__xdev_ours="$ZDOTDIR"
ZDOTDIR="${XDEV_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
[[ "$ZDOTDIR" != "${XDEV_ZDOTDIR:-$HOME}" ]] && XDEV_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__xdev_ours"

if [[ -o interactive && -z "$__xdev_si" ]]; then
  typeset -g __xdev_si=1 __xdev_first=1

  # OSC 7: the folder as a file URL.
  __xdev_osc7() {
    emulate -L zsh
    setopt no_multibyte
    local LC_ALL=C p="$PWD" out="" c i
    for (( i = 1; i <= ${#p}; i++ )); do
      c="${p[i]}"
      case "$c" in
        [A-Za-z0-9/._~:-]) out+="$c" ;;
        *) out+="$(printf '%%%02X' "'$c")" ;;
      esac
    done
    printf '\e]7;file://%s%s\a' "${HOST:-}" "$out"
  }

  # First precmd: the last command's exit code (OSC 133 D), then the folder.
  __xdev_status() {
    local code=$?
    [[ -z "$__xdev_first" ]] && printf '\e]133;D;%s\a' "$code"
    __xdev_first=
    __xdev_osc7
    return $code
  }

  # Last precmd, after anything that sets PS1: the prompt's start (A) and end (B).
  __xdev_prompt() {
    [[ "$PS1" == *'133;A'* ]] || PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
  }

  __xdev_preexec() {
    printf '\e]133;C\a'
  }

  precmd_functions=(__xdev_status $precmd_functions __xdev_prompt)
  preexec_functions+=(__xdev_preexec)
fi

# A login shell reads .zlogin next and puts ZDOTDIR back there.
if [[ ! -o login ]]; then
  if [[ -n "${XDEV_ZDOTDIR-}" ]]; then ZDOTDIR="$XDEV_ZDOTDIR"; else unset ZDOTDIR; fi
  unset XDEV_ZDOTDIR __xdev_ours
fi
