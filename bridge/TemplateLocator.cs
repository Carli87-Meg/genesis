namespace SolidWorksBridge;

internal static class TemplateLocator
{
    private static readonly string[] PartCandidates =
    [
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Parte.PRTDOT",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Part.PRTDOT",
        @"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\03_Risorse_CAD\Impostazioni_SolidWorks\Modelli del documento\Parte.prtdot",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2024\templates\Parte.PRTDOT",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2024\templates\Part.PRTDOT",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2023\templates\Parte.PRTDOT",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2023\templates\Part.PRTDOT",
    ];

    private static readonly string[] AssemblyCandidates =
    [
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Assieme.ASMDOT",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Assembly.ASMDOT",
        @"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\03_Risorse_CAD\Impostazioni_SolidWorks\Modelli del documento\Assieme.asmdot",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\MBD\assembly 0251mm to 1000mm.asmdot",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2024\templates\MBD\assembly 0251mm to 1000mm.asmdot",
    ];

    private static readonly string[] DrawingCandidates =
    [
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Disegno.DRWDOT",
        @"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\data\templates\iso.drwdot",
        @"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\03_Risorse_CAD\Impostazioni_SolidWorks\Modelli del documento\ACS\Disegno.drwdot",
        @"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Drawing.DRWDOT",
        @"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\lang\italian\slddrawings\iso.drwdot",
    ];

    public static string Part() => FirstExisting(PartCandidates, "Parte.PRTDOT");

    public static string Assembly() => FirstExisting(AssemblyCandidates, "Assembly.asmdot");

    public static IEnumerable<string> ExistingDrawingTemplates()
    {
        foreach (var p in DrawingCandidates)
        {
            if (File.Exists(p)) yield return p;
        }
    }

    public static string Drawing() => FirstExisting(DrawingCandidates, "iso.drwdot");

    public static string? SheetFormat(string? hint)
    {
        var dir = Path.Combine(SwPaths.RisorseCad, @"Cartigli_Template", "Cartiglio_CM");
        var a3 = Path.Combine(dir, "PARTE_A3_CM.slddrt");
        var a2 = Path.Combine(dir, "PARTE_A2_CM.slddrt");
        var h = (hint ?? "A3").Trim();
        if (File.Exists(h)) return Path.GetFullPath(h);
        var resolved = SwPaths.Resolve(h);
        if (File.Exists(resolved) &&
            resolved.EndsWith(".slddrt", StringComparison.OrdinalIgnoreCase))
        {
            return resolved;
        }

        if (h.Contains("A2", StringComparison.OrdinalIgnoreCase) && File.Exists(a2)) return a2;
        if (File.Exists(a3)) return a3;
        if (File.Exists(a2)) return a2;
        return null;
    }

    private static string FirstExisting(IEnumerable<string> paths, string fallback)
    {
        foreach (var p in paths)
        {
            if (File.Exists(p))
            {
                return p;
            }
        }

        return fallback;
    }
}
