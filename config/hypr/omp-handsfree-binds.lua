-- OMP Handsfree / Stage Manager binds
--
-- Separate from main Hyprland layout config on purpose:
--   • does NOT set gaps, decoration, windowrules, or workspaces
--   • Stage geometry is applied at runtime by the HUD via hyprctl
--   • this file only launches/controls the Handsfree process
--
-- Optional permanent load (you add this yourself — not in .files):
--   require("config.omp-handsfree-binds")
-- after copying/symlinking this file to ~/.config/hypr/config/
--
-- Or run:  scripts/omp-handsfree-install-binds
-- which registers the same binds via `hyprctl eval` with no config edits.

local ctl = os.getenv("HOME") .. "/.local/bin/omp-handsfree-ctl"
-- Fall back to the scratch tree if the local bin shim is missing.
local scratch = os.getenv("HOME") .. "/.hermes/scratch/omp-stage-hud/scripts/omp-handsfree-ctl"
local function ctl_cmd(args)
    return "sh -c 'if [ -x \"" .. ctl .. "\" ]; then exec \"" .. ctl .. "\" " .. args
        .. "; else exec \"" .. scratch .. "\" " .. args .. "; fi'"
end

-- Toggle Handsfree bar + Stage Manager carousel.
hl.bind("SUPER + SHIFT + grave", hl.dsp.exec_cmd(ctl_cmd("toggle")))

-- Rotate carousel (opens Handsfree first if needed).
-- Super+H/L: switch active Stage window. Plain hl.dsp.focus is a no-op while
-- Stage floats the stack — carousel owns the switch.
-- Install script unbinds SUPER+L lock first (noctalia) so L does not lock.
hl.bind("SUPER + H", hl.dsp.exec_cmd(ctl_cmd("prev")))
hl.bind("SUPER + L", hl.dsp.exec_cmd(ctl_cmd("next")))
hl.bind("SUPER + SHIFT + H", hl.dsp.exec_cmd(ctl_cmd("prev")))
hl.bind("SUPER + SHIFT + L", hl.dsp.exec_cmd(ctl_cmd("next")))
hl.bind("SUPER + SHIFT + bracketleft",  hl.dsp.exec_cmd(ctl_cmd("prev")))
hl.bind("SUPER + SHIFT + bracketright", hl.dsp.exec_cmd(ctl_cmd("next")))

-- Lock moved off SUPER+L (was noctalia session lock in binds.lua).
hl.bind("SUPER + SHIFT + X", hl.dsp.exec_cmd("noctalia msg session lock"))

-- Explicit quit (restore tiled baselines).
hl.bind("SUPER + SHIFT + BACKSPACE", hl.dsp.exec_cmd(ctl_cmd("off")))
