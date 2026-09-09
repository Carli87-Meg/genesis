"""Inspect piastra+boss: un body, due estrusioni, no CloseDoc."""
from __future__ import annotations

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"


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


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    for fname in ("PiastraBoss80.SLDPRT", "Perno8x25.SLDPRT"):
        path = CAD + "\\" + fname
        try:
            model = sw.OpenDoc(path, 1)
        except Exception as ex:
            print("OpenDoc", fname, ex)
            continue
        if model is None:
            print("OPEN_FAIL", fname)
            continue
        print("DOC", call(model, "GetTitle"))
        ext = model.Extension
        mass = call(ext, "CreateMassProperty2") or call(ext, "CreateMassProperty")
        if mass:
            try:
                print("mass_kg", round(float(mass.Mass), 4))
            except Exception as ex:
                print("mass_err", ex)
        print("bbox", call(model, "GetPartBox", True))
        feat = call(model, "FirstFeature")
        while feat is not None:
            name = str(call(feat, "Name") or "")
            tn = str(call(feat, "GetTypeName2") or call(feat, "GetTypeName") or "")
            if tn in ("Extrusion", "Cut", "ICE", "Boss", "ProfileFeature") or "taglio" in name.lower() or "boss" in name.lower():
                print("feat", name, tn)
            feat = call(feat, "GetNextFeature")
        try:
            bodies = model.GetBodies2(0, True)
        except Exception:
            bodies = None
        if bodies:
            print("n_bodies", len(list(bodies)))
            for body in list(bodies):
                faces = call(body, "GetFaces")
                edges = call(body, "GetEdges")
                print("body_faces", 0 if not faces else len(list(faces)), "edges", 0 if not edges else len(list(edges)))
                if faces:
                    for i, face in enumerate(list(faces)):
                        try:
                            area = float(face.GetArea()) * 1e6
                        except Exception:
                            area = -1
                        print("face", i, "area_mm2", round(area, 1))


if __name__ == "__main__":
    main()
