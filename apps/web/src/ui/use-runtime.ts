import { useSyncExternalStore } from "react";
import { runtime } from "../runtime/runtime.ts";

/** Re-renders whenever any part of the runtime changes; returns the runtime. */
export function useRuntime() {
  useSyncExternalStore(runtime.subscribe, runtime.getVersion);
  return runtime;
}
