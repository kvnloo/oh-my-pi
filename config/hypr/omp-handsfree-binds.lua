-- OMP Handsfree / Stage Manager binds
--
-- Separate from main Hyprland layout config on purpose:
--   • does NOT set gaps, decoration, windowrules, or workspaces
--   • Stage geometry is applied at runtime by the HUD via hyprctl
--   • this file only launches/controls the Handsfree process
--
-- Optional permanent load (LOCAL ~/.config/hypr/hyprland.lua only):
--   require("config.omp-handsfree-binds")

local ctl = os.getenv("HOME") .. "/.local/bin/omp-handsfree-ctl"
local scratch = "/home/kvn/tmp/oh-my-pi-handsfree/scripts/omp-handsfree-ctl"
local function ctl_cmd(args)
    return "sh -c 'if [ -x \"" .. ctl .. "\" ]; then exec \"" .. ctl .. "\" " .. args
        .. "; else exec \"" .. scratch .. "\" " .. args .. "; fi'"
end

-- Toggle Handsfree bar + Stage Manager.
hl.bind("SUPER + Escape", hl.dsp.exec_cmd(ctl_cmd("toggle")))

-- Carousel — Shift so SUPER+L stays session lock.
hl.bind("SUPER + SHIFT + H", hl.dsp.exec_cmd(ctl_cmd("prev")))
hl.bind("SUPER + SHIFT + L", hl.dsp.exec_cmd(ctl_cmd("next")))
hl.bind("SUPER + SHIFT + bracketleft", hl.dsp.exec_cmd(ctl_cmd("prev")))
hl.bind("SUPER + SHIFT + bracketright", hl.dsp.exec_cmd(ctl_cmd("next")))

-- Live mic.
hl.bind("SUPER + SHIFT + M", hl.dsp.exec_cmd(ctl_cmd("voice")))

-- Explicit quit (restore tiled baselines).
hl.bind("SUPER + SHIFT + BACKSPACE", hl.dsp.exec_cmd(ctl_cmd("off")))
