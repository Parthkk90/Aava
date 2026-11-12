/**
 * Live Sepolia checks of RPC routing in a real browser, against the production build (strict CSP).
 * Opt-in: needs the internet (Sepolia RPCs, the Nox mixnet, a beacon light-client API).
 *
 *   LIVE_TESTNET=1 pnpm test:e2e tests/e2e/rpc-routing.spec.ts
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_TESTNET === "1";
const PW = "correct horse battery staple";
const SEPOLIA_READ_RPC = "ethereum-sepolia-rpc.publicnode.com"; // the default Sepolia RPC in packages/chain

async function newUser(browser: Browser): Promise<{ ctx: BrowserContext; page: Page; requests: string[] }> {
  const ctx = await browser.newContext();
  const requests: string[] = [];
  ctx.on("request", (r) => requests.push(r.url()));
  ctx.on("requestfailed", (r) => console.error(`[request failed] ${r.method()} ${r.url().slice(0, 160)}: ${r.failure()?.errorText}`));
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[browser] ${m.text()}`);
  });
  await page.goto("/#/app");
  await page.getByLabel("Label (local only)").fill("Routing");
  await page.getByLabel("Device password", { exact: true }).fill(PW);
  await page.getByLabel("Repeat password").fill(PW);
  await page.getByRole("button", { name: "Generate identity" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/#/app/wallet");
  await page.getByLabel("Selected chain").selectOption("11155111");
  return { ctx, page, requests };
}

/** Clicks "Connect now" and waits for the worker / light client badge to settle; fails with the shown error. */
async function connectAndWait(page: Page, timeout: number) {
  await page.getByRole("button", { name: "Connect now" }).click();
  const settled = page.getByText(/^(ready \(\d+ s boot\)|failed)$/);
  await expect(settled).toBeVisible({ timeout });
  const text = await settled.textContent();
  if (text === "failed") {
    const why = await page.locator("[class*='border-rose']").first().textContent();
    throw new Error(`boot failed: ${why}`);
  }
}

async function runDiagnostics(page: Page) {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/^RPC https:\/\/ethereum-sepolia-rpc\.publicnode\.com/)).toBeVisible({ timeout: 180_000 });
}

async function obs(page: Page, id: string, title: string) {
  await page.goto("/#/app/observatory");
  await page.getByRole("button", { name: `Run ${title}` }).click();
  const row = page.locator("li", { hasText: id });
  await expect(row.locator("span", { hasText: /^(PASS|FAIL|LIMITED|NOT TESTED)$/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: `Run ${title}` })).toBeEnabled({ timeout: 60_000 });
  return (await row.locator("span", { hasText: /^(PASS|FAIL|LIMITED|NOT TESTED)$/ }).first().textContent())?.trim();
}

test.describe("live Sepolia RPC routing", () => {
  test.skip(!LIVE, "set LIVE_TESTNET=1 (needs internet: Sepolia, Nox mixnet, beacon API)");

  test("P-09 (browser) anonymous mode reads Sepolia through the Nox mixnet and never contacts the RPC directly", async ({ browser }) => {
    test.setTimeout(600_000);
    const { page, requests } = await newUser(browser);
    await page.goto("/#/app/privacy");
    // The radio re-renders once the setting is saved (async), so click and then wait for it.
    await page.getByRole("radio", { name: "Anonymous (Anon-RPC, experimental)" }).click();
    await expect(page.getByRole("radio", { name: "Anonymous (Anon-RPC, experimental)" })).toBeChecked();
    await connectAndWait(page, 360_000);
    await runDiagnostics(page);
    await expect(page.getByText(/chain 11155111 in \d+ ms \(anon mode\)/)).toBeVisible();
    // The worker hash was pinned on first use and is shown to the user.
    await expect(page.getByText(/^0x[0-9a-f]{64}$/).first()).toBeVisible();

    expect(await obs(page, "OBS-15", "Anonymous RPC routing")).toBe("PASS");
    expect(await obs(page, "OBS-04", "Network endpoint inventory")).toBe("PASS");

    // Network evidence from the browser itself (all frames and workers of this context).
    expect(requests.filter((u) => u.includes(SEPOLIA_READ_RPC)), "direct requests to the anonymized RPC").toEqual([]);
    expect(requests.some((u) => /\/anon-rpc-iframe\.html$/.test(u))).toBe(true);
  });

  test("S-16 (browser) light-client mode syncs Helios under the production CSP and verifies reads", async ({ browser }) => {
    test.setTimeout(600_000);
    const { page, requests } = await newUser(browser);
    await page.goto("/#/app/privacy");
    // The radio re-renders once the setting is saved (async), so click and then wait for it.
    await page.getByRole("radio", { name: "Verified (Helios light client, experimental)" }).click();
    await expect(page.getByRole("radio", { name: "Verified (Helios light client, experimental)" })).toBeChecked();
    await connectAndWait(page, 480_000);
    await runDiagnostics(page);
    await expect(page.getByText(/chain 11155111 in \d+ ms \(light-client mode\)/)).toBeVisible();
    expect(await obs(page, "OBS-11", "Local key storage")).toBe("PASS");
    expect(requests.some((u) => u.includes("lodestar-sepolia.chainsafe.io"))).toBe(true);
    expect(requests.filter((u) => u.includes(SEPOLIA_READ_RPC)), "light-client mode must not read the untrusted RPC").toEqual([]);
  });
});
