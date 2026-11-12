import { spawn, execSync } from "node:child_process";

/** Starts scripts/e2e-infra.ts and waits for READY; returns a teardown that kills the whole tree. */
export default async function globalSetup() {
  const child = spawn("pnpm exec tsx scripts/e2e-infra.ts", { stdio: ["pipe", "pipe", "inherit"], shell: true });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("e2e infrastructure did not start within 180s")), 180_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`e2e infrastructure exited early (${code})`)));
  });
  return async () => {
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    } else {
      child.stdin!.end();
      child.kill("SIGTERM");
    }
  };
}
