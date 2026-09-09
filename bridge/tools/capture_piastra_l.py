"""Cattura GUI staffa a L a due piastre, niente Modifica schizzo."""
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
    "piastra-l-oriz-iso-01.jpg": os.path.join(EXPORT, "PiastraOrizzontale.jpg"),
    "piastra-l-oriz-schizzo-01.jpg": os.path.join(EXPORT, "PiastraOrizzontale-schizzo.jpg"),
    "piastra-l-oriz-fori-01.jpg": os.path.join(EXPORT, "PiastraOrizzontale-schizzo-2.jpg"),
    "piastra-l-vert-iso-01.jpg": os.path.join(EXPORT, "PiastraVerticale.jpg"),
    "piastra-l-vert-schizzo-01.jpg": os.path.join(EXPORT, "PiastraVerticale-schizzo.jpg"),
    "piastra-l-assieme-iso-01.jpg": os.path.join(EXPORT, "AssiemePiastraL.jpg"),
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
    gui_shot("TavolaPiastraL", "piastra-l-tavola-01.jpg", "piastra-l-cartiglio-01.jpg")
    gui_shot("TavolaPiastraL", "piastra-l-gui-no-edit-01.jpg")


if __name__ == "__main__":
    main()
