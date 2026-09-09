"""Verifica: nessun documento in Modifica schizzo dopo tavola."""
from __future__ import annotations

import os
import pythoncom
import win32com.client
import win32gui


def call(obj, name, *args):
    attr = getattr(obj, name)
    try:
        return attr(*args)
    except TypeError:
        return attr
    except Exception:
        try:
            return attr
        except Exception:
            return None


def titles():
    found = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        t = win32gui.GetWindowText(hwnd) or ""
        if "SOLIDWORKS" in t.upper() and t.strip():
            found.append(t)
        return True

    win32gui.EnumWindows(cb, None)
    return found


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    print("version", call(sw, "RevisionNumber"))
    print("windows:")
    edit_gui = False
    for t in titles():
        print(" ", t)
        if "modifica schizzo" in t.lower() or "editing sketch" in t.lower():
            edit_gui = True
    print("gui_edit_sketch", edit_gui)

    active = sw.ActiveDoc
    print("active", call(active, "GetTitle"), "type", call(active, "GetType"))
    print("active_sketch", call(active, "GetActiveSketch2"))

    raw = call(sw, "GetDocuments")
    docs = []
    if raw is None:
        docs = []
    elif isinstance(raw, (list, tuple)):
        docs = list(raw)
    else:
        try:
            docs = list(raw)
        except Exception:
            docs = [raw]
    print("open_docs", len(docs))
    any_part_sketch = False
    for d in docs:
        if d is None:
            continue
        title = call(d, "GetTitle")
        ty = call(d, "GetType")
        sk = call(d, "GetActiveSketch2")
        skname = None
        is3d = None
        if sk is not None:
            skname = call(sk, "Name") if hasattr(sk, "Name") else None
            try:
                is3d = sk.Is3D
                if callable(is3d):
                    is3d = is3d()
            except Exception:
                is3d = None
        print(f"  type={ty} sketch={sk is not None} is3d={is3d} name={skname} title={title}")
        if sk is not None and ty in (1, 2):
            any_part_sketch = True
    print("part_or_asm_edit_sketch", any_part_sketch)
    if edit_gui or any_part_sketch:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
