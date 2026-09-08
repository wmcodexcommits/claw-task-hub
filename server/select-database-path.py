#!/usr/bin/env python3
"""Open the desktop portal's native save picker and print one JSON result."""

import json
import os
import sys
import urllib.parse
import uuid

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402


def emit(value: dict[str, object]) -> None:
    print(json.dumps(value), flush=True)


def main() -> int:
    suggested_name = os.path.basename(sys.argv[1] if len(sys.argv) > 1 else "claw-task-hub.sqlite")
    if not suggested_name.lower().endswith(".sqlite"):
        suggested_name += ".sqlite"

    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    proxy = Gio.DBusProxy.new_sync(
        connection,
        Gio.DBusProxyFlags.NONE,
        None,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.FileChooser",
        None,
    )
    token = "claw_task_hub_" + uuid.uuid4().hex
    options = {
        "handle_token": GLib.Variant("s", token),
        "current_name": GLib.Variant("s", suggested_name),
    }
    reply = proxy.call_sync(
        "SaveFile",
        GLib.Variant("(ssa{sv})", ("", "Choose database location", options)),
        Gio.DBusCallFlags.NONE,
        -1,
        None,
    )
    handle = reply.unpack()[0]
    loop = GLib.MainLoop()
    result: dict[str, object] = {"cancelled": True}

    def on_response(_connection, _sender, _path, _interface, _signal, parameters, _user_data):
        nonlocal result
        response, values = parameters.unpack()
        if response == 0:
            uris = values.get("uris", [])
            if uris:
                parsed = urllib.parse.urlparse(uris[0])
                if parsed.scheme == "file" and parsed.netloc in ("", "localhost"):
                    result = {"path": urllib.parse.unquote(parsed.path)}
                else:
                    result = {"error": "The selected location is not a local filesystem path"}
        loop.quit()

    subscription = connection.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        handle,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
        None,
    )
    try:
        loop.run()
    finally:
        connection.signal_unsubscribe(subscription)
    emit(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The API turns this into an editable-path fallback.
        emit({"error": str(error)})
        raise SystemExit(1)
