# xDev shell integration for fish. xDev puts this folder first in XDG_DATA_DIRS, so fish loads
# this file before the owner's config, which is never changed.

# XDG_DATA_DIRS goes back to what it was, so programs started here do not see the folder.
if set -q XDEV_XDG_DATA_DIRS
    if test -n "$XDEV_XDG_DATA_DIRS"
        set -gx XDG_DATA_DIRS "$XDEV_XDG_DATA_DIRS"
    else
        set -e XDG_DATA_DIRS
    end
    set -e XDEV_XDG_DATA_DIRS
end

if status is-interactive; and not set -q __xdev_si
    set -g __xdev_si 1
    set -g __xdev_wrapped 0

    # OSC 7: the folder as a file URL.
    function __xdev_osc7 --on-variable PWD
        printf '\e]7;file://%s%s\a' "$hostname" (string escape --style=url -- "$PWD")
    end

    function __xdev_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end

    function __xdev_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end

    function __xdev_return
        return $argv[1]
    end

    # The owner's prompt is defined later, so it is wrapped at the first prompt: start (A), end (B).
    function __xdev_wrap --on-event fish_prompt
        test "$__xdev_wrapped" = 1; and return
        set -g __xdev_wrapped 1
        __xdev_osc7
        functions -q fish_prompt; or return
        functions -c fish_prompt __xdev_user_prompt
        function fish_prompt
            set -l code $status
            printf '\e]133;A\a'
            __xdev_return $code
            __xdev_user_prompt
            printf '\e]133;B\a'
        end
    end
end
