import { loadConfig } from "./config.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { logError, logInfo } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const orchestrator = new Orchestrator();
  const results = await orchestrator.run(config);

  const created = results.filter((item) => item.status === "created").length;
  const failed = results.filter((item) => item.status === "failed").length;
  const skipped = results.filter((item) => item.status === "skipped").length;

  logInfo("Run complete", {
    repositories: config.repositories.length,
    alertsProcessed: results.length,
    created,
    failed,
    skipped,
    dryRun: config.dryRun
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logError("Execution failed", { message });
  process.exitCode = 1;
});
