using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    private static readonly (string Key, int Id)[] FileLocationPrefs =
    [
        ("ReferencedDocuments", (int)swUserPreferenceStringValue_e.swFileLocationsDocuments),
        ("DocumentTemplates", (int)swUserPreferenceStringValue_e.swFileLocationsDocumentTemplates),
        ("SheetFormat", (int)swUserPreferenceStringValue_e.swFileLocationsSheetFormat),
        ("DefaultTemplatePart", (int)swUserPreferenceStringValue_e.swDefaultTemplatePart),
        ("DefaultTemplateAssembly", (int)swUserPreferenceStringValue_e.swDefaultTemplateAssembly),
        ("DefaultTemplateDrawing", (int)swUserPreferenceStringValue_e.swDefaultTemplateDrawing),
        ("Blocks", (int)swUserPreferenceStringValue_e.swFileLocationsBlocks),
        ("DesignLibrary", (int)swUserPreferenceStringValue_e.swFileLocationsDesignLibrary),
        ("Macros", (int)swUserPreferenceStringValue_e.swFileLocationsMacros),
        ("CustomPropertyFile", (int)swUserPreferenceStringValue_e.swFileLocationsCustomPropertyFile),
        ("MaterialDatabases", (int)swUserPreferenceStringValue_e.swFileLocationsMaterialDatabases),
        ("WeldmentProfiles", (int)swUserPreferenceStringValue_e.swFileLocationsWeldmentProfiles),
        ("WeldmentPropertyFile", (int)swUserPreferenceStringValue_e.swFileLocationsWeldmentPropertyFile),
        ("WeldmentCutListTemplates", (int)swUserPreferenceStringValue_e.swFileLocationsWeldmentCutListTemplates),
        ("BOMTemplates", (int)swUserPreferenceStringValue_e.swFileLocationsBOMTemplates),
        ("DraftingStandard", (int)swUserPreferenceStringValue_e.swFileLocationsDraftingStandard),
        ("HoleWizardToolbox", (int)swUserPreferenceStringValue_e.swHoleWizardToolBoxFolder),
        ("SearchPaths", (int)swUserPreferenceStringValue_e.swFileLocationsSearchPaths),
        ("DefaultSave", (int)swUserPreferenceStringValue_e.swFileLocationsDefaultSave),
        ("WeldTableTemplate", (int)swUserPreferenceStringValue_e.swFileLocationsWeldTableTemplate),
        ("NewSheetFormat", (int)swUserPreferenceStringValue_e.swFileLocationsNewSheetFormat),
    ];

    private void DoFileLocations()
    {
        if (_sw is null)
        {
            Step("fileLocations", false, "Nessuna sessione SolidWorks");
            return;
        }

        foreach (var (key, id) in FileLocationPrefs)
        {
            try
            {
                var value = _sw.GetUserPreferenceStringValue(id) ?? "";
                var missing = MissingPathTokens(value);
                Step($"fileLocations.{key}", missing.Count == 0, string.IsNullOrEmpty(value) ? "(vuoto)" : value);
                foreach (var miss in missing)
                {
                    Step($"fileLocations.{key}.missing", false, miss);
                }
            }
            catch (Exception ex)
            {
                Step($"fileLocations.{key}", false, FormatEx(ex));
            }
        }
    }

    private void DoSetFileLocation(CadOperation op)
    {
        if (_sw is null)
        {
            Step("setFileLocation", false, "Nessuna sessione SolidWorks");
            return;
        }

        var key = op.Str("key");
        var value = op.Str("value");
        var match = FileLocationPrefs.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
        if (match.Key is null)
        {
            Step("setFileLocation", false, $"Chiave sconosciuta: {key}");
            return;
        }

        try
        {
            var ok = _sw.SetUserPreferenceStringValue(match.Id, value);
            var readBack = _sw.GetUserPreferenceStringValue(match.Id) ?? "";
            Step("setFileLocation", ok && string.Equals(readBack, value, StringComparison.OrdinalIgnoreCase),
                $"{match.Key} => {readBack}");
        }
        catch (Exception ex)
        {
            Step("setFileLocation", false, $"{key}: {FormatEx(ex)}");
        }
    }

    private static List<string> MissingPathTokens(string value)
    {
        var missing = new List<string>();
        foreach (var raw in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var token = raw;
            if (token.Contains("CURRENT_USER", StringComparison.OrdinalIgnoreCase)) continue;
            if (File.Exists(token) || Directory.Exists(token)) continue;
            missing.Add(token);
        }

        return missing;
    }
}
