using System;
using System.Threading.Tasks;

namespace DebugMcpRepro;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length > 1)
        {
            Console.WriteLine("INPUT result=invalid");
            return 2;
        }

        var scenario = args.Length == 0 ? "all" : args[0];
        switch (scenario)
        {
            case "sync":
                WriteResult("A", Scenarios.Synchronous());
                break;
            case "completed-await":
                WriteResult("B", await Scenarios.CompletedAwaitAsync());
                break;
            case "suspended-await":
                WriteResult("C", await Scenarios.SuspendedAwaitAsync());
                break;
            case "assigned-after-await":
                WriteResult("D", await Scenarios.AssignedAfterAwaitAsync(isFailure: true));
                break;
            case "assigned-after-await-success":
                WriteResult("D_FALSE", await Scenarios.AssignedAfterAwaitAsync(isFailure: false));
                break;
            case "projection":
                WriteResult("E", await Scenarios.ProjectionAsync());
                break;
            case "out-of-scope":
                WriteResult("F", Scenarios.OutOfScope());
                break;
            case "all":
                WriteResult("A", Scenarios.Synchronous());
                WriteResult("B", await Scenarios.CompletedAwaitAsync());
                WriteResult("C", await Scenarios.SuspendedAwaitAsync());
                WriteResult("D", await Scenarios.AssignedAfterAwaitAsync(isFailure: true));
                WriteResult("D_FALSE", await Scenarios.AssignedAfterAwaitAsync(isFailure: false));
                WriteResult("E", await Scenarios.ProjectionAsync());
                WriteResult("F", Scenarios.OutOfScope());
                break;
            default:
                Console.WriteLine("INPUT result=unknown-scenario");
                return 2;
        }

        return 0;
    }

    private static void WriteResult(string scenario, int result)
    {
        Console.WriteLine($"{scenario} result={result}");
    }
}
