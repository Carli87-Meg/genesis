using System.Text.Json;
using System.Text.Json.Serialization;

namespace SolidWorksBridge;

public sealed class SolidWorksDocumentPayload
{
    public int SchemaVersion { get; set; } = 2;
    public string Units { get; set; } = "mm";
    public DocumentSpec Document { get; set; } = new();
    public List<CadVariable> Variables { get; set; } = [];
    public List<CadConfiguration> Configurations { get; set; } = [];
    public List<CadOperation> Operations { get; set; } = [];
}

public sealed class DocumentSpec
{
    public string Type { get; set; } = "part";
    public string Name { get; set; } = "Documento";
    public bool AttachToActive { get; set; }
    public string? SavePath { get; set; }
    public string? SnapshotPath { get; set; }
    public string? SnapshotView { get; set; }
    public string? OpenPath { get; set; }
    public string? SheetFormat { get; set; }
}

public sealed class CadVariable
{
    public string Name { get; set; } = "";
    public double Value { get; set; }
    public string? Units { get; set; }
}

public sealed class CadConfiguration
{
    public string Name { get; set; } = "";
    public List<string> Suppress { get; set; } = [];
    public List<string> Unsuppress { get; set; } = [];
    public List<CadVariable> Overrides { get; set; } = [];
}

public sealed class CadOperation
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string? Name { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; set; }

    public JsonElement? Field(string name)
    {
        if (Extra is null)
        {
            return null;
        }

        return Extra.TryGetValue(name, out var el) ? el : null;
    }

    public string Str(string name, string fallback = "")
    {
        var el = Field(name);
        return el?.ValueKind == JsonValueKind.String ? el.Value.GetString() ?? fallback : fallback;
    }

    public bool Flag(string name, bool fallback = false)
    {
        var el = Field(name);
        return el?.ValueKind == JsonValueKind.True
            ? true
            : el?.ValueKind == JsonValueKind.False
                ? false
                : fallback;
    }

    public double Num(string name, double fallback = 0)
    {
        var el = Field(name);
        if (el is null)
        {
            return fallback;
        }

        if (el.Value.ValueKind == JsonValueKind.Number)
        {
            return el.Value.GetDouble();
        }

        if (el.Value.ValueKind == JsonValueKind.String &&
            double.TryParse(el.Value.GetString(), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var d))
        {
            return d;
        }

        return fallback;
    }
}

public sealed class ExecStep
{
    public string Op { get; set; } = "";
    public bool Ok { get; set; }
    public string Detail { get; set; } = "";
}

public sealed class FeatureInfo
{
    public int Index { get; set; }
    public string Name { get; set; } = "";
    public string TypeName { get; set; } = "";
}

public sealed class BridgeResponse
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? AttachPath { get; set; }
    public string? Version { get; set; }
    public string? Document { get; set; }
    public int? DocumentType { get; set; }
    public string? SavedPath { get; set; }
    public string? SnapshotPath { get; set; }
    public List<ExecStep> Steps { get; set; } = [];
    public List<FeatureInfo> Features { get; set; } = [];
}
