"""Cattura GUI boccola flangiata Ø16 + piastra foro Ø16 da chat UI italiana."""
from __future__ import annotations

import os
import time

import pythoncom
import win32com.client
import win32con
import win32gui

from capture_u_e_profilo_c import (
    EXPORT,
    call,
    find_sw_hwnd,
    print_window,
    save_all,
)

CHAT = os.path.join(os.path.dirname(__file__), "..", "..", "sw-out", "chat-boccola-flangia")
DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni\TavolaBoccolaPiastra.SLDDRW"

COPIES = {
    "boccola-flangia16-iso-01.jpg": os.path.join(EXPORT, "BoccolaFlangia16.jpg"),
    "boccola-flangia16-schizzo-01.jpg": os.path.join(EXPORT, "BoccolaFlangia16-schizzo.jpg"),
    "boccola-flangia16-fori-01.jpg": os.path.join(EXPORT, "BoccolaFlangia16-schizzo-2.jpg"),
    "piastra-foro16-iso-01.jpg": os.path.join(EXPORT, "PiastraForo16.jpg"),
    "piastra-foro16-schizzo-01.jpg": os.path.join(EXPORT, "PiastraForo16-schizzo.jpg"),
    "piastra-foro16-foro-01.jpg": os.path.join(EXPORT, "PiastraForo16-schizzo-2.jpg"),
    "boccola-piastra-assieme-iso-01.jpg": os.path.join(EXPORT, "AssemieBoccolaPiastra.jpg"),
    "boccola-piastra-tavola-bmp-01.jpg": os.path.join(EXPORT, "TavolaBoccolaPiastra.jpg"),
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
    print("drawing", title, "type", call(model, "GetType") if model else None)


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
    gui_shot("TavolaBoccolaPiastra", "boccola-piastra-tavola-01.jpg", "boccola-piastra-cartiglio-01.jpg")
    gui_shot("TavolaBoccolaPiastra", "boccola-piastra-gui-no-edit-01.jpg")
    for ui_name, dest in (
        ("ui-proposta.jpg", "boccola-piastra-ui-proposta-01.jpg"),
        ("ui-eseguito.jpg", "boccola-piastra-ui-eseguito-01.jpg"),
    ):
        src = os.path.normpath(os.path.join(CHAT, ui_name))
        if os.path.isfile(src) and os.path.getsize(src) > 0:
            save_all(dest, src)


if __name__ == "__main__":
    main()
