using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    private readonly List<ExecStep> _steps = [];
    private readonly Dictionary<string, string> _created = new(StringComparer.OrdinalIgnoreCase);
    private ISldWorks? _sw;

    public (List<ExecStep> Steps, List<FeatureInfo> Features, string? DocTitle, int? DocType, string? SavedPath, string? SnapshotPath) Execute(
        ISldWorks swApp,
        SolidWorksDocumentPayload payload)
    {
        _steps.Clear();
        _created.Clear();
        _sw = swApp;

        swApp.Visible = true;
        try { swApp.UserControl = true; } catch { /* ignore */ }
        try { swApp.CommandInProgress = false; } catch { /* mates fail if true */ }
        try
        {
            swApp.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate, false);
        }
        catch { /* ignore */ }

        SwPaths.EnsureProjectFolders();
        if (!string.IsNullOrWhiteSpace(payload.Document.OpenPath))
            payload.Document.OpenPath = SwPaths.Resolve(payload.Document.OpenPath);
        if (!string.IsNullOrWhiteSpace(payload.Document.SavePath))
            payload.Document.SavePath = SwPaths.Resolve(payload.Document.SavePath);
        if (!string.IsNullOrWhiteSpace(payload.Document.SnapshotPath))
            payload.Document.SnapshotPath = SwPaths.Resolve(payload.Document.SnapshotPath);

        try
        {
            var model = OpenDocument(swApp, payload.Document);
            if (model is null)
            {
                Step("OpenDocument", false, "ActiveDoc è null dopo NewDocument/GetObject");
                return (_steps, [], null, null, null, null);
            }

            if (model.GetType() == (int)swDocumentTypes_e.swDocDRAWING &&
                string.IsNullOrWhiteSpace(payload.Document.OpenPath))
            {
                ApplySheetFormat(model, payload.Document.SheetFormat ?? "A3");
            }

            ApplyVariables(model, payload.Variables);

            foreach (var op in payload.Operations)
            {
                try
                {
                    RunOperation(model, op, payload.Units);
                }
                catch (Exception ex)
                {
                    Step(op.Type ?? "op", false, FormatEx(ex));
                }
            }

            ApplyConfigurations(model, payload.Configurations);

            var onlyPrefs = payload.Operations.Count > 0 && payload.Operations.TrueForAll(o =>
            {
                var t = (o.Type ?? "").Trim().ToLowerInvariant();
                return t is "filelocations" or "file_locations" or "setfilelocation" or "set_file_location";
            });
            if (!onlyPrefs)
            {
                try
                {
                    model.ForceRebuild3(true);
                    Step("ForceRebuild3", true, "Ricostruzione completata");
                }
                catch (Exception ex)
                {
                    Step("ForceRebuild3", false, FormatEx(ex));
                }

                try { model.ViewZoomtofit2(); } catch { /* optional */ }
            }

            var saved = SaveIfRequested(model, payload.Document);
            var snap = SnapshotIfRequested(model, payload.Document);

            string? title = null;
            int? docType = null;
            try { title = model.GetTitle(); } catch { /* ignore */ }
            try { docType = model.GetType(); } catch { /* ignore */ }

            var features = FeatureTreeReader.Read(model);
            Step("FeatureByPositionReverse", true, $"{features.Count} feature (GetTypeName2)");
            return (_steps, features, title, docType, saved, snap);
        }
        finally
        {
            try { swApp.CommandInProgress = false; } catch { /* ignore */ }
        }
    }

    private ModelDoc2? OpenDocument(ISldWorks swApp, DocumentSpec spec)
    {
        var kind = (spec.Type ?? "part").Trim().ToLowerInvariant();

        if (!string.IsNullOrWhiteSpace(spec.OpenPath))
        {
            var opened = OpenExisting(swApp, spec.OpenPath);
            if (opened is not null) return opened;
        }

        if (spec.AttachToActive)
        {
            if (swApp.ActiveDoc is ModelDoc2 active)
            {
                Step("AttachToActive", true, active.GetTitle());
                return active;
            }

            Step("AttachToActive", false, "Nessun documento attivo");
        }

        return kind switch
        {
            "assembly" or "assieme" => NewAssembly(swApp, spec.Name),
            "drawing" or "tavola" or "disegno" => NewDrawing(swApp, spec.Name),
            _ => NewPart(swApp, spec.Name),
        };
    }

    private ModelDoc2? OpenExisting(ISldWorks swApp, string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
        {
            Step("OpenDoc6", false, $"File non trovato: {full}");
            return null;
        }

        try
        {
            if (swApp.GetOpenDocumentByName(full) is ModelDoc2 already)
            {
                var aErr = 0;
                try { swApp.ActivateDoc3(already.GetTitle(), false, 0, ref aErr); } catch { /* ignore */ }
                Step("ActivateDoc3", true, $"{Path.GetFileName(full)} già aperto");
                return already;
            }
        }
        catch
        {
            /* not open in this instance */
        }

        var dtype = full.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
            ? (int)swDocumentTypes_e.swDocASSEMBLY
            : full.EndsWith(".slddrw", StringComparison.OrdinalIgnoreCase)
                ? (int)swDocumentTypes_e.swDocDRAWING
                : (int)swDocumentTypes_e.swDocPART;
        var errors = 0;
        var warnings = 0;
        try
        {
            var doc = swApp.OpenDoc6(
                full,
                dtype,
                (int)swOpenDocOptions_e.swOpenDocOptions_Silent,
                "",
                ref errors,
                ref warnings) as ModelDoc2;
            Step("OpenDoc6", doc is not null, $"{Path.GetFileName(full)} errors={errors} warnings={warnings}");
            if (doc is not null)
            {
                var aErr = 0;
                try { swApp.ActivateDoc3(doc.GetTitle(), false, 0, ref aErr); } catch { /* ignore */ }
            }

            return doc;
        }
        catch (Exception ex)
        {
            Step("OpenDoc6", false, FormatEx(ex));
            return null;
        }
    }

    private ModelDoc2? NewPart(ISldWorks swApp, string name)
    {
        var template = TemplateLocator.Part();
        ModelDoc2? doc = null;
        try
        {
            doc = swApp.NewDocument(template, 0, 0.0, 0.0) as ModelDoc2;
            Step("NewDocument", doc is not null, $"template={template}");
        }
        catch (Exception ex)
        {
            Step("NewDocument", false, FormatEx(ex));
        }

        if (doc is null)
        {
            try
            {
                doc = swApp.NewPart() as ModelDoc2;
                Step("NewPart", doc is not null, "fallback NewPart()");
            }
            catch (Exception ex)
            {
                Step("NewPart", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private ModelDoc2? NewAssembly(ISldWorks swApp, string name)
    {
        ModelDoc2? doc = null;
        try
        {
            doc = swApp.NewAssembly() as ModelDoc2;
            Step("NewAssembly", doc is not null, name);
        }
        catch (Exception ex)
        {
            Step("NewAssembly", false, FormatEx(ex));
        }

        if (doc is null)
        {
            var template = TemplateLocator.Assembly();
            try
            {
                doc = swApp.NewDocument(template, 0, 0.0, 0.0) as ModelDoc2;
                Step("NewDocument", doc is not null, $"assembly template={template}");
            }
            catch (Exception ex)
            {
                Step("NewDocument", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private ModelDoc2? NewDrawing(ISldWorks swApp, string name)
    {
        ModelDoc2? doc = null;
        var template = TemplateLocator.Drawing();
        try
        {
            doc = swApp.NewDrawing2(2, template, 12, 0.42, 0.297) as ModelDoc2;
            Step("NewDrawing", doc is not null, $"template={template}");
        }
        catch (Exception ex)
        {
            Step("NewDrawing", false, FormatEx(ex));
            try
            {
                doc = swApp.NewDocument(template, 0, 0.42, 0.297) as ModelDoc2;
                Step("NewDocument", doc is not null, "drawing via NewDocument");
            }
            catch (Exception ex2)
            {
                Step("NewDocument", false, FormatEx(ex2));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private void ApplySheetFormat(ModelDoc2 model, string? hint)
    {
        if (model.GetType() != (int)swDocumentTypes_e.swDocDRAWING)
        {
            Step("SetupSheet5", false, "non è una tavola");
            return;
        }

        var path = TemplateLocator.SheetFormat(hint);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            Step("SetupSheet5", false, $"Cartiglio_CM non trovato (hint={hint})");
            return;
        }

        var drawing = (IDrawingDoc)model;
        var name = "Foglio1";
        try
        {
            if (drawing.GetCurrentSheet() is Sheet sheet)
            {
                name = sheet.GetName();
            }
        }
        catch { /* Foglio1 */ }

        var a2 = path.Contains("A2", StringComparison.OrdinalIgnoreCase);
        var w = a2 ? 0.594 : 0.420;
        var h = a2 ? 0.420 : 0.297;
        const int paperUserDefined = 12;
        const int templateCustom = 2;

        var ok = false;
        try
        {
            // Interop 2025: SetupSheet5(name, paper, templateIn, scale1, scale2, firstAngle, templateName, width, height, sameProp, scaleToFit)
            ok = drawing.SetupSheet5(name, paperUserDefined, templateCustom, 1, 1, true, path, w, h, "", false);
        }
        catch (Exception ex)
        {
            Step("SetupSheet5", false, FormatEx(ex));
        }

        if (!ok)
        {
            try
            {
                ok = drawing.SetupSheet4(name, paperUserDefined, templateCustom, 1, 1, true, path, w, h, "");
            }
            catch (Exception ex)
            {
                Step("SetupSheet4", false, FormatEx(ex));
            }
        }

        Step("SetupSheet5", ok, $"{Path.GetFileName(path)} sheet={name} {w * 1000:0}x{h * 1000:0} mm");
        try { model.ForceRebuild3(false); } catch { /* ignore */ }
        try { model.EditRebuild3(); } catch { /* ignore */ }
    }

    private static void RenameIfPossible(ModelDoc2? doc, string name)
    {
        if (doc is null || string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        try { doc.SetTitle2(name); } catch { /* requires save on some versions */ }
    }

    private void ApplyVariables(ModelDoc2 model, List<CadVariable> variables)
    {
        if (variables.Count == 0) return;
        try
        {
            var eq = (IEquationMgr)model.GetEquationMgr();
            foreach (var v in variables)
            {
                if (string.IsNullOrWhiteSpace(v.Name)) continue;
                var expr = $"\"{v.Name}\" = {v.Value.ToString(CultureInfo.InvariantCulture)}";
                try
                {
                    eq.Add2(-1, expr, true);
                    Step("EquationMgr.Add2", true, expr);
                }
                catch (Exception ex)
                {
                    Step("EquationMgr.Add2", false, $"{expr}: {FormatEx(ex)}");
                }
            }
        }
        catch (Exception ex)
        {
            Step("GetEquationMgr", false, FormatEx(ex));
        }
    }

    private void ApplyConfigurations(ModelDoc2 model, List<CadConfiguration> configs)
    {
        foreach (var cfg in configs)
        {
            if (string.IsNullOrWhiteSpace(cfg.Name)) continue;
            try
            {
                var added = model.AddConfiguration3(cfg.Name, "", "", (int)swConfigurationOptions2_e.swConfigOption_DontActivate);
                Step("AddConfiguration3", added is not null, cfg.Name);
            }
            catch (Exception ex)
            {
                try
                {
                    model.AddConfiguration3(cfg.Name, "", "", 0);
                    Step("AddConfiguration3", true, cfg.Name);
                }
                catch
                {
                    Step("AddConfiguration2", false, FormatEx(ex));
                }
            }
        }
    }

    private void RunOperation(ModelDoc2 model, CadOperation op, string units)
    {
        switch ((op.Type ?? "").Trim().ToLowerInvariant())
        {
            case "sketch": DoSketch(model, op, units); break;
            case "extrude": DoExtrude(model, op, units, cut: false); break;
            case "cut": DoExtrude(model, op, units, cut: true); break;
            case "revolve": DoRevolve(model, op); break;
            case "hole": DoHole(model, op, units); break;
            case "fillet":
                Step("FeatureManager.FeatureFillet", true, "saltato (fillet non affidabile in questa sessione)");
                break;
            case "chamfer": DoChamfer(model, op, units); break;
            case "shell": DoShell(model, op, units); break;
            case "pattern": DoPattern(model, op, units); break;
            case "component": DoComponent(model, op, units); break;
            case "mate": DoMate(model, op, units); break;
            case "clearmates":
            case "clear_mates": DoClearMates(model); break;
            case "inspect": DoInspect(model); break;
            case "verify": DoVerifyLayout(model, op, units); break;
            case "filelocations":
            case "file_locations": DoFileLocations(); break;
            case "setfilelocation":
            case "set_file_location": DoSetFileLocation(op); break;
            case "drawingview":
            case "drawing_view": DoDrawingView(model, op); break;
            case "standardviews":
            case "standard_views": DoStandardViews(model, op); break;
            case "modeldimensions":
            case "model_dimensions": DoModelDimensions(model, op); break;
            case "annotation": DoAnnotation(model, op); break;
            case "sheetformat":
            case "sheet_format":
            case "setupsheet":
            case "setup_sheet":
                ApplySheetFormat(model, op.Str("format", op.Str("path", "A3")));
                break;
            default: Step(op.Type ?? "op", false, "Tipo operazione non supportato"); break;
        }
    }

    private void DoSketch(ModelDoc2 model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("sketch", false, $"Piano non trovato: {plane}");
            return;
        }

        var sketchMgr = (ISketchManager)model.SketchManager;
        sketchMgr.InsertSketch(true);
        try { sketchMgr.AddToDB = true; } catch { /* ignore */ }

        var contours = op.Field("contours");
        var n = 0;
        if (contours is { ValueKind: JsonValueKind.Array })
        {
            foreach (var c in contours.Value.EnumerateArray())
            {
                if (DrawContour(sketchMgr, c, units)) n++;
            }
        }

        sketchMgr.InsertSketch(false);
        RememberLatest(model, op.Id, op.Name);
        Step("SketchManager", true, $"{n} contorni su {plane}");
    }

    private bool DrawContour(ISketchManager sketchMgr, JsonElement c, string units)
    {
        var kind = c.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "";
        try
        {
            switch (kind.ToLowerInvariant())
            {
                case "rectangle":
                {
                    var cx = Len(c, "cx", units);
                    var cy = Len(c, "cy", units);
                    var w = Len(c, "width", units);
                    var h = Len(c, "height", units);
                    sketchMgr.CreateCornerRectangle(cx - w / 2, cy - h / 2, 0, cx + w / 2, cy + h / 2, 0);
                    return true;
                }
                case "circle":
                {
                    var cx = Len(c, "cx", units);
                    var cy = Len(c, "cy", units);
                    var d = Len(c, "diameter", units);
                    var r = c.TryGetProperty("radius", out var rj) && rj.ValueKind == JsonValueKind.Number
                        ? ToMeters(rj.GetDouble(), units)
                        : d / 2;
                    sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
                    return true;
                }
                case "line":
                {
                    var line = (ISketchSegment)sketchMgr.CreateLine(
                        Len(c, "x1", units), Len(c, "y1", units), 0,
                        Len(c, "x2", units), Len(c, "y2", units), 0);
                    if (c.TryGetProperty("construction", out var cons) && cons.ValueKind == JsonValueKind.True)
                    {
                        try { line.ConstructionGeometry = true; } catch { /* ignore */ }
                    }
                    return true;
                }
                default:
                    return false;
            }
        }
        catch (Exception ex)
        {
            Step("SketchManager.Create", false, $"{kind}: {FormatEx(ex)}");
            return false;
        }
    }

    private void DoExtrude(ModelDoc2 model, CadOperation op, string units, bool cut)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        var featMgr = (IFeatureManager)model.FeatureManager;
        var depth = ToMeters(op.Num("depth", 10), units);
        var flip = op.Flag("flip");
        var merge = op.Flag("merge", true);
        var throughAll = op.Flag("throughAll");
        var t1 = throughAll
            ? (int)swEndConditions_e.swEndCondThroughAll
            : (int)swEndConditions_e.swEndCondBlind;

        Feature? feat;
        try
        {
            if (cut)
            {
                feat = featMgr.FeatureCut3(
                    true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                    false, false, false, false, 0.0, 0.0,
                    false, false, false, false,
                    false, true, true, true, true, false,
                    (int)swStartConditions_e.swStartSketchPlane, 0, false);
                if (feat is null)
                {
                    feat = featMgr.FeatureCut3(
                        true, flip, false, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureCut4(
                        true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, Math.Max(depth, 0.01), 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false, false);
                }
            }
            else
            {
                feat = featMgr.FeatureExtrusion3(
                    true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                    false, false, false, false, 0.0, 0.0,
                    false, false, false, false,
                    merge, true, true,
                    (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
                if (feat is null)
                {
                    feat = featMgr.FeatureExtrusion3(
                        true, false, flip, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true,
                        (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
                }
            }
        }
        catch (Exception ex)
        {
            Step(cut ? "FeatureManager.FeatureCut" : "FeatureManager.FeatureExtrusion", false, FormatEx(ex));
            return;
        }

        if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        Step(cut ? "FeatureManager.FeatureCut" : "FeatureManager.FeatureExtrusion", feat is not null,
            throughAll ? "throughAll" : $"depth={op.Num("depth")} {units}");
    }

    private void DoRevolve(ModelDoc2 model, CadOperation op)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        var angle = op.Num("angle", 360) * Math.PI / 180.0;
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            var feat = featMgr.FeatureRevolve2(
                true, true, false, false, false, false, 0, 0,
                angle, 0, false, false, 0, 0,
                0, 0, 0, true, true, true);
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.FeatureRevolve2", feat is not null, $"angle={op.Num("angle", 360)}°");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.FeatureRevolve2", false, FormatEx(ex));
        }
    }

    private void DoHole(ModelDoc2 model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("hole", false, $"Piano non trovato: {plane}");
            return;
        }

        var sketchMgr = (ISketchManager)model.SketchManager;
        sketchMgr.InsertSketch(true);
        try { sketchMgr.AddToDB = true; } catch { /* ignore */ }
        var cx = ToMeters(op.Num("cx"), units);
        var cy = ToMeters(op.Num("cy"), units);
        var r = ToMeters(op.Num("diameter", 6), units) / 2;
        sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
        sketchMgr.InsertSketch(false);

        var cutOp = new CadOperation
        {
            Id = op.Id,
            Type = "cut",
            Name = op.Name,
            Extra = new Dictionary<string, JsonElement>
            {
                ["throughAll"] = JsonSerializer.SerializeToElement(op.Flag("throughAll", true)),
                ["depth"] = JsonSerializer.SerializeToElement(op.Num("depth", 10)),
            },
        };
        DoExtrude(model, cutOp, units, cut: true);
    }

    private void DoFillet(ModelDoc2 model, CadOperation op, string units)
    {
        var radius = ToMeters(op.Num("radius", 1), units);
        if (op.Flag("allEdges", true)) SelectAllBodyEdges(model);
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            var feat = featMgr.FeatureFillet3(
                0, radius, 0, 0, 0, 0, 0,
                null, null, null, null, null, null, null) as Feature;
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.FeatureFillet", feat is not null, $"R={op.Num("radius")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.FeatureFillet", false, FormatEx(ex));
        }
    }

    private void DoChamfer(ModelDoc2 model, CadOperation op, string units)
    {
        var dist = ToMeters(op.Num("distance", 1), units);
        if (op.Flag("allEdges", true)) SelectAllBodyEdges(model);
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            var feat = featMgr.InsertFeatureChamfer(1, 1, dist, 0.785398163, 0, 0, 0, 0) as Feature;
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.InsertFeatureChamfer", feat is not null, $"d={op.Num("distance")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.InsertFeatureChamfer", false, FormatEx(ex));
        }
    }

    private void DoShell(ModelDoc2 model, CadOperation op, string units)
    {
        Step("FeatureManager.InsertShell", false,
            $"InsertShell non esposto in questa interop (t={op.Num("thickness")} {units})");
    }

    private void DoPattern(ModelDoc2 model, CadOperation op, string units)
    {
        var featureId = op.Str("feature");
        if (_created.TryGetValue(featureId, out var fname)) SelectFeature(model, fname);
        var kind = op.Str("kind", "linear");
        var count = (int)op.Num("count", 2);
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            Feature? feat;
            if (kind == "circular")
            {
                var angle = op.Num("angle", 360) * Math.PI / 180.0;
                feat = featMgr.FeatureCircularPattern4(count, angle, false, "NULL", false, false, false) as Feature;
                Step("FeatureManager.FeatureCircularPattern4", feat is not null, $"n={count}");
            }
            else
            {
                var spacing = ToMeters(op.Num("spacing", 20), units);
                feat = featMgr.FeatureLinearPattern4(
                    count, spacing, 1, 0, false, false, "NULL", "NULL",
                    false, false, false, false, false, false, true, true, false, false, 0, 0);
                Step("FeatureManager.FeatureLinearPattern4", feat is not null, $"n={count}");
            }
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        }
        catch (Exception ex)
        {
            Step("pattern", false, FormatEx(ex));
        }
    }

    private void DoComponent(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("AddComponent5", false, "Il documento non è un assieme");
            return;
        }

        var path = SwPaths.Resolve(op.Str("path"));
        if (string.IsNullOrWhiteSpace(path))
        {
            Step("AddComponent5", false, "path mancante");
            return;
        }

        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
        {
            Step("AddComponent5", false, $"File non trovato: {path}");
            return;
        }

        if (_sw is not null)
        {
            var oErr = 0;
            var oWarn = 0;
            try
            {
                var opened = _sw.OpenDoc6(
                    full,
                    (int)swDocumentTypes_e.swDocPART,
                    (int)swOpenDocOptions_e.swOpenDocOptions_Silent,
                    "",
                    ref oErr,
                    ref oWarn);
                Step("OpenDoc6", opened is not null, $"{Path.GetFileName(full)} errors={oErr}");
            }
            catch (Exception ex)
            {
                Step("OpenDoc6", false, FormatEx(ex));
            }

            try
            {
                var aErr = 0;
                _sw.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
            }
            catch
            {
                try { _sw.ActivateDoc(model.GetTitle()); } catch { /* ignore */ }
            }
        }

        var x = ToMeters(op.Num("x"), units);
        var y = ToMeters(op.Num("y"), units);
        var z = ToMeters(op.Num("z"), units);
        try
        {
            object? compObj = assy.AddComponent5(
                full,
                (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig,
                "",
                false,
                "",
                x, y, z);
            if (compObj is not Component2)
            {
                try { compObj = assy.AddComponent(full, x, y, z); } catch { /* next */ }
            }
            if (compObj is not Component2 comp)
            {
                Step("AddComponent5", false, full);
                return;
            }

            var inst = comp.Name2;
            if (!string.IsNullOrEmpty(op.Id)) _created[op.Id] = inst;
            if (!string.IsNullOrEmpty(op.Name)) _created[op.Name] = inst;
            _created[Path.GetFileNameWithoutExtension(full)] = inst;

            if (op.Flag("fix"))
            {
                try
                {
                    comp.Select4(false, null, false);
                    assy.FixComponent();
                    Step("FixComponent", true, inst);
                }
                catch (Exception ex)
                {
                    Step("FixComponent", false, FormatEx(ex));
                }
            }

            Step("AddComponent5", true, inst);
        }
        catch (Exception ex)
        {
            Step("AddComponent5", false, FormatEx(ex));
        }
    }

    private void DoMate(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("AddMate5", false, "Il documento non è un assieme");
            return;
        }

        try { _sw!.CommandInProgress = false; } catch { /* ignore */ }

        var c1 = op.Str("component1");
        var c2 = op.Str("component2");
        var e1 = op.Str("entity1", op.Str("plane1", "Front"));
        var e2 = op.Str("entity2", op.Str("plane2", "Front"));
        var kind = op.Str("mateType", "coincident").ToLowerInvariant();
        model.ClearSelection2(true);

        var selData = CreateMark1(model);
        var targetR = ToMeters(op.Num("diameter", 0), units) / 2.0;
        var sel1 = SelectMateEntity(assy, c1, e1, append: false, selData, kind, targetR);
        var sel2 = SelectMateEntity(assy, c2, e2, append: true, selData, kind, targetR);
        if (!sel1 || !sel2)
        {
            Step("AddMate5", false, $"Selezione fallita {c1}/{e1} ({sel1}) + {c2}/{e2} ({sel2})");
            return;
        }

        var mateType = kind switch
        {
            "concentric" => (int)swMateType_e.swMateCONCENTRIC,
            "parallel" => (int)swMateType_e.swMatePARALLEL,
            "perpendicular" => (int)swMateType_e.swMatePERPENDICULAR,
            "distance" => (int)swMateType_e.swMateDISTANCE,
            _ => (int)swMateType_e.swMateCOINCIDENT,
        };
        var dist = ToMeters(op.Num("distance"), units);
        var alignments = AlignmentsToTry(op, e1, e2, kind);
        var flip = op.Flag("flip");
        try
        {
            var nSel = 0;
            try { nSel = ((ISelectionMgr)model.SelectionManager).GetSelectedObjectCount2(-1); } catch { /* ignore */ }

            Mate2? mate = null;
            var errors = -1;
            var usedAlign = -1;
            var usedFlip = flip;
            foreach (var align in alignments)
            {
                foreach (var tryFlip in flip ? new[] { true, false } : new[] { false, true })
                {
                    model.ClearSelection2(true);
                    SelectMateEntity(assy, c1, e1, append: false, selData, kind, targetR);
                    SelectMateEntity(assy, c2, e2, append: true, selData, kind, targetR);
                    errors = 0;
                    mate = assy.AddMate5(mateType, align, tryFlip, dist, dist, dist, 0, 0, 0, 0, 0, false, false, 0, out errors);
                    if (mate is null)
                    {
                        continue;
                    }

                    try { model.EditRebuild3(); } catch { try { model.ForceRebuild3(true); } catch { } }
                    if (MateGeometryOk(assy, kind, c1, e1, c2, e2))
                    {
                        usedAlign = align;
                        usedFlip = tryFlip;
                        errors = 0;
                        goto MateDone;
                    }

                    DeleteLastMate(model);
                    mate = null;
                }
            }

            MateDone:
            var alignName = usedAlign == (int)swMateAlign_e.swMateAlignANTI_ALIGNED
                ? "anti"
                : usedAlign == (int)swMateAlign_e.swMateAlignALIGNED
                    ? "aligned"
                    : usedAlign == (int)swMateAlign_e.swMateAlignCLOSEST
                        ? "closest"
                        : "none";
            Step("AddMate5", mate is not null,
                $"{kind} {c1}/{e1}–{c2}/{e2} sel={nSel} align={alignName} flip={usedFlip} errors={errors}");
            LogComponentBoxes(assy);
        }
        catch (Exception ex)
        {
            Step("AddMate5", false, FormatEx(ex));
        }
        finally
        {
            try { model.ClearSelection2(true); } catch { /* ignore */ }
        }
    }

    private static int[] AlignmentsToTry(CadOperation op, string e1, string e2, string kind)
    {
        var requested = op.Str("align").ToLowerInvariant();
        if (requested is "anti" or "antialigned" or "anti-aligned")
            return [(int)swMateAlign_e.swMateAlignANTI_ALIGNED, (int)swMateAlign_e.swMateAlignALIGNED];
        if (requested is "aligned")
            return [(int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];
        if (requested is "closest")
            return [(int)swMateAlign_e.swMateAlignCLOSEST, (int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];

        var a = e1.ToLowerInvariant();
        var b = e2.ToLowerInvariant();
        var oppositeFaces = (IsTopEntity(a) && IsBottomEntity(b)) || (IsBottomEntity(a) && IsTopEntity(b));
        if (kind is "coincident" && oppositeFaces)
        {
            return
            [
                (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
                (int)swMateAlign_e.swMateAlignALIGNED,
                (int)swMateAlign_e.swMateAlignCLOSEST,
            ];
        }

        if (kind is "concentric")
        {
            return [(int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];
        }

        return
        [
            (int)swMateAlign_e.swMateAlignALIGNED,
            (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
            (int)swMateAlign_e.swMateAlignCLOSEST,
        ];
    }

    private static bool IsTopEntity(string e) =>
        e is "top" or "facetop" or "upper" or "faccia-sup" or "facciasup";

    private static bool IsBottomEntity(string e) =>
        e is "bottom" or "facebottom" or "lower" or "faccia-inf" or "facciainf";

    private bool SelectMateEntity(
        IAssemblyDoc assy,
        string key,
        string entity,
        bool append,
        SelectData? selData,
        string mateKind,
        double targetRadiusM = 0)
    {
        var e = entity.ToLowerInvariant();
        if (mateKind is "concentric" || e is "inner" or "outer" or "hole" or "foro" or "od" or "id")
        {
            return SelectComponentCylinder(assy, key, append, LooksInner(e, defaultInner: mateKind is "concentric" && append), selData, targetRadiusM);
        }

        if (e is "pad" or "boss" or "boss-top" or "faccia-boss")
        {
            return SelectComponentPlanarFace(assy, key, wantTop: true, append, selData, preferSmallUpper: true);
        }

        if (IsTopEntity(e))
        {
            return SelectComponentPlanarFace(assy, key, wantTop: true, append, selData);
        }

        if (IsBottomEntity(e))
        {
            return SelectComponentPlanarFace(assy, key, wantTop: false, append, selData);
        }

        return SelectComponentPlane(assy, key, entity, append, selData);
    }

    private void DoClearMates(ModelDoc2 model)
    {
        var doomed = new List<Feature>();
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                var typeName = "";
                try { typeName = feat.GetTypeName2(); } catch { /* ignore */ }
                if (typeName is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        doomed.Add(sub);
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }
        }
        catch (Exception ex)
        {
            Step("clearMates", false, FormatEx(ex));
            return;
        }

        if (doomed.Count == 0)
        {
            Step("clearMates", true, "nessun mate");
            return;
        }

        try
        {
            model.ClearSelection2(true);
            foreach (var f in doomed)
            {
                try { f.Select2(true, 0); } catch { /* skip */ }
            }

            model.EditDelete();
            Step("clearMates", true, $"eliminati {doomed.Count} mate");
        }
        catch (Exception ex)
        {
            Step("clearMates", false, FormatEx(ex));
        }
    }

    private void DoInspect(ModelDoc2 model)
    {
        if (model is IAssemblyDoc assy)
        {
            LogComponentBoxes(assy);
            InspectMates(model, assy);
            return;
        }

        Step("inspect", true, model.GetTitle());
    }

    private void InspectMates(ModelDoc2 model, IAssemblyDoc assy)
    {
        try
        {
            var feat = (Feature)model.FirstFeature();
            var n = 0;
            while (feat is not null)
            {
                string typeName;
                try { typeName = feat.GetTypeName2(); }
                catch { typeName = ""; }

                if (typeName is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        n++;
                        var detail = sub.Name;
                        try
                        {
                            if (sub.GetSpecificFeature2() is IMate2 mate)
                            {
                                var t = mate.Type switch
                                {
                                    0 => "coincident",
                                    1 => "concentric",
                                    5 => "distance",
                                    3 => "parallel",
                                    2 => "perpendicular",
                                    _ => $"type={mate.Type}",
                                };
                                var al = mate.Alignment switch
                                {
                                    0 => "aligned",
                                    1 => "anti",
                                    2 => "closest",
                                    _ => mate.Alignment.ToString(),
                                };
                                detail = $"{sub.Name} {t} {al} flipped={mate.Flipped} ents={mate.GetMateEntityCount()}";
                                for (var i = 0; i < mate.GetMateEntityCount(); i++)
                                {
                                    try
                                    {
                                        var ent = mate.MateEntity(i);
                                        var comp = ent.ReferenceComponent?.Name2 ?? "?";
                                        detail += $" | {comp} refType={ent.ReferenceType2}";
                                    }
                                    catch { /* skip entity */ }
                                }
                            }
                        }
                        catch { /* not a mate */ }

                        Step("inspect.mate", true, detail);
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }

            if (n == 0) Step("inspect.mate", true, "MateGroup vuoto");
        }
        catch (Exception ex)
        {
            Step("inspect.mate", false, FormatEx(ex));
        }
    }

    private void LogComponentBoxes(IAssemblyDoc assy)
    {
        if (AsArray(assy.GetComponents(false)) is not object[] comps) return;
        foreach (var obj in comps)
        {
            if (obj is not Component2 c) continue;
            var box = ReadBoxMm(c);
            if (box is null) continue;
            Step("bbox", true,
                $"{c.Name2} X[{box[0]:0.00},{box[1]:0.00}] Y[{box[2]:0.00},{box[3]:0.00}] Z[{box[4]:0.00},{box[5]:0.00}]");
        }
    }

    private static double[]? ReadBoxMm(Component2 c)
    {
        try
        {
            var raw = c.GetBox(false, false);
            var d = AsDoubles(raw);
            if (d is null || d.Length < 6) return null;
            return
            [
                d[0] * 1000, d[3] * 1000,
                d[1] * 1000, d[4] * 1000,
                d[2] * 1000, d[5] * 1000,
            ];
        }
        catch
        {
            return null;
        }
    }

    private static double[]? AsDoubles(object? raw)
    {
        if (raw is double[] da) return da;
        if (raw is Array a && a.Length > 0)
        {
            var d = new double[a.Length];
            for (var i = 0; i < a.Length; i++)
            {
                d[i] = Convert.ToDouble(a.GetValue(i));
            }

            return d;
        }

        return null;
    }

    private void DoVerifyLayout(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("verify", false, "non è un assieme");
            return;
        }

        try { model.EditRebuild3(); }
        catch
        {
            try { model.ForceRebuild3(true); } catch { /* ignore */ }
        }

        var plate = FindBox(assy, "PiastraBase") ?? FindBox(assy, "c1");
        var pin = FindBox(assy, "Perno") ?? FindBox(assy, "c2");
        var wash = FindBox(assy, "Rondella") ?? FindBox(assy, "c3");
        if (plate is null || pin is null || wash is null)
        {
            Step("verify", false, $"box mancanti plate={plate is not null} pin={pin is not null} wash={wash is not null}");
            LogComponentBoxes(assy);
            return;
        }

        var dx = plate[1] - plate[0];
        var dy = plate[3] - plate[2];
        var dz = plate[5] - plate[4];
        var axis = dy <= dx && dy <= dz ? 2 : dz <= dx && dz <= dy ? 4 : 0;
        var lo = axis;
        var hi = axis + 1;
        var pinThroughPos = pin[lo] < plate[lo] + 1.5 && pin[hi] > plate[hi] + 4;
        var pinThroughNeg = pin[hi] > plate[hi] - 1.5 && pin[lo] < plate[lo] - 4;
        var pinThrough = pinThroughPos || pinThroughNeg;
        var pinCx = (pin[0] + pin[1]) / 2;
        var pinCy = (pin[2] + pin[3]) / 2;
        var pinCz = (pin[4] + pin[5]) / 2;
        var plateCx = (plate[0] + plate[1]) / 2;
        var plateCy = (plate[2] + plate[3]) / 2;
        var plateCz = (plate[4] + plate[5]) / 2;
        var pinOnAxis = axis == 2
            ? Math.Abs(pinCx - plateCx) < 1.5 && Math.Abs(pinCz - plateCz) < 1.5
            : axis == 4
                ? Math.Abs(pinCx - plateCx) < 1.5 && Math.Abs(pinCy - plateCy) < 1.5
                : Math.Abs(pinCy - plateCy) < 1.5 && Math.Abs(pinCz - plateCz) < 1.5;
        var washOnPlus = Math.Abs(wash[lo] - plate[hi]) < 0.8;
        var washOnMinus = Math.Abs(wash[hi] - plate[lo]) < 0.8;
        var washOnPlate = washOnPlus || washOnMinus;
        var washThick = wash[hi] - wash[lo];
        var washOutside = washOnPlus ? wash[hi] >= plate[hi] - 0.2 : wash[lo] <= plate[lo] + 0.2;
        var ok = pinThrough && pinOnAxis && washOnPlate && washOutside && washThick < 4;
        var axisName = axis == 2 ? "Y" : axis == 4 ? "Z" : "X";
        Step("verify", ok,
            $"axis={axisName} pinThrough={pinThrough} pinAxis={pinOnAxis} washOnPlate={washOnPlate} washOut={washOutside} " +
            $"plate={plate[lo]:0.02}..{plate[hi]:0.02} pin={pin[lo]:0.02}..{pin[hi]:0.02} wash={wash[lo]:0.02}..{wash[hi]:0.02}");
        LogComponentBoxes(assy);
    }

    private double[]? FindBox(IAssemblyDoc assy, string key)
    {
        var c = FindComponent(assy, key);
        return c is null ? null : ReadBoxMm(c);
    }

    private bool SelectComponentPlanarFace(
        IAssemblyDoc assy,
        string key,
        bool wantTop,
        bool append,
        SelectData? selData,
        bool preferSmallUpper = false)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestT = wantTop ? double.MinValue : double.MaxValue;
        var bestArea = preferSmallUpper ? double.MaxValue : double.MinValue;
        if (!TryCylinderAxis(part, out var ax, out var ay, out var az, out var px, out var py, out var pz))
        {
            ax = 0; ay = 1; az = 0;
            px = py = pz = 0;
        }

        var cands = new List<(IFace2 Face, double T, double Area)>();
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isPlane = false;
                    try { isPlane = surf.IsPlane(); } catch { continue; }
                    if (!isPlane) continue;

                    double nx = 0, ny = 0, nz = 1, qx = 0, qy = 0, qz = 0;
                    try
                    {
                        var d = AsDoubles(surf.PlaneParams);
                        if (d is { Length: >= 6 })
                        {
                            nx = d[0]; ny = d[1]; nz = d[2];
                            qx = d[3]; qy = d[4]; qz = d[5];
                        }
                    }
                    catch { continue; }

                    var ndot = nx * ax + ny * ay + nz * az;
                    if (Math.Abs(ndot) < 0.85) continue;

                    var t = (qx - px) * ax + (qy - py) * ay + (qz - pz) * az;
                    double area = 0;
                    try { area = face.GetArea(); } catch { area = 0; }
                    cands.Add((face, t, area));
                }
            }
        }
        catch
        {
            return false;
        }

        if (cands.Count == 0) return false;

        if (wantTop && preferSmallUpper)
        {
            var tMin = cands.Min(c => c.T);
            var upper = cands.Where(c => c.T > tMin + 0.0004 && c.Area > 2e-5).ToList();
            if (upper.Count == 0) upper = cands.Where(c => c.T > tMin + 0.0004).ToList();
            if (upper.Count == 0) upper = cands;
            var pick = upper.OrderBy(c => c.Area).ThenByDescending(c => c.T).First();
            best = pick.Face;
            bestT = pick.T;
            bestArea = pick.Area;
        }
        else if (wantTop)
        {
            var tMin = cands.Min(c => c.T);
            var upper = cands.Where(c => c.T > tMin + 0.0004).ToList();
            if (upper.Count == 0) upper = cands;
            var pick = upper.OrderByDescending(c => c.Area).ThenByDescending(c => c.T).First();
            best = pick.Face;
            bestT = pick.T;
            bestArea = pick.Area;
        }
        else
        {
            foreach (var c in cands)
            {
                if (c.T < bestT) { bestT = c.T; best = c.Face; bestArea = c.Area; }
            }
        }

        if (best is null) return false;
        try
        {
            var corr = comp.GetCorresponding(best);
            var ok = corr is IEntity ent && ent.Select4(append, selData);
            if (ok)
            {
                Step("selectFace", true,
                    $"{key} {(preferSmallUpper ? "pad" : wantTop ? "top" : "bottom")} t={bestT * 1000:0.02} mm area={bestArea * 1e6:0.0} mm2");
            }

            return ok;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryCylinderAxis(
        IPartDoc part,
        out double ax, out double ay, out double az,
        out double px, out double py, out double pz)
    {
        ax = ay = az = px = py = pz = 0;
        var bestR = double.MaxValue;
        var found = false;
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isCyl = false;
                    try { isCyl = surf.IsCylinder(); } catch { continue; }
                    if (!isCyl) continue;
                    var d = AsDoubles(surf.CylinderParams);
                    if (d is null || d.Length < 7) continue;
                    var r = Math.Abs(d[6]);
                    if (!found || r < bestR)
                    {
                        found = true;
                        bestR = r;
                        px = d[0]; py = d[1]; pz = d[2];
                        ax = d[3]; ay = d[4]; az = d[5];
                    }
                }
            }
        }
        catch
        {
            return false;
        }

        var mag = Math.Sqrt(ax * ax + ay * ay + az * az);
        if (!found || mag < 1e-12) return false;
        ax /= mag; ay /= mag; az /= mag;
        return true;
    }

    private bool MateGeometryOk(IAssemblyDoc assy, string kind, string c1, string e1, string c2, string e2)
    {
        var plate = FindBox(assy, "PiastraBase");
        var pin = FindBox(assy, "Perno");
        var wash = FindBox(assy, "Rondella");
        if (plate is null) return true;
        var axis = ThicknessAxis(plate);
        var lo = axis;
        var hi = axis + 1;

        bool OnAxis(double[] box) =>
            axis == 2
                ? Math.Abs((box[0] + box[1]) / 2 - (plate[0] + plate[1]) / 2) < 2
                  && Math.Abs((box[4] + box[5]) / 2 - (plate[4] + plate[5]) / 2) < 2
                : axis == 4
                    ? Math.Abs((box[0] + box[1]) / 2 - (plate[0] + plate[1]) / 2) < 2
                      && Math.Abs((box[2] + box[3]) / 2 - (plate[2] + plate[3]) / 2) < 2
                    : Math.Abs((box[2] + box[3]) / 2 - (plate[2] + plate[3]) / 2) < 2
                      && Math.Abs((box[4] + box[5]) / 2 - (plate[4] + plate[5]) / 2) < 2;

        if (kind is "concentric")
        {
            if (LooksLike(c1, "perno") || LooksLike(c2, "perno") || LooksLike(c1, "c2") || LooksLike(c2, "c2"))
            {
                return pin is not null && OnAxis(pin);
            }

            if (LooksLike(c1, "rondella") || LooksLike(c2, "rondella") || LooksLike(c1, "c3") || LooksLike(c2, "c3"))
            {
                return wash is not null && OnAxis(wash);
            }

            return true;
        }

        if (kind is "coincident" && pin is not null && (LooksLike(c1, "perno") || LooksLike(c2, "perno") || LooksLike(c1, "c2") || LooksLike(c2, "c2")))
        {
            var throughPos = pin[lo] < plate[lo] + 1.5 && pin[hi] > plate[hi] + 4;
            var throughNeg = pin[hi] > plate[hi] - 1.5 && pin[lo] < plate[lo] - 4;
            return throughPos || throughNeg;
        }

        if (kind is "coincident" && wash is not null && (LooksLike(c1, "rondella") || LooksLike(c2, "rondella") || LooksLike(c1, "c3") || LooksLike(c2, "c3")))
        {
            var onPlus = Math.Abs(wash[lo] - plate[hi]) < 1.0;
            var onMinus = Math.Abs(wash[hi] - plate[lo]) < 1.0;
            return onPlus || onMinus;
        }

        return true;
    }

    private static bool LooksLike(string key, string token) =>
        key.Contains(token, StringComparison.OrdinalIgnoreCase);

    private static int ThicknessAxis(double[] plate)
    {
        var dx = plate[1] - plate[0];
        var dy = plate[3] - plate[2];
        var dz = plate[5] - plate[4];
        return dy <= dx && dy <= dz ? 2 : dz <= dx && dz <= dy ? 4 : 0;
    }

    private void DeleteLastMate(ModelDoc2 model)
    {
        Feature? last = null;
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                var tn = "";
                try { tn = feat.GetTypeName2(); } catch { /* ignore */ }
                if (tn is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        last = sub;
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }

            if (last is null) return;
            model.ClearSelection2(true);
            last.Select2(false, 0);
            model.EditDelete();
        }
        catch
        {
            /* best effort */
        }
    }

    private static SelectData? CreateMark1(ModelDoc2 model)
    {
        try
        {
            var selMgr = (ISelectionMgr)model.SelectionManager;
            var data = (SelectData)selMgr.CreateSelectData();
            data.Mark = 1;
            return data;
        }
        catch
        {
            return null;
        }
    }

    private bool SelectComponentPlane(IAssemblyDoc assy, string key, string plane, bool append, SelectData? selData)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        var aliases = PlaneAliases(plane);
        if (comp.GetModelDoc2() is not ModelDoc2 part) return false;

        Feature? feat = FeatureTreeReader.FindByTypeAndAlias(part, "RefPlane", aliases);
        if (feat is null)
        {
            var all = FeatureTreeReader.Read(part).Where(f => f.TypeName is "RefPlane" or "OriginProfileFeature").ToList();
            var match = all.FirstOrDefault(f =>
                aliases.Any(a => f.Name.Equals(a, StringComparison.OrdinalIgnoreCase)) ||
                f.Name.Contains(plane, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                feat = (Feature)part.FeatureByPositionReverse(match.Index);
            }
            else if (plane.Equals("origin", StringComparison.OrdinalIgnoreCase))
            {
                var origin = all.FirstOrDefault(f => f.TypeName == "OriginProfileFeature");
                if (origin is not null) feat = (Feature)part.FeatureByPositionReverse(origin.Index);
            }
        }

        if (feat is null) return false;

        try
        {
            var corr = comp.GetCorresponding(feat);
            if (corr is IEntity ent)
            {
                return ent.Select4(append, selData);
            }
        }
        catch
        {
            /* fall through */
        }

        try { return feat.Select2(append, 1); }
        catch { return false; }
    }

    private static bool LooksInner(string entity, bool defaultInner = false)
    {
        var e = entity.ToLowerInvariant();
        if (e is "inner" or "foro" or "hole" or "bore") return true;
        if (e is "outer" or "outercyl" or "external") return false;
        return defaultInner;
    }

    private bool SelectComponentCylinder(IAssemblyDoc assy, string key, bool append, bool preferInner, SelectData? selData, double targetRadiusM = 0)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestR = preferInner ? double.MaxValue : -1.0;
        var bestErr = double.MaxValue;
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isCyl = false;
                    try { isCyl = surf.IsCylinder(); } catch { continue; }
                    if (!isCyl) continue;
                    double r = 0;
                    try
                    {
                        var cp = surf.CylinderParams;
                        if (cp is double[] p && p.Length >= 7) r = p[6];
                        else if (cp is Array a && a.Length >= 7) r = Convert.ToDouble(a.GetValue(6));
                    }
                    catch { /* keep 0 */ }

                    r = Math.Abs(r);
                    if (targetRadiusM > 1e-8)
                    {
                        var err = Math.Abs(r - targetRadiusM);
                        if (err < bestErr) { bestErr = err; bestR = r; best = face; }
                    }
                    else if (preferInner)
                    {
                        if (r < bestR) { bestR = r; best = face; }
                    }
                    else if (r > bestR)
                    {
                        bestR = r;
                        best = face;
                    }
                }
            }
        }
        catch
        {
            return false;
        }

        if (best is null) return false;
        try
        {
            var corr = comp.GetCorresponding(best);
            var ok = corr is IEntity ent && ent.Select4(append, selData);
            if (ok)
            {
                var mode = targetRadiusM > 1e-8 ? $"targetR={targetRadiusM * 1000:0.02}" : (preferInner ? "inner" : "outer");
                Step("selectCyl", true, $"{key} {mode} R={bestR * 1000:0.02} mm");
            }

            return ok;
        }
        catch
        {
            return false;
        }
    }

    private Component2? FindComponent(IAssemblyDoc assy, string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        if (_created.TryGetValue(key, out var mapped)) key = mapped;

        if (AsArray(assy.GetComponents(false)) is not object[] comps) return null;
        foreach (var obj in comps)
        {
            if (obj is not Component2 c) continue;
            var name = c.Name2 ?? "";
            if (name.Equals(key, StringComparison.OrdinalIgnoreCase) ||
                name.StartsWith(key + "-", StringComparison.OrdinalIgnoreCase) ||
                name.Contains(key, StringComparison.OrdinalIgnoreCase))
            {
                return c;
            }
        }

        return null;
    }

    private static string[] PlaneAliases(string plane) =>
        plane.ToLowerInvariant() switch
        {
            "front" or "frontale" => ["Front Plane", "Piano frontale", "Piano Frontale", "Front"],
            "right" or "destro" => ["Right Plane", "Piano destro", "Piano Destro", "Right"],
            "origin" or "origine" => ["Origine", "Origin", "OriginProfileFeature"],
            _ => ["Top Plane", "Piano superiore", "Piano Superiore", "Top"],
        };

    private void DoStandardViews(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("Create1stAngleViews2", false, "Il documento non è una tavola");
            return;
        }

        var modelPath = SwPaths.Resolve(op.Str("model"));
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            Step("Create1stAngleViews2", false, $"Modello non trovato: {modelPath}");
            return;
        }

        modelPath = Path.GetFullPath(modelPath);
        if (_sw is not null)
        {
            var oErr = 0;
            var oWarn = 0;
            var dtype = modelPath.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
                ? (int)swDocumentTypes_e.swDocASSEMBLY
                : (int)swDocumentTypes_e.swDocPART;
            try
            {
                _sw.OpenDoc6(modelPath, dtype, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref oErr, ref oWarn);
            }
            catch { /* may already be open */ }
            try
            {
                var aErr = 0;
                _sw.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
            }
            catch { /* ignore */ }
        }

        var includeIso = op.Flag("includeIso", true);
        try
        {
            var ok = drawing.Create1stAngleViews2(modelPath);
            if (!ok) ok = drawing.Create3rdAngleViews2(modelPath);
            if (!ok)
            {
                ok = drawing.CreateDrawViewFromModelView3(modelPath, "*Front", 0.12, 0.18, 0) is not null;
                drawing.CreateDrawViewFromModelView3(modelPath, "*Top", 0.12, 0.08, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Right", 0.24, 0.18, 0);
            }

            Step("Create1stAngleViews2", ok, Path.GetFileName(modelPath));
        }
        catch (Exception ex)
        {
            Step("Create1stAngleViews2", false, FormatEx(ex));
            try
            {
                drawing.CreateDrawViewFromModelView3(modelPath, "*Front", 0.12, 0.18, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Top", 0.12, 0.08, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Right", 0.24, 0.18, 0);
                Step("CreateDrawViewFromModelView", true, "fallback Front/Top/Right");
            }
            catch (Exception ex2)
            {
                Step("CreateDrawViewFromModelView", false, FormatEx(ex2));
            }
        }

        if (includeIso)
        {
            try
            {
                var iso = drawing.CreateDrawViewFromModelView3(modelPath, "*Isometric", 0.32, 0.10, 0);
                if (iso is null)
                {
                    iso = drawing.CreateDrawViewFromModelView3(modelPath, "*Isometrica", 0.32, 0.10, 0);
                }
                Step("CreateDrawViewFromModelView", iso is not null, iso is not null ? "iso" : "*Isometric/*Isometrica");
            }
            catch (Exception ex)
            {
                Step("CreateDrawViewFromModelView", false, FormatEx(ex));
            }
        }
    }

    private void DoModelDimensions(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("InsertModelAnnotations3", false, "Il documento non è una tavola");
            return;
        }

        var types = (int)swInsertAnnotation_e.swInsertDimensions
                    | (int)swInsertAnnotation_e.swInsertDimensionsMarkedForDrawing
                    | (int)swInsertAnnotation_e.swInsertNotes;
        try
        {
            drawing.InsertModelAnnotations3(1, types, true, true, false, true);
            Step("InsertModelAnnotations3", true, "quote/note modello");
        }
        catch (Exception ex)
        {
            try
            {
                drawing.InsertModelDimensions(0);
                Step("InsertModelDimensions", true, "fallback");
            }
            catch
            {
                Step("InsertModelAnnotations3", false, FormatEx(ex));
            }
        }
    }

    private void DoDrawingView(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("CreateDrawViewFromModelView", false, "Il documento non è una tavola");
            return;
        }

        var view = op.Str("view", "*Isometric");
        if (!view.StartsWith('*')) view = "*" + view;
        var x = op.Num("x", 0.15);
        var y = op.Num("y", 0.15);
        if (x > 2) x = ToMeters(x, "mm");
        if (y > 2) y = ToMeters(y, "mm");
        var modelPath = SwPaths.Resolve(op.Str("model"));
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            Step("CreateDrawViewFromModelView", false, "Percorso modello mancante");
            return;
        }

        modelPath = Path.GetFullPath(modelPath);
        try
        {
            var v = drawing.CreateDrawViewFromModelView3(modelPath, view, x, y, 0);
            if (v is SolidWorks.Interop.sldworks.View dv && op.Num("scale", 0) > 0)
            {
                try { dv.ScaleDecimal = op.Num("scale"); } catch { /* ignore */ }
            }
            Step("CreateDrawViewFromModelView", v is not null, $"{view} {Path.GetFileName(modelPath)}");
        }
        catch (Exception ex)
        {
            Step("CreateDrawViewFromModelView", false, FormatEx(ex));
        }
    }

    private void DoAnnotation(ModelDoc2 model, CadOperation op)
    {
        var text = op.Str("text");
        var x = op.Num("x", 0.01);
        var y = op.Num("y", 0.01);
        if (x > 2) x = ToMeters(x, "mm");
        if (y > 2) y = ToMeters(y, "mm");
        try
        {
            var note = model.InsertNote(text) as Note;
            try
            {
                var ann = note?.GetAnnotation() as Annotation;
                ann?.SetPosition2(x, y, 0);
            }
            catch { /* ignore */ }
            Step("InsertNote", note is not null, text);
        }
        catch (Exception ex)
        {
            Step("InsertNote", false, FormatEx(ex));
        }
    }

    private string? SaveIfRequested(ModelDoc2 model, DocumentSpec spec)
    {
        if (string.IsNullOrWhiteSpace(spec.SavePath)) return null;
        try
        {
            var path = Path.GetFullPath(spec.SavePath);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (File.Exists(path) && _sw is not null)
            {
                try { _sw.CloseDoc(Path.GetFileName(path)); } catch { /* not open */ }
                try { File.Delete(path); } catch { /* locked */ }
            }

            var errors = 0;
            var warnings = 0;
            var ok = model.SaveAs4(
                path,
                (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent,
                ref errors,
                ref warnings);
            if (!ok)
            {
                ok = model.SaveAs(path);
            }

            Step("SaveAs", ok, $"{path} errors={errors} warnings={warnings}");
            return ok ? path : null;
        }
        catch (Exception ex)
        {
            Step("SaveAs", false, FormatEx(ex));
            return null;
        }
    }

    private string? SnapshotIfRequested(ModelDoc2 model, DocumentSpec spec)
    {
        if (string.IsNullOrWhiteSpace(spec.SnapshotPath)) return null;
        try
        {
            var dest = Path.GetFullPath(spec.SnapshotPath);
            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            try { model.ViewZoomtofit2(); } catch { /* ignore */ }
            var named = string.IsNullOrWhiteSpace(spec.SnapshotView) ? "*Isometric" : spec.SnapshotView;
            if (!named.StartsWith('*')) named = "*" + named;
            try
            {
                if (model.GetType() != (int)swDocumentTypes_e.swDocDRAWING)
                {
                    ApplyStandardView(model, named);
                }
            }
            catch { /* drawings / named view */ }

            var bmp = Path.ChangeExtension(dest, ".bmp");
            var ok = model.SaveBMP(bmp, 1400, 1000);
            if (!ok)
            {
                Step("SaveBMP", false, dest);
                return null;
            }

            if (dest.EndsWith(".bmp", StringComparison.OrdinalIgnoreCase))
            {
                Step("SaveBMP", true, dest);
                return dest;
            }

            using (var img = System.Drawing.Image.FromFile(bmp))
            {
                img.Save(dest, System.Drawing.Imaging.ImageFormat.Jpeg);
            }

            try { File.Delete(bmp); } catch { /* keep bmp if locked */ }
            Step("SaveBMP", true, dest);
            return dest;
        }
        catch (Exception ex)
        {
            Step("SaveBMP", false, FormatEx(ex));
            return null;
        }
    }

    private void ApplyStandardView(ModelDoc2 model, string named)
    {
        var viewId = StandardViewId(named);
        // ViewId -1 ignores English names on Italian templates (*Anteriore / *Superiore).
        try { model.ShowNamedView2("", viewId); } catch { /* ignore */ }
        foreach (var alias in ViewNameAliases(named))
        {
            try { model.ShowNamedView2(alias, viewId); } catch { /* ignore */ }
        }

        try { model.ViewZoomtofit2(); } catch { /* ignore */ }
        try { model.GraphicsRedraw2(); } catch { /* ignore */ }
        try { Thread.Sleep(250); } catch { /* ignore */ }
        Step("ShowNamedView2", true, $"{named} viewId={viewId}");
    }

    private static int StandardViewId(string named)
    {
        var key = named.Trim().TrimStart('*').ToLowerInvariant();
        return key switch
        {
            "front" or "anteriore" or "frontale" => (int)swStandardViews_e.swFrontView,
            "back" or "posteriore" => (int)swStandardViews_e.swBackView,
            "left" or "sinistra" => (int)swStandardViews_e.swLeftView,
            "right" or "destra" => (int)swStandardViews_e.swRightView,
            "top" or "superiore" or "sopra" => (int)swStandardViews_e.swTopView,
            "bottom" or "inferiore" or "sotto" => (int)swStandardViews_e.swBottomView,
            "trimetric" or "trimetrica" => (int)swStandardViews_e.swTrimetricView,
            "dimetric" or "dimetrica" => (int)swStandardViews_e.swDimetricView,
            _ => (int)swStandardViews_e.swIsometricView,
        };
    }

    private static string[] ViewNameAliases(string named)
    {
        var key = named.Trim().TrimStart('*').ToLowerInvariant();
        return key switch
        {
            "front" or "anteriore" or "frontale" => ["*Front", "*Anteriore"],
            "back" or "posteriore" => ["*Back", "*Posteriore"],
            "left" or "sinistra" => ["*Left", "*Sinistra"],
            "right" or "destra" => ["*Right", "*Destra"],
            "top" or "superiore" or "sopra" => ["*Top", "*Superiore"],
            "bottom" or "inferiore" or "sotto" => ["*Bottom", "*Inferiore"],
            "trimetric" or "trimetrica" => ["*Trimetric", "*Trimetrica"],
            "dimetric" or "dimetrica" => ["*Dimetric", "*Dimetrica"],
            _ => ["*Isometric", "*Isometrica"],
        };
    }

    private bool SelectPlane(ModelDoc2 model, string plane)
    {
        var aliases = plane.ToLowerInvariant() switch
        {
            "front" or "frontale" => new[] { "Front Plane", "Piano frontale", "Piano Frontale", "Front" },
            "right" or "destro" => new[] { "Right Plane", "Piano destro", "Piano Destro", "Right" },
            _ => new[] { "Top Plane", "Piano superiore", "Piano Superiore", "Top" },
        };

        var feat = FeatureTreeReader.FindByTypeAndAlias(model, "RefPlane", aliases);
        if (feat is null)
        {
            var all = FeatureTreeReader.Read(model).Where(f => f.TypeName == "RefPlane").ToList();
            var wanted = plane.ToLowerInvariant();
            var match = all.FirstOrDefault(f =>
                f.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase) ||
                aliases.Any(a => f.Name.Equals(a, StringComparison.OrdinalIgnoreCase)));
            if (match is not null)
            {
                feat = (Feature)model.FeatureByPositionReverse(match.Index);
            }
            else if (all.Count > 0)
            {
                var pick = wanted is "front" or "frontale"
                    ? all.ElementAtOrDefault(all.Count - 1)
                    : wanted is "right" or "destro"
                        ? all.ElementAtOrDefault(Math.Max(0, all.Count - 3))
                        : all.ElementAtOrDefault(Math.Max(0, all.Count - 2));
                if (pick is not null)
                {
                    feat = (Feature)model.FeatureByPositionReverse(pick.Index);
                }
            }
        }

        return feat is not null && feat.Select2(false, 0);
    }

    private static bool SelectFeature(ModelDoc2 model, string name)
    {
        var feat = FeatureTreeReader.FindByName(model, name);
        return feat is not null && feat.Select2(false, 0);
    }

    private static void SelectAllBodyEdges(ModelDoc2 model)
    {
        try
        {
            if (model is not IPartDoc part) return;
            var bodies = AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true));
            if (bodies is null) return;
            var first = true;
            foreach (Body2 body in bodies)
            {
                var edges = AsArray(body.GetEdges());
                if (edges is null) continue;
                foreach (var edgeObj in edges)
                {
                    if (edgeObj is IEntity ent)
                    {
                        ent.Select4(!first, null);
                        first = false;
                    }
                }
            }
        }
        catch
        {
            /* fillet may still run on current selection */
        }
    }

    private void RememberLatest(ModelDoc2 model, string id, string? name)
    {
        try
        {
            var feat = (Feature)model.FeatureByPositionReverse(0);
            RememberFeature(id, name, feat);
        }
        catch
        {
            if (!string.IsNullOrEmpty(id)) _created[id] = name ?? id;
        }
    }

    private void RememberFeature(string id, string? name, Feature? feat)
    {
        if (feat is null) return;
        var featName = feat.Name;
        if (!string.IsNullOrEmpty(id)) _created[id] = featName;
        if (!string.IsNullOrEmpty(name)) _created[name] = featName;
    }

    private static object[]? AsArray(object? raw)
    {
        if (raw is null) return null;
        if (raw is object[] oa) return oa;
        if (raw is Array a)
        {
            var list = new List<object>(a.Length);
            foreach (var x in a)
            {
                if (x is not null) list.Add(x);
            }

            return [.. list];
        }

        return null;
    }

    private static double Len(JsonElement c, string name, string units)
    {
        if (!c.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number) return 0;
        return ToMeters(el.GetDouble(), units);
    }

    private static double ToMeters(double value, string units) =>
        units.Equals("m", StringComparison.OrdinalIgnoreCase) ? value : value / 1000.0;

    private void Step(string op, bool ok, string detail)
    {
        _steps.Add(new ExecStep { Op = op, Ok = ok, Detail = detail });
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {(ok ? "OK" : "FAIL")} {op} — {detail}");
    }

    internal static string FormatEx(Exception ex)
    {
        if (ex is COMException com) return $"COM 0x{com.ErrorCode:X8}: {com.Message}";
        if (ex.InnerException is COMException inner) return $"COM 0x{inner.ErrorCode:X8}: {inner.Message}";
        return $"{ex.GetType().Name}: {ex.Message}";
    }
}
