"""Cattura GUI piastra 100x60 + cubo 20 da chat UI."""
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

CHAT = os.path.join(os.path.dirname(__file__), "..", "..", "sw-out", "chat-plate-cube")

DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni\TavolaPiastraCubo.SLDDRW"

COPIES = {
    "piastra-cubo-plate-iso-01.jpg": os.path.join(EXPORT, "Piastra100x60.jpg"),
    "piastra-cubo-schizzo-01.jpg": os.path.join(EXPORT, "Piastra100x60-schizzo.jpg"),
    "piastra-cubo-fori-01.jpg": os.path.join(EXPORT, "Piastra100x60-schizzo-2.jpg"),
    "piastra-cubo-cubo-iso-01.jpg": os.path.join(EXPORT, "Cubo20.jpg"),
    "piastra-cubo-cubo-schizzo-01.jpg": os.path.join(EXPORT, "Cubo20-schizzo.jpg"),
    "piastra-cubo-assieme-iso-01.jpg": os.path.join(EXPORT, "AssemblePiastraCubo.jpg"),
    "piastra-cubo-tavola-bmp-01.jpg": os.path.join(EXPORT, "TavolaPiastraCubo.jpg"),
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


def activate_drawing(sw) -> None:
    model = None
    if os.path.isfile(DRAW):
        try:
            model = sw.OpenDoc(DRAW, 3)
        except Exception as ex:
            print("OpenDoc drawing", ex)
    if model is None:
        model = sw.ActiveDoc
    title = call(model, "GetTitle") if model is not None else ""
    try:
        sw.ActivateDoc(title)
    except Exception:
        try:
            sw.ActivateDoc2(title, True, 0)
        except Exception as ex:
            print("Activate drawing", ex)
    time.sleep(0.8)
    sketch = call(model, "GetActiveSketch2") if model is not None else None
    print("drawing", title, "type", call(model, "GetType") if model else None, "sketch", sketch)


def main() -> None:
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    print("active", call(sw.ActiveDoc, "GetTitle"), "type", call(sw.ActiveDoc, "GetType"))
    for name, src in COPIES.items():
        if not os.path.isfile(src) or os.path.getsize(src) <= 0:
            raise SystemExit(f"manca {src}")
        save_all(name, src)
    activate_drawing(sw)
    gui_shot("TavolaPiastraCubo", "piastra-cubo-tavola-01.jpg", "piastra-cubo-cartiglio-01.jpg")
    gui_shot("TavolaPiastraCubo", "piastra-cubo-gui-no-edit-01.jpg")
    for ui_name, dest in (
        ("ui-proposta.jpg", "piastra-cubo-ui-proposta-01.jpg"),
        ("ui-eseguito.jpg", "piastra-cubo-ui-eseguito-01.jpg"),
    ):
        src = os.path.normpath(os.path.join(CHAT, ui_name))
        if os.path.isfile(src) and os.path.getsize(src) > 0:
            save_all(dest, src)


if __name__ == "__main__":
    main()
