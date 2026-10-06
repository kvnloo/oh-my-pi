-- Stub the Tern boundary only. The runner appends unmodified host.luau and the tests.
local definition, fixture
local sorts = 0
local originalSort = table.sort
table.sort = function(items, compare) sorts = sorts + 1; return originalSort(items, compare) end
local function node(kind, props, children) return { k = kind, p = props or {}, c = children } end
local tern = {
    fs = { read = function(_) return "mock JSON bytes" end },
    json = { decode = function(_) return fixture end },
    block = { define = function(id, def) assert(id == "reply"); definition = def end },
    ui = {
        node = node,
        text = function(text) return node("text", { text = text }) end,
        el = function(tag, props, children) props.tag = tag; return node("el", props, children) end,
        col = function(children) return node("col", {}, children) end,
        row = function(children) return node("row", {}, children) end,
    },
}
local function leaf(id, code, churn) return { id = id, label = id, code = code, churn = churn, children = {} } end
local function group(id, children)
    local item = leaf(id, 0, 0); item.children = children
    for _, child in ipairs(children) do item.code = item.code + child.code; item.churn = item.churn + child.churn end
    return item
end
local function start(root)
    fixture = { schema = "omp-native-visual/v1", id = string.rep("a", 64), rendererHash = string.rep("b", 64),
        document = { version = 1, title = "Synthetic test", root = root } }
    sorts = 0
    return definition.init({}, {}, nil)
end
local function key(state, name, extra)
    extra = extra or {}; extra.name = name
    return definition.key(state, extra, {})
end
local function act(state, action, value) return definition.event(state, { ev = "action", act = action, value = value }, {}) end
local function sample()
    return group("root", { group("a", { leaf("a1", 30, 1) }), group("b", { leaf("b1", 20, 40) }), leaf("c", 1, 1) })
end
local passed, failed = 0, 0
local function test(name, fn)
    local ok, err = pcall(fn)
    if ok then passed = passed + 1; print("ok - " .. name)
    else failed = failed + 1; print("not ok - " .. name .. ": " .. tostring(err)) end
end
