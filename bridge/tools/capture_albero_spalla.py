"""Cattura GUI albero con spallamento Ø16×6 + piastra foro Ø10. Solo HWND, niente GetObject/CloseDoc."""
from __future__ import annotations

import os
import time

import win32con
import win32gui

from capture_u_e_profilo_c import (
    EXPORT,
    find_sw_hwnd,
    print_window,
    save_all,
)

CHAT = os.path.join(os.path.dirname(__file__), "..", "..", "sw-out", "chat-albero-spalla")

COPIES = {
    "albero-spalla-iso-01.jpg": os.path.join(EXPORT, "AlberoSpallamento10.jpg"),
    "albero-spalla-schizzo-01.jpg": os.path.join(EXPORT, "AlberoSpallamento10-schizzo.jpg"),
    "piastra-foro10-iso-01.jpg": os.path.join(EXPORT, "PiastraForo10.jpg"),
    "piastra-foro10-schizzo-01.jpg": os.path.join(EXPORT, "PiastraForo10-schizzo.jpg"),
    "albero-piastra-assieme-iso-01.jpg": os.path.join(EXPORT, "AssiemeAlberoPiastra.jpg"),
    "albero-piastra-tavola-bmp-01.jpg": os.path.join(EXPORT, "TavolaAlberoPiastra.jpg"),
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
    for name, src in COPIES.items():
        if not os.path.isfile(src) or os.path.getsize(src) <= 0:
            print("skip missing", src)
            continue
        save_all(name, src)
    gui_shot("TavolaAlberoPiastra", "albero-piastra-tavola-01.jpg", "albero-piastra-cartiglio-01.jpg")
    gui_shot("TavolaAlberoPiastra", "albero-piastra-gui-no-edit-01.jpg")
    for ui_name, dest in (
        ("ui-proposta.jpg", "albero-piastra-ui-proposta-01.jpg"),
        ("ui-eseguito.jpg", "albero-piastra-ui-eseguito-01.jpg"),
    ):
        src = os.path.normpath(os.path.join(CHAT, ui_name))
        if os.path.isfile(src) and os.path.getsize(src) > 0:
            save_all(dest, src)


if __name__ == "__main__":
    main()
