import * as baseLogger from "firebase-functions/logger";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogContext {
  requestId: string;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return asyncLocalStorage.run({ requestId }, fn);
}

export function generateRequestId(): string {
  return randomUUID();
}

function createStructuredLog(level: string, args: any[]): any {
  const context = asyncLocalStorage.getStore();
  return {
    level,
    message: args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" "),
    ...context,
  };
}

export function info(...args: any[]) {
  const logObj = createStructuredLog("INFO", args);
  baseLogger.info(logObj);
}

export function warn(...args: any[]) {
  const logObj = createStructuredLog("WARN", args);
  baseLogger.warn(logObj);
}

export function error(...args: any[]) {
  const logObj = createStructuredLog("ERROR", args);
  baseLogger.error(logObj);
}
