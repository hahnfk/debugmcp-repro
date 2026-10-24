using System;

namespace DebugMcpRepro;

internal sealed class AppendResult
{
    public AppendResult(bool isFailure, int value)
    {
        IsFailure = isFailure;
        Value = value;
    }

    public bool IsFailure { get; }

    public int Value { get; }

    // Deliberately just a synthetic value projection, not a production Result API.
    public AppendResult Map(Func<int, int> projection)
    {
        return new AppendResult(IsFailure, projection(Value));
    }
}
