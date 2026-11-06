# xDev shell integration for bash. xDev starts bash with `--init-file` pointing here, so the
# owner's files are read below, as bash would read them, and are never changed.
if [ -n "$XDEV_SHELL_LOGIN" ]; then
  unset XDEV_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  for __xdev_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$__xdev_f" ]; then
      . "$__xdev_f"
      break
    fi
  done
  unset __xdev_f
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi

if [[ $- == *i* ]] && [ -z "$__xdev_si" ]; then
  __xdev_si=1
  __xdev_first=1

  # OSC 7: the folder as a file URL. On Git Bash and Cygwin the drive path is given, or nothing.
  __xdev_osc7() {
    local LC_ALL=C p="$PWD" out="" c i
    case "$OSTYPE" in
      msys* | cygwin*)
        case "$p" in
          /cygdrive/[A-Za-z] | /cygdrive/[A-Za-z]/*) p="/${p:10:1}:${p:11}" ;;
          /[A-Za-z] | /[A-Za-z]/*) p="/${p:1:1}:${p:2}" ;;
          *) return 0 ;;
        esac
        [ "${#p}" -eq 3 ] && p="$p/"
        ;;
    esac
    for ((i = 0; i < ${#p}; i++)); do
      c="${p:i:1}"
      case "$c" in
        [A-Za-z0-9/._~:-]) out+="$c" ;;
        *)
          printf -v c '%%%02X' "'$c"
          out+="$c"
          ;;
      esac
    done
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-}" "$out"
  }

  # First in PROMPT_COMMAND: the last command's exit code (OSC 133 D), then the folder.
  __xdev_status() {
    local code=$?
    [ -z "$__xdev_first" ] && printf '\e]133;D;%s\a' "$code"
    __xdev_first=
    __xdev_osc7
    return "$code"
  }

  # Last in PROMPT_COMMAND, after anything that sets PS1: the prompt's start (A) and end (B).
  __xdev_prompt() {
    case "$PS1" in
      *'133;A'*) ;;
      *) PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]' ;;
    esac
  }

  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__xdev_status "${PROMPT_COMMAND[@]}" __xdev_prompt)
  else
    __xdev_pc="${PROMPT_COMMAND-}"
    while [[ "$__xdev_pc" =~ [[:space:]\;]$ ]]; do __xdev_pc="${__xdev_pc%?}"; done
    PROMPT_COMMAND="__xdev_status${__xdev_pc:+; $__xdev_pc}; __xdev_prompt"
    unset __xdev_pc
  fi
  # Bash 4.4 and later print PS0 when a command starts (C).
  PS0="${PS0-}"'\e]133;C\a'
fi
