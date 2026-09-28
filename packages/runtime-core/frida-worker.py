"""Persistent Frida transport. One helper per workbench, started only on demand."""
import json
import sys
import uuid
from collections import deque
import frida

sessions = {}
scripts = {}
events = deque(maxlen=500)


def device(identifier):
    if not identifier:
        raise ValueError("Specify a device id from devices")
    return frida.get_device(identifier, timeout=5)


def message_handler(script_id):
    def received(message, data):
        encoded = json.dumps(message, ensure_ascii=False, default=str)
        events.append({"script": script_id, "message": encoded[:12000], "binaryBytes": len(data) if data else 0})
    return received


def call(args):
    action = args.get("action")
    if action == "devices":
        return {"version": frida.__version__, "devices": [{"id": d.id, "name": d.name, "type": d.type} for d in frida.enumerate_devices()]}
    if action == "processes":
        return [{"pid": p.pid, "name": p.name} for p in device(args.get("device")).enumerate_processes()]
    if action == "attach":
        if len(sessions) >= 16:
            raise ValueError("Too many active Frida sessions")
        target = args.get("target")
        if isinstance(target, str) and target.isdigit():
            target = int(target)
        if not isinstance(target, (int, str)) or isinstance(target, bool):
            raise ValueError("target must be PID or process name")
        session = device(args.get("device")).attach(target)
        key = str(uuid.uuid4())
        sessions[key] = session
        session.on("detached", lambda *unused: events.append({"session": key, "event": "detached"}))
        return {"session": key}
    if action == "sessions":
        return {"sessions": list(sessions.keys()), "scripts": [{"id": k, "session": v[0]} for k, v in scripts.items()]}
    if action == "load":
        session_id = args.get("session")
        source = args.get("source")
        if not isinstance(source, str) or len(source) > 200000:
            raise ValueError("source must be JavaScript, max 200000 characters")
        if len(scripts) >= 32:
            raise ValueError("Too many active Frida scripts")
        script = sessions[session_id].create_script(source)
        key = str(uuid.uuid4())
        script.on("message", message_handler(key))
        script.load()
        scripts[key] = (session_id, script)
        return {"script": key, "loaded": True}
    if action == "unload":
        entry = scripts.pop(args.get("script"))
        entry[1].unload()
        return {"unloaded": True}
    if action == "messages":
        result = list(events)
        if args.get("clear"):
            events.clear()
        return {"events": result, "capacity": 500}
    if action == "detach":
        key = args.get("session")
        for script_id, entry in list(scripts.items()):
            if entry[0] == key:
                entry[1].unload()
                del scripts[script_id]
        sessions.pop(key).detach()
        return {"detached": True}
    raise ValueError("Unknown Frida action")


try:
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 1024 * 1024:
                raise ValueError("Request too large")
            request = json.loads(line)
            result = {"id": request.get("id"), "result": call(request.get("arguments", {}))}
        except Exception as error:
            result = {"id": request.get("id"), "error": str(error)}
        print(json.dumps(result, ensure_ascii=True, default=str), flush=True)
finally:
    for session in list(sessions.values()):
        try:
            session.detach()
        except Exception:
            pass
