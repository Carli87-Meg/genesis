namespace SolidWorksBridge;

/// <summary>
/// Company CAD lives under CADTM_BUSINESS. ProgramData is the SolidWorks install tree — do not dump archives there.
/// </summary>
internal static class SwPaths
{
    public const string BusinessRoot = @"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS";
    public const string Progetti3d = BusinessRoot + @"\00_PROGETTI_3D";
    public const string RisorseCad = Progetti3d + @"\03_Risorse_CAD";
    public const string Impostazioni = RisorseCad + @"\Impostazioni_SolidWorks";
    public const string ProjectRoot = Progetti3d + @"\01_Progetti_Attivi\SolidworksIA";

    public static string OutRoot()
    {
        var env = Environment.GetEnvironmentVariable("SOLIDWORKS_OUT_DIR");
        if (!string.IsNullOrWhiteSpace(env))
        {
            return Path.GetFullPath(env);
        }

        return ProjectRoot;
    }

    public static string Resolve(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return path ?? "";
        var trimmed = path.Trim();
        if (Path.IsPathRooted(trimmed)) return Path.GetFullPath(trimmed);
        return Path.GetFullPath(Path.Combine(OutRoot(), trimmed));
    }

    public static void EnsureProjectFolders()
    {
        foreach (var dir in new[]
                 {
                     Path.Combine(OutRoot(), "CAD"),
                     Path.Combine(OutRoot(), "Disegni"),
                     Path.Combine(OutRoot(), "Export"),
                     Path.Combine(OutRoot(), "Riferimenti"),
                 })
        {
            Directory.CreateDirectory(dir);
        }
    }
}
