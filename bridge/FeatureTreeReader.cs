using SolidWorks.Interop.sldworks;

namespace SolidWorksBridge;

internal static class FeatureTreeReader
{
    /// <summary>
    /// Walk the feature tree with FeatureByPositionReverse + GetTypeName2.
    /// Never SelectByID2.
    /// </summary>
    public static List<FeatureInfo> Read(object? modelObj)
    {
        var list = new List<FeatureInfo>();
        if (modelObj is not ModelDoc2 model)
        {
            return list;
        }

        var count = 256;
        try
        {
            count = model.GetFeatureCount();
        }
        catch
        {
            /* keep cap */
        }

        for (var i = 0; i < count; i++)
        {
            Feature? feat = null;
            try
            {
                feat = (Feature)model.FeatureByPositionReverse(i);
                if (feat is null)
                {
                    break;
                }

                string typeName;
                try { typeName = feat.GetTypeName2(); }
                catch { typeName = feat.GetTypeName(); }

                list.Add(new FeatureInfo
                {
                    Index = i,
                    Name = feat.Name,
                    TypeName = typeName,
                });
            }
            catch
            {
                break;
            }
        }

        return list;
    }

    public static Feature? FindByTypeAndAlias(ModelDoc2 model, string typeName, params string[] aliases)
    {
        foreach (var info in Read(model))
        {
            if (!string.Equals(info.TypeName, typeName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var alias in aliases)
            {
                if (string.Equals(info.Name, alias, StringComparison.OrdinalIgnoreCase))
                {
                    return (Feature)model.FeatureByPositionReverse(info.Index);
                }
            }
        }

        return null;
    }

    public static Feature? FindByName(ModelDoc2 model, string name)
    {
        foreach (var info in Read(model))
        {
            if (string.Equals(info.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return (Feature)model.FeatureByPositionReverse(info.Index);
            }
        }

        return null;
    }
}
