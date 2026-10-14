"""Independent exhaustive three-registration outcome-order model."""
import itertools
import queue
from omp_rpc import RpcClient
from omp_rpc.client import _HostToolRegistration, _PendingRequest
from tests.test_host_tool_registration import tool

traces = 0
for outcomes in itertools.product((False, True, None), repeat=3):
    def walk(ops, published, completed):
        global traces
        if len(ops) == 6:
            client = RpcClient(custom_tools=(tool("initial"),))
            regs = {}
            states = {0: True}
            for op, i in ops:
                if op == "send":
                    reg = _HostToolRegistration((tool(str(i)),))
                    regs[i] = reg
                    with client._state_lock:
                        reg.previous = client._host_tool_registration
                        client._host_tool_registration = reg
                        client._custom_tools = reg.tools
                    states[i] = None
                else:
                    with client._state_lock:
                        client._settle_host_tool_registration(regs[i], rejected=outcomes[i-1] is False)
                        # A setter's finally block always follows a terminal outcome.
                        client._settle_host_tool_registration(regs[i], rejected=False)
                    states[i] = outcomes[i-1]
                expected = max(k for k,v in states.items() if v is not False)
                actual = client._custom_tools[0].name
                assert actual == (str(expected) if expected else "initial"), (outcomes,ops,op,i,actual,expected)
            traces += 1
            return
        if published < 3:
            walk(ops+[("send",published+1)],published+1,completed)
        for i in range(1,published+1):
            if i not in completed:
                walk(ops+[("settle",i)],published,completed|{i})
    walk([],0,set())
print("PASS:",traces,"three-registration ordered-send / arbitrary-outcome traces")

for raw in (False, 0, "", None, "missing"):
    client=RpcClient(custom_tools=(tool("initial"),))
    reg=_HostToolRegistration((tool("proposed"),), previous=client._host_tool_registration)
    client._host_tool_registration=reg
    client._custom_tools=reg.tools
    client._pending["request"]=_PendingRequest("set_host_tools",queue.Queue(maxsize=1),reg)
    payload={"type":"response","id":"request","command":"set_host_tools"}
    if raw != "missing":
        payload["success"]=raw
    client._handle_response(payload)
    expected="initial" if raw is False else "proposed"
    assert client._custom_tools[0].name==expected,(raw,client._custom_tools)
print("PASS: only literal success=False rolls back; falsey/missing fields preserve proposed handlers")
