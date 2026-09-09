"""Cattura GUI BaseRettangolare + distanziali, niente Modifica schizzo."""
from __future__ import annotations

import os
import time

import pythoncom
import win32com.client
import win32con
import win32gui

from capture_u_e_profilo_c import (
    AGENT,
    EXPORT,
    MEDIA,
    call,
    find_sw_hwnd,
    print_window,
    save_all,
)

COPIES = {
    "distanziali-base-iso-01.jpg": os.path.join(EXPORT, "BaseRettangolare.jpg"),
    "distanziali-schizzo-01.jpg": os.path.join(EXPORT, "BaseRettangolare-schizzo.jpg"),
    "distanziali-schizzo-fori-01.jpg": os.path.join(EXPORT, "BaseRettangolare-schizzo-2.jpg"),
    "distanziali-dist-iso-01.jpg": os.path.join(EXPORT, "DistanzialeRound.jpg"),
    "distanziali-dist-schizzo-01.jpg": os.path.join(EXPORT, "DistanzialeRound-schizzo.jpg"),
    "distanziali-assieme-iso-01.jpg": os.path.join(EXPORT, "AssiemeBaseDistanziali.jpg"),
}


def gui_shot(prefer: str, name: str, crop: str | None = None) -> None:
    hwnd, title = find_sw_hwnd(prefer)
    print("hwnd", title)
    if not hwnd:
        raise SystemExit(f"finestra non trovata: {prefer}")
    if "modifica schizzo" in title.lower():
        raise SystemExit(f"GUI ancora in Modifica schizzo: {title}")
    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    time.sleep(0.5)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.45)
    img = print_window(hwnd)
    print("img", img.size)
    if img.size[0] < 400:
        raise SystemExit(f"rect piccolo {img.size}")
    save_all(name, img)
    if crop:
        w, h = img.size
        save_all(crop, img.crop((int(w * 0.55), int(h * 0.52), w - 8, h - 48)))


def main() -> None:
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    active = sw.ActiveDoc
    print("active", call(active, "GetTitle"), "type", call(active, "GetType"))
    for name, src in COPIES.items():
        if not os.path.isfile(src) or os.path.getsize(src) <= 0:
            raise SystemExit(f"manca {src}")
        save_all(name, src)
    gui_shot("TavolaAssiemeBase", "distanziali-tavola-01.jpg", "distanziali-cartiglio-01.jpg")
    gui_shot("TavolaAssiemeBase", "distanziali-gui-no-edit-01.jpg")


if __name__ == "__main__":
    main()
