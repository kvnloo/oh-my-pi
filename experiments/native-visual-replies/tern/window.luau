-- The demo uses the same reviewed host renderer. File-menu Open with supplies a real snapshot.
tern.command({
    id = "demo",
    title = "Native visual: open synthetic demo",
    run = function(cx)
        cx:new_block("native-visual.reply", {}, "beside")
    end,
})
