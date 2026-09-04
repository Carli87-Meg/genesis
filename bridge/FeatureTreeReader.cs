using System.Runtime.InteropServices;

namespace SolidWorksBridge;

internal static class FeatureTreeReader
{
    /// <summary>
    /// Walk the feature tree with FeatureByPositionReverse + GetTypeName2.
    /// Never SelectByID2.
    /// </summary>
    public static List<FeatureInfo> Read(dynamic model)
    {
        var list = new List<FeatureInfo>();
        if (model is null)
        {
            return list;
        }

        int count = 0;
        try
        {
            count = (int)model.GetFeatureCount();
        }
        catch
        {
            try
            {
                count = (int)model.GetFeatureCount(0);
            }
            catch
            {
                count = 256;
            }
        }

        for (var i = 0; i < count; i++)
        {
            object? featObj = null;
            try
            {
                featObj = model.FeatureByPositionReverse(i);
                if (featObj is null || featObj is DBNull)
                {
                    break;
                }

                dynamic feat = featObj;
                string name;
                string typeName;
                try
                {
                    name = (string)feat.Name;
                }
                catch
                {
                    name = $"#{i}";
                }

                try
                {
                    typeName = (string)feat.GetTypeName2();
                }
                catch
                {
                    try
                    {
                        typeName = (string)feat.GetTypeName();
                    }
                    catch
                    {
                        typeName = "Unknown";
                    }
                }

                list.Add(new FeatureInfo
                {
                    Index = i,
                    Name = name,
                    TypeName = typeName,
                });
            }
            catch
            {
                break;
            }
            finally
            {
                if (featObj is not null && Marshal.IsComObject(featObj))
                {
                    try { Marshal.ReleaseComObject(featObj); } catch { /* ignore */ }
                }
            }
        }

        return list;
    }

    public static object? FindByTypeAndAlias(dynamic model, string typeName, params string[] aliases)
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
                    return model.FeatureByPositionReverse(info.Index);
                }
            }
        }

        return null;
    }

    public static object? FindByName(dynamic model, string name)
    {
        foreach (var info in Read(model))
        {
            if (string.Equals(info.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return model.FeatureByPositionReverse(info.Index);
            }
        }

        return null;
    }
}
