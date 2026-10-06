test("view reuses the same tree until state changes", function()
    local s = start(sample()); assert(definition.view(s, {}) == definition.view(s, {}))
end)
test("warm mode round-trip reuses exact projection, with two sorts total", function()
    local s = start(sample()); local original = s.items
    key(s, "2"); key(s, "1"); assert(s.items == original); assert(sorts == 2)
end)
test("mode switch keeps the selected stable id instead of changing the target", function()
    local s = start(sample()); local selected = s.items[s.selected].id
    key(s, "2"); assert(s.items[s.selected].id == selected)
end)
test("back restores the parent selection and projection without another sort", function()
    local s = start(sample()); key(s, "down"); local original, selected = s.items, s.items[s.selected].id
    key(s, "enter"); key(s, "left"); assert(s.items == original); assert(s.items[s.selected].id == selected); assert(sorts == 2)
end)
test("clicking an already selected leaf does not rebuild the cached view", function()
    local s = start(sample()); act(s, "drill", "c"); local view = definition.view(s, {})
    act(s, "drill", "c"); assert(definition.view(s, {}) == view)
end)
test("modified character shortcuts are ignored", function()
    local s = start(sample()); local view = definition.view(s, {})
    for _, modifier in ipairs({"ctrl", "alt", "meta"}) do
        assert(key(s, "2", { [modifier] = true }) == false); assert(s.mode == "code")
    end
    assert(definition.view(s, {}) == view)
end)
test("unknown events and repeated mode preserve view identity", function()
    local s = start(sample()); local view = definition.view(s, {})
    act(s, "mode", "code"); act(s, "mode", "unknown"); act(s, "drill", "unknown")
    assert(key(s, "q") == false); assert(definition.view(s, {}) == view)
end)
test("selection creates a fresh tree without mutating the previously returned one", function()
    local s = start(sample()); local view = definition.view(s, {})
    local first = view.main.c[4]; key(s, "down"); assert(definition.view(s, {}) ~= view); assert(view.main.c[4] == first)
end)
test("cache is per block, not shared between snapshots", function()
    local a = start(sample()); key(a, "2")
    local b = start(sample()); assert(a.items ~= b.items); assert(b.mode == "code")
end)
test("bounded LRU retains at most eight directory/mode projections", function()
    local children = {}
    for i = 1, 12 do children[i] = group("g" .. i, { leaf("f" .. i, i, i) }) end
    local s = start(group("root", children))
    for i = 1, 12 do act(s, "drill", "g" .. i); key(s, "left") end
    assert(#s.projections <= 8); assert(#s.projections > 1)
end)
test("save omits cached data and transient view trees", function()
    local s = start(sample()); key(s, "2"); local saved = definition.save(s)
    assert(saved.path and saved.mode == "churn"); local n = 0; for _ in pairs(saved) do n = n + 1 end; assert(n == 2)
end)
test("zero-valued leaves retain finite layout weights", function()
    local s = start(group("root", { leaf("a", 0, 0), leaf("b", 0, 0) }))
    local function walk(n)
        if n.p and n.p.grow then assert(n.p.grow == n.p.grow and n.p.grow >= 0) end
        for _, child in ipairs(n.c or {}) do walk(child) end
    end
    walk(definition.view(s, {}).main)
end)
test("pointer and keyboard mode changes share the same cached projection", function()
    local s = start(sample()); act(s, "mode", "churn"); local churn = s.items
    key(s, "1"); key(s, "2"); assert(s.items == churn); assert(sorts == 2)
end)
test("Other stays explicit and preserves all aggregate totals", function()
    local children = {}; for i = 1, 1000 do children[i] = leaf("f" .. i, i, i % 7) end
    local s = start(group("root", children)); assert(#s.items == 128)
    local code, churn = 0, 0; for _, item in ipairs(s.items) do code = code + item.code; churn = churn + item.churn end
    assert(code == s.current.code and churn == s.current.churn); assert(#s.items[128].children == 873)
    act(s, "drill", s.items[128].id); assert(#s.items == 128); assert(key(s, "left"))
end)
test("50k files: 40 warm mode switches do not repeat sorting or expand the node budget", function()
    local children = {}; for i = 1, 50000 do children[i] = leaf("f" .. i, i % 200 + 1, i % 17) end
    local s = start(group("root", children)); key(s, "2")
    for _ = 1, 20 do key(s, "1"); key(s, "2") end
    assert(sorts == 2); assert(#s.items == 128)
    local count = 0
    local function walk(n) count = count + 1; for _, child in ipairs(n.c or {}) do walk(child) end end
    walk(definition.view(s, {}).main); assert(count <= 280)
end)
print(string.format("Renderer logic: %d passed, %d failed; Tern API is stubbed, no pixels or paint timings.", passed, failed))
assert(failed == 0, "Renderer logic regressions")
