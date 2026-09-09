"""Cattura GUI dopo fix freeze: pezzi + assieme + tavola, niente Modifica schizzo."""
from __future__ import annotations

import os
import shutil
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
    "freeze-tavola-piastra-iso-01.jpg": os.path.join(EXPORT, "Piastra90.jpg"),
    "freeze-tavola-schizzo-01.jpg": os.path.join(EXPORT, "Piastra90-schizzo.jpg"),
    "freeze-tavola-schizzo-fori-01.jpg": os.path.join(EXPORT, "Piastra90-schizzo-2.jpg"),
    "freeze-tavola-perno-iso-01.jpg": os.path.join(EXPORT, "PernoCilindrico.jpg"),
    "freeze-tavola-assieme-iso-01.jpg": os.path.join(EXPORT, "AssiemePiastraPerno.jpg"),
}


def gui_shot(prefer: str, name: str, crop: str | None = None) -> None:
    hwnd, title = find_sw_hwnd(prefer)
    print("hwnd", title)
    if not hwnd:
        raise SystemExit(f"finestra non trovata: {prefer}")
    if "modifica schizzo" in title.lower():
        raise SystemExit(f"GUI ancora in Modifica schizzo: {title}")
    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    time.sleep(0.45)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.4)
    img = print_window(hwnd)
    print("img", img.size)
    if img.size[0] < 200:
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
    print("active_sketch", call(active, "GetActiveSketch2"))
    for name, src in COPIES.items():
        if not os.path.isfile(src) or os.path.getsize(src) <= 0:
            raise SystemExit(f"manca {src}")
        save_all(name, src)
    gui_shot("TavolaPiastraPerno", "freeze-tavola-01.jpg", "freeze-tavola-cartiglio-01.jpg")
    gui_shot("TavolaPiastraPerno", "freeze-tavola-gui-no-edit-01.jpg")
    for folder in (EXPORT, MEDIA, AGENT):
        dest = os.path.join(folder, "freeze-tavola-01.jpg")
        n = os.path.getsize(dest) if os.path.isfile(dest) else 0
        print("check", n, dest)


if __name__ == "__main__":
    main()
