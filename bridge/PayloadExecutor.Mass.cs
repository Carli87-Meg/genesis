using System.Globalization;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    /// <summary>
    /// MMGS di default espone SW-Mass in grammi sul cartiglio etichettato PESO Kg (es. 714).
    /// Forza le unità di massa a kg e scrive PESO/Peso/Massa prima del SaveAs.
    /// </summary>
    private void ApplyMassUnitsAndPeso(ModelDoc2 model)
    {
        try
        {
            _sw?.SetUserPreferenceIntegerValue(
                (int)swUserPreferenceIntegerValue_e.swUnitsMassPropMass,
                (int)swUnitsMassPropMass_e.swUnitsMassPropMass_Kilograms);
        }
        catch { /* preferenza applicazione opzionale */ }

        var type = 0;
        try { type = model.GetType(); }
        catch { /* ignore */ }

        if (type == (int)swDocumentTypes_e.swDocDRAWING)
        {
            ApplyMassOnDrawing(model);
            return;
        }

        ApplyMassOnModel(model);
    }

    private void ApplyMassOnDrawing(ModelDoc2 model)
    {
        double lastKg = 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (model is IDrawingDoc drawing)
            {
                var view = drawing.GetFirstView() as IView;
                while (view is not null)
                {
                    try { view = view.GetNextView() as IView; }
                    catch { break; }
                    if (view is null) break;

                    ModelDoc2? refDoc = null;
                    try { refDoc = view.ReferencedDocument as ModelDoc2; }
                    catch { refDoc = null; }

                    if (refDoc is null)
                    {
                        string refPath = "";
                        try { refPath = view.GetReferencedModelName() ?? ""; }
                        catch { refPath = ""; }
                        if (!string.IsNullOrWhiteSpace(refPath) && _sw is not null)
                        {
                            try { refDoc = _sw.GetOpenDocumentByName(refPath) as ModelDoc2; }
                            catch { refDoc = null; }
                        }
                    }

                    if (refDoc is null) continue;
                    string key;
                    try { key = refDoc.GetPathName() ?? refDoc.GetTitle(); }
                    catch { key = Guid.NewGuid().ToString(); }
                    if (!seen.Add(key)) continue;

                    ApplyMassOnModel(refDoc);
                    if (TryReadMassKg(refDoc, out var kg) && kg > 0)
                        lastKg = kg;
                }
            }
        }
        catch (Exception ex)
        {
            Step("PESO", false, "tavola ref: " + FormatEx(ex));
        }

        SetDocumentMassUnitsKg(model);
        try { model.ForceRebuild3(false); } catch { /* ignore */ }
        try { model.EditRebuild3(); } catch { /* ignore */ }

        if (lastKg <= 0)
            TryReadMassKg(model, out lastKg);

        if (lastKg > 0)
            WritePesoProperties(model, lastKg);
        else
            Step("PESO", true, "tavola senza massa risolvibile");
    }

    private void ApplyMassOnModel(ModelDoc2 model)
    {
        SetDocumentMassUnitsKg(model);
        try { model.EditRebuild3(); } catch { try { model.ForceRebuild3(false); } catch { /* ignore */ } }

        if (!TryReadMassKg(model, out var kg))
        {
            Step("PESO", false, "CreateMassProperty non disponibile");
            return;
        }

        WritePesoProperties(model, kg);
    }

    private void SetDocumentMassUnitsKg(ModelDoc2 model)
    {
        var pref = (int)swUserPreferenceIntegerValue_e.swUnitsMassPropMass;
        var kg = (int)swUnitsMassPropMass_e.swUnitsMassPropMass_Kilograms;
        try
        {
            model.Extension.SetUserPreferenceInteger(
                pref,
                (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified,
                kg);
        }
        catch
        {
            try { model.SetUserPreferenceIntegerValue(pref, kg); }
            catch { /* ignore */ }
        }
    }

    private static bool TryReadMassKg(ModelDoc2 model, out double kg)
    {
        kg = 0;
        double volume = 0;
        try
        {
            var raw = model.Extension.CreateMassProperty();
            if (raw is MassProperty mp)
            {
                try { mp.UseSystemUnits = true; } catch { /* alcune build sono get-only */ }
                kg = mp.Mass;
                try { volume = mp.Volume; } catch { volume = 0; }
            }
            else if (raw is not null)
            {
                var t = raw.GetType();
                try
                {
                    t.GetProperty("UseSystemUnits")?.SetValue(raw, true, null);
                }
                catch { /* ignore */ }
                var massObj = t.GetProperty("Mass")?.GetValue(raw, null);
                if (massObj is not null)
                    kg = Convert.ToDouble(massObj, CultureInfo.InvariantCulture);
                try
                {
                    var volObj = t.GetProperty("Volume")?.GetValue(raw, null);
                    if (volObj is not null)
                        volume = Convert.ToDouble(volObj, CultureInfo.InvariantCulture);
                }
                catch { /* ignore */ }
            }
        }
        catch
        {
            return false;
        }

        if (kg <= 0) return kg == 0;
        // Cartiglio bug: grammi letti come kg (714). Parti di questo flusso restano sotto 50 kg.
        if (kg >= 50)
            kg /= 1000.0;
        if (volume > 1 && kg > 5)
            kg /= 1000.0;
        return true;
    }

    private void WritePesoProperties(ModelDoc2 model, double massKg)
    {
        var text = massKg.ToString("0.###", CultureInfo.InvariantCulture);
        var names = new[] { "PESO", "Peso", "Massa", "PESO Kg", "Weight" };
        try
        {
            var mgr = model.Extension.get_CustomPropertyManager("");
            foreach (var n in names)
            {
                try
                {
                    mgr.Add3(
                        n,
                        (int)swCustomInfoType_e.swCustomInfoText,
                        text,
                        (int)swCustomPropertyAddOption_e.swCustomPropertyDeleteAndAdd);
                }
                catch
                {
                    try { mgr.Add2(n, (int)swCustomInfoType_e.swCustomInfoText, text); }
                    catch { /* ignore singolo campo */ }
                }
            }

            string title;
            try { title = model.GetTitle(); }
            catch { title = ""; }
            Step("PESO", true, $"{text} kg su {title}");
        }
        catch (Exception ex)
        {
            Step("PESO", false, FormatEx(ex));
        }
    }
}
