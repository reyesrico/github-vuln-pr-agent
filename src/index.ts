import { loadConfig } from "./config.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { logError, logInfo } from "./utils/logger.js";
import { buildConfigPreflight } from "./utils/configPreflight.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const preflight = buildConfigPreflight(config, process.env);

  logInfo("Startup configuration preflight", preflight);

  if (config.preflightOnly) {
    logInfo("Preflight-only mode enabled. Exiting before orchestration.");
    return;
  }

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
