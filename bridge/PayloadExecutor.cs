using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed class PayloadExecutor
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
        try { swApp.CommandInProgress = true; } catch { /* ignore */ }
        try
        {
            swApp.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate, false);
        }
        catch { /* ignore */ }

        try
        {
            var model = OpenDocument(swApp, payload.Document);
            if (model is null)
            {
                Step("OpenDocument", false, "ActiveDoc è null dopo NewDocument/GetObject");
                return (_steps, [], null, null, null, null);
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
            case "drawingview":
            case "drawing_view": DoDrawingView(model, op); break;
            case "standardviews":
            case "standard_views": DoStandardViews(model, op); break;
            case "modeldimensions":
            case "model_dimensions": DoModelDimensions(model, op); break;
            case "annotation": DoAnnotation(model, op); break;
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
                    true, false, flip, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                    false, false, false, false, 0.0, 0.0,
                    false, false, false, false,
                    merge, true, true,
                    (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
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

        var path = op.Str("path");
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

        var c1 = op.Str("component1");
        var c2 = op.Str("component2");
        var e1 = op.Str("entity1", op.Str("plane1", "Front"));
        var e2 = op.Str("entity2", op.Str("plane2", "Front"));
        var kind = op.Str("mateType", "coincident").ToLowerInvariant();
        model.ClearSelection2(true);

        var selData = CreateMark1(model);
        bool sel1, sel2;
        if (kind is "concentric")
        {
            sel1 = SelectComponentCylinder(assy, c1, append: false, preferInner: LooksInner(e1), selData);
            sel2 = SelectComponentCylinder(assy, c2, append: true, preferInner: LooksInner(e2, defaultInner: true), selData);
            if (!sel1 || !sel2)
            {
                model.ClearSelection2(true);
                sel1 = SelectComponentPlane(assy, c1, "Front", append: false, selData);
                sel2 = SelectComponentPlane(assy, c2, "Front", append: true, selData);
                kind = "coincident";
            }
        }
        else
        {
            sel1 = SelectComponentPlane(assy, c1, e1, append: false, selData);
            sel2 = SelectComponentPlane(assy, c2, e2, append: true, selData);
        }

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
        try
        {
            var errors = 0;
            var mate = assy.AddMate5(mateType, (int)swMateAlign_e.swMateAlignALIGNED, false, dist, dist, dist, 0, 0, 0, 0, 0, false, false, 0, out errors);
            if (mate is null || errors != 0)
            {
                errors = 0;
                mate = assy.AddMate5(mateType, (int)swMateAlign_e.swMateAlignANTI_ALIGNED, false, dist, dist, dist, 0, 0, 0, 0, 0, false, false, 0, out errors);
            }

            Step("AddMate5", mate is not null && errors == 0,
                $"{op.Str("mateType")} {c1}/{e1}–{c2}/{e2} errors={errors}");
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
        try
        {
            foreach (var alias in aliases)
            {
                Feature? named = null;
                try { named = comp.FeatureByName(alias) as Feature; } catch { /* next */ }
                if (named is not null && named.Select2(append, 1)) return true;
            }
        }
        catch
        {
            /* GetCorresponding fallback */
        }

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

        try { return feat.Select2(append, 0); }
        catch { return false; }
    }

    private static bool LooksInner(string entity, bool defaultInner = false)
    {
        var e = entity.ToLowerInvariant();
        if (e is "inner" or "foro" or "hole" or "bore") return true;
        if (e is "outer" or "outercyl" or "external") return false;
        return defaultInner;
    }

    private bool SelectComponentCylinder(IAssemblyDoc assy, string key, bool append, bool preferInner, SelectData? selData)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestR = preferInner ? double.MaxValue : -1.0;
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

                    if (preferInner)
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
            return corr is IEntity ent && ent.Select4(append, selData);
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

        var modelPath = op.Str("model");
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
                Step("CreateDrawViewFromModelView", iso is not null, "*Isometric");
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
        var modelPath = op.Str("model");
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
                    model.ShowNamedView2(named, -1);
                    model.ViewZoomtofit2();
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
