export function logInfo(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.log(`[INFO] ${message}`, context);
    return;
  }
  console.log(`[INFO] ${message}`);
}

export function logWarn(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.warn(`[WARN] ${message}`, context);
    return;
  }
  console.warn(`[WARN] ${message}`);
}

export function logError(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.error(`[ERROR] ${message}`, context);
    return;
  }
  console.error(`[ERROR] ${message}`);
}
