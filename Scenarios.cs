using System;
using System.Threading.Tasks;

namespace DebugMcpRepro;

internal static class Scenarios
{
    public static int Synchronous()
    {
        var localNumber = 41;
        var appendResult = new AppendResult(isFailure: true, value: 7);
        var result = localNumber + appendResult.Value; // BREAK A
        return result;
    }

    public static async Task<int> CompletedAwaitAsync()
    {
        var localNumber = 42;
        var completedTask = Task.FromResult(new AppendResult(isFailure: true, value: 7));
        var completedBeforeAwait = completedTask.IsCompletedSuccessfully;
        var appendResult = await completedTask;
        var result = localNumber + appendResult.Value; // BREAK B
        if (!completedBeforeAwait)
        {
            throw new InvalidOperationException("B requires an already completed task.");
        }

        return result;
    }

    public static async Task<int> SuspendedAwaitAsync()
    {
        var localNumber = 43;
        var appendResult = new AppendResult(isFailure: true, value: 7);
        var suspension = Task.Yield();
        var completedBeforeAwait = suspension.GetAwaiter().IsCompleted;
        GC.KeepAlive(appendResult); // BREAK C_BEFORE_AWAIT
        await suspension;
        var result = localNumber + appendResult.Value; // BREAK C_AFTER_AWAIT
        if (completedBeforeAwait)
        {
            throw new InvalidOperationException("C requires a noncompleted awaiter.");
        }

        return result;
    }

    public static async Task<int> AssignedAfterAwaitAsync(bool isFailure)
    {
        var localNumber = 44;
        var appendResult = await CreateResultAsync(isFailure);
        var result = localNumber + (appendResult.IsFailure ? -appendResult.Value : appendResult.Value); // BREAK D
        return result;
    }

    public static async Task<int> ProjectionAsync()
    {
        var localNumber = 45;
        var appendResult = await CreateResultAsync(isFailure: true);
        GC.KeepAlive(appendResult); // BREAK E_BEFORE_RETURN
        return appendResult.Map(value => value + localNumber).Value; // BREAK E_RETURN
    }

    public static int OutOfScope()
    {
        var localNumber = 46;
        {
            var outOfScope = new AppendResult(isFailure: false, value: 7);
            localNumber += outOfScope.Value;
        }

        var result = localNumber; // BREAK F_NEGATIVE_CONTROL
        return result;
    }

    private static async Task<AppendResult> CreateResultAsync(bool isFailure)
    {
        await Task.Yield();
        return new AppendResult(isFailure, value: 7);
    }
}
