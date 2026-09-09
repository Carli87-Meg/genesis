using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    /// <summary>
    /// Esce da ogni schizzo 2D/3D aperto («Modifica schizzo»), EditRebuild3 e
    /// ForceRebuild3. Non chiama InsertSketch se non c'è uno schizzo attivo:
    /// InsertSketch(false) a vuoto riaprirebbe lo schizzo e lascerebbe la GUI in edit.
    /// </summary>
    internal static bool TryExitOpenSketchesAndRebuild(ModelDoc2? model, bool forceRebuild, int depth = 0)
    {
        if (model is null) return true;
        if (depth > 3) return true;

        int docType;
        try { docType = model.GetType(); }
        catch { docType = -1; }

        // Sulle tavole GetActiveSketch2 resta lo schizzo della vista anche fuori
        // da «Modifica schizzo». InsertSketch(false) a vuoto ENTRA in edit e
        // può bloccare il foglio. Non toccare InsertSketch sui drawing.
        if (docType == (int)swDocumentTypes_e.swDocDRAWING)
        {
            try { model.ClearSelection2(true); } catch { /* ignore */ }
            try
            {
                if (model is IDrawingDoc drawing)
                {
                    var sheet = drawing.GetCurrentSheet() as Sheet;
                    var sheetName = sheet?.GetName();
                    if (!string.IsNullOrWhiteSpace(sheetName))
                        drawing.ActivateSheet(sheetName);
                }
            }
            catch { /* Foglio1 */ }
            try { model.EditRebuild3(); } catch { /* ignore */ }
            if (forceRebuild)
            {
                try { model.ForceRebuild3(true); } catch { /* ignore */ }
            }

            return true;
        }

        LeaveComponentEdit(model, depth);

        var sketchMgr = default(ISketchManager);
        try { sketchMgr = (ISketchManager)model.SketchManager; }
        catch { sketchMgr = null; }

        for (var i = 0; i < 8; i++)
        {
            ISketch? active = null;
            try { active = model.GetActiveSketch2() as ISketch; }
            catch { break; }
            if (active is null) break;

            var is3d = false;
            try { is3d = active.Is3D(); }
            catch { /* 2D */ }

            try
            {
                if (is3d) sketchMgr?.Insert3DSketch(false);
                else sketchMgr?.InsertSketch(false);
            }
            catch
            {
                try { model.InsertSketch2(false); } catch { /* ignore */ }
                try { sketchMgr?.InsertSketch(false); } catch { /* ignore */ }
                if (is3d)
                {
                    try { sketchMgr?.Insert3DSketch(false); } catch { /* ignore */ }
                }
            }

            try { model.EditRebuild3(); } catch { /* ignore */ }
        }

        try { model.ClearSelection2(true); } catch { /* ignore */ }
        try { model.EditRebuild3(); } catch { /* ignore */ }
        if (forceRebuild)
        {
            try { model.ForceRebuild3(true); } catch { /* ignore */ }
        }

        try { return model.GetActiveSketch2() is null; }
        catch { return true; }
    }

    private void ExitOpenSketchesAndRebuild(ModelDoc2? model, bool forceRebuild = true)
    {
        var ok = TryExitOpenSketchesAndRebuild(model, forceRebuild);
        string title;
        try { title = model?.GetTitle() ?? ""; }
        catch { title = ""; }
        Step("ExitSketch", ok,
            ok
                ? $"niente Modifica schizzo{(string.IsNullOrWhiteSpace(title) ? "" : " su " + title)}"
                : $"schizzo ancora attivo{(string.IsNullOrWhiteSpace(title) ? "" : " su " + title)}");
        if (ok && forceRebuild)
            Step("ForceRebuild3", true, "dopo uscita schizzo");
    }

    private void ExitOpenSketchesOnAllDocuments(ISldWorks swApp, bool forceRebuild = true)
    {
        object[]? docs = null;
        try { docs = AsArray(swApp.GetDocuments()); }
        catch { docs = null; }
        if (docs is not null)
        {
            foreach (var obj in docs)
            {
                if (obj is ModelDoc2 d)
                    ExitOpenSketchesAndRebuild(d, forceRebuild);
            }
        }

        try
        {
            if (swApp.ActiveDoc is ModelDoc2 active)
                ExitOpenSketchesAndRebuild(active, forceRebuild);
        }
        catch
        {
            /* nessun doc attivo */
        }
    }

    private static void LeaveComponentEdit(ModelDoc2 model, int depth)
    {
        try
        {
            if (model.GetType() != (int)swDocumentTypes_e.swDocASSEMBLY) return;
            if (model is not IAssemblyDoc assy) return;
            try
            {
                if (assy.GetEditTarget() is ModelDoc2 target &&
                    !ReferenceEquals(target, model))
                {
                    TryExitOpenSketchesAndRebuild(target, forceRebuild: false, depth: depth + 1);
                }
            }
            catch
            {
                /* non in modifica pezzo */
            }

            try { assy.EditAssembly(); }
            catch { /* già in assieme */ }
        }
        catch
        {
            /* non è un assieme */
        }
    }
}
