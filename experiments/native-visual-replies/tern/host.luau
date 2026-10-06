-- Fixed trusted code. JSON is data, never required, evaluated, or executed.
-- API source: docs.stencil.so/tern/guides/blocks.html and elements/el.html.
local ui = tern.ui
local LIMIT, MAX_NODES, MAX_BYTES, MAX_VALUE = 128, 60000, 8388608, 1000000000000

local function load(path)
    -- fs.read has no pre-read byte cap: use OMP-owned bounded snapshots, not hostile local files.
    local raw = tern.fs.read(path)
    assert(#raw <= MAX_BYTES, "Snapshot too large")
    local artifact = tern.json.decode(raw)
    assert(artifact.schema == "omp-native-visual/v1", "Unsupported snapshot")
    assert(type(artifact.id) == "string" and #artifact.id == 64 and not string.find(artifact.id, "[^a-f0-9]"), "Invalid identity")
    local document = artifact.document
    assert(document.version == 1 and type(document.title) == "string" and #document.title <= 640, "Invalid document")
    local seen, count = {}, 0
    local function visit(node, depth)
        count = count + 1
        assert(count <= MAX_NODES and depth <= 16, "Tree exceeds bounds")
        assert(type(node.id) == "string" and #node.id <= 64 and string.match(node.id, "^[a-zA-Z][a-zA-Z0-9_-]*$") and not seen[node.id], "Invalid identity")
        seen[node.id] = true
        assert(type(node.label) == "string" and #node.label > 0 and #node.label <= 640 and not string.find(node.label, "%c"), "Invalid label")
        for _, name in ipairs({"code", "churn"}) do
            local n = node[name]
            assert(type(n) == "number" and n == n and n >= 0 and n <= MAX_VALUE and n % 1 == 0, "Invalid value")
        end
        assert(type(node.children) == "table", "Invalid children")
        local code, churn = 0, 0
        for _, child in ipairs(node.children) do
            visit(child, depth + 1)
            code, churn = code + child.code, churn + child.churn
        end
        assert(#node.children == 0 or (code == node.code and churn == node.churn), "Incorrect aggregate")
    end
    visit(document.root, 0)
    return artifact
end

local function project(state)
    local items = {}
    for _, child in ipairs(state.current.children) do table.insert(items, child) end
    table.sort(items, function(a, b)
        if a[state.mode] == b[state.mode] then return a.id < b.id end
        return a[state.mode] > b[state.mode]
    end)
    if #items > LIMIT then
        local other = { id = "@other:" .. state.current.id, label = "Other (" .. tostring(#items - LIMIT + 1) .. ")", code = 0, churn = 0, children = {} }
        for i = LIMIT, #items do
            local child = items[i]
            table.insert(other.children, child)
            other.code, other.churn = other.code + child.code, other.churn + child.churn
        end
        local bounded = {}
        for i = 1, LIMIT - 1 do bounded[i] = items[i] end
        table.insert(bounded, other)
        items = bounded
    end
    state.items, state.selected, state.cached = items, 1, nil
end

local function drill(state, index)
    local item = state.items[index]
    if not item or #item.children == 0 then return false end
    table.insert(state.stack, state.current)
    state.current = item
    project(state)
    return true
end

local function back(state)
    if #state.stack == 0 then return false end
    state.current = table.remove(state.stack)
    project(state)
    return true
end

local function button(text, action, key)
    return ui.el("button", { text = text, key = key, class = "nv-button", actions = { click = action } })
end

-- Binary slice-and-dice layout: bounded output; browserless flex layout computes pixels.
local function tiles(state, first, last, depth)
    if first > last then return ui.text("No children; return to the parent.") end
    if first == last then
        local item = state.items[first]
        return ui.el("div", {
            key = item.id, class = if first == state.selected then "nv-cell nv-selected" else "nv-cell",
            text = item.label, aria = item.label, title = string.format("%s: %d code units, %d churn units", item.label, item.code, item.churn),
            grow = math.max(item[state.mode], 1), basis = 0,
            actions = { click = "drill=" .. item.id },
        })
    end
    local total, accumulated, split = 0, 0, first
    for i = first, last do total = total + math.max(state.items[i][state.mode], 1) end
    for i = first, last - 1 do
        accumulated = accumulated + math.max(state.items[i][state.mode], 1)
        split = i
        if accumulated >= total / 2 then break end
    end
    local left = tiles(state, first, split, depth + 1)
    local right = tiles(state, split + 1, last, depth + 1)
    left.p = left.p or {}; right.p = right.p or {}
    left.p.grow, left.p.basis = accumulated, 0
    right.p.grow, right.p.basis = total - accumulated, 0
    return ui.el("div", { key = "split-" .. first .. "-" .. last, class = if depth % 2 == 0 then "nv-split nv-row" else "nv-split nv-col" }, { left, right })
end

tern.block.define("reply", {
    init = function(_cx, args, saved)
        local path = if saved and type(saved.path) == "string" then saved.path else args[1] or "demo.visual.json"
        local artifact = load(path)
        local state = { path = path, artifact = artifact, current = artifact.document.root, stack = {}, mode = "code", selected = 1, items = {}, cached = nil }
        if saved and saved.mode == "churn" then state.mode = "churn" end
        project(state)
        return state
    end,
    title = function(state) return state.artifact.document.title end,
    view = function(state, _cx)
        if state.cached then return state.cached end
        local top = {}
        for i = 1, math.min(8, #state.items) do
            local item = state.items[i]
            top[i] = { label = item.label, value = item[state.mode] }
        end
        local map = tiles(state, 1, #state.items, 0)
        map.p = map.p or {}; map.p.grow = 0; map.p.class = (map.p.class or "") .. " nv-map"
        state.cached = { main = ui.col({
            ui.text(state.artifact.document.title .. " — " .. state.current.label),
            ui.text(string.format("Code: %d  |  Churn: %d  |  Mode: %s", state.current.code, state.current.churn, state.mode)),
            ui.row({ button("Code [1]", "mode=code", "code"), button("Churn [2]", "mode=churn", "churn"), button("Back [←]", "back", "back") }),
            map,
            ui.text("Largest visible children (zero weights receive a minimum display area)"),
            ui.node("chart", { kind = "bars", series = top, size = "sm", summary = state.mode }),
        }), dock = ui.col({ ui.text("Preview " .. string.sub(state.artifact.id, 1, 12) .. " · ↑/↓ select · Enter drill · ← back · 1/2 mode") }) }
        return state.cached
    end,
    key = function(state, key, _cx)
        if key.name == "1" or key.name == "2" then
            local mode = if key.name == "1" then "code" else "churn"
            if state.mode == mode then return false end
            state.mode = mode; project(state); return true
        elseif key.name == "left" or key.name == "backspace" then return back(state)
        elseif key.name == "enter" then return drill(state, state.selected)
        elseif key.name == "down" or key.name == "up" then
            local selected = math.max(1, math.min(#state.items, state.selected + (if key.name == "down" then 1 else -1)))
            if selected == state.selected then return false end
            state.selected, state.cached = selected, nil
            return true
        end
        return false
    end,
    event = function(state, ev, _cx)
        if ev.ev ~= "action" then return end
        if ev.act == "mode" and (ev.value == "code" or ev.value == "churn") and state.mode ~= ev.value then
            state.mode = ev.value; project(state)
        elseif ev.act == "back" then back(state)
        elseif ev.act == "drill" then
            for i, item in ipairs(state.items) do
                if item.id == ev.value then
                    if not drill(state, i) then state.selected, state.cached = i, nil end
                    break
                end
            end
        end
    end,
    -- Restore the document and mode, not transient trees/caches. Reload resets drill position in this slice.
    save = function(state) return { path = state.path, mode = state.mode } end,
})
