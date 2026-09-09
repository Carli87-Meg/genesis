"""Cattura GUI piastra asola oblunga + perno. Solo HWND, niente GetObject/CloseDoc."""
from __future__ import annotations

import os
import time

import win32con
import win32gui

from capture_u_e_profilo_c import EXPORT, find_sw_hwnd, print_window, save_all

CHAT = os.path.join(os.path.dirname(__file__), "..", "..", "sw-out", "chat-piastra-asola-perno")


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
    keys = (
        "piastraasola100",
        "perno10x20",
        "assiemepiastraasola",
        "tavolapiastraasola",
        "piastra-asola",
    )
    for name in os.listdir(EXPORT):
        low = name.lower()
        if not low.endswith(".jpg"):
            continue
        if any(k in low for k in keys):
            save_all(f"piastra-asola-perno-{name}", os.path.join(EXPORT, name))
    for ui_name, dest in (
        ("ui-proposta.jpg", "piastra-asola-perno-ui-proposta-01.jpg"),
        ("ui-eseguito.jpg", "piastra-asola-perno-ui-eseguito-01.jpg"),
        ("ui-fail.jpg", "piastra-asola-perno-ui-proponi-01.jpg"),
    ):
        src = os.path.normpath(os.path.join(CHAT, ui_name))
        if os.path.isfile(src) and os.path.getsize(src) > 0:
            save_all(dest, src)
    gui_shot("Tavola", "piastra-asola-perno-tavola-01.jpg", "piastra-asola-perno-cartiglio-01.jpg")
    gui_shot("Tavola", "piastra-asola-perno-gui-no-edit-01.jpg")


if __name__ == "__main__":
    main()
