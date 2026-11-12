/**
 * Live Sepolia check of private payments (Kohaku Tornado Cash) in a real browser, against the
 * production build (strict CSP, Kohaku's module worker served from /kohaku/).
 *
 *   LIVE_TESTNET=1 pnpm test:e2e tests/e2e/shielded.spec.ts
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const LIVE = process.env.LIVE_TESTNET === "1";
const PW = "correct horse battery staple";

async function newUser(browser: Browser): Promise<{ page: Page; requests: string[] }> {
  const ctx = await browser.newContext();
  const requests: string[] = [];
  ctx.on("request", (r) => requests.push(r.url()));
  ctx.on("requestfailed", (r) => console.error(`[request failed] ${r.url().slice(0, 140)}: ${r.failure()?.errorText}`));
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[browser] ${m.text().slice(0, 300)}`);
  });
  await page.goto("/#/app");
  await page.getByLabel("Label (local only)").fill("Private");
  await page.getByLabel("Device password", { exact: true }).fill(PW);
  await page.getByLabel("Repeat password").fill(PW);
  await page.getByRole("button", { name: "Generate identity" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  return { page, requests };
}

async function setUpPrivatePayments(page: Page) {
  await page.getByRole("link", { name: "Private payments" }).first().click();
  await page.getByLabel("Device password").fill(PW);
  await page.getByRole("button", { name: "Create recovery phrase" }).click();
  await expect(page.locator("ol li")).toHaveCount(24);
  await page.getByRole("button", { name: "I have written it down" }).click();
}

async function waitForBalance(page: Page, timeout: number) {
  const shown = page.getByText(/^(0|\d+(\.\d+)?) ETH$/).first();
  const failure = page.getByRole("alert");
  await expect(shown.or(failure)).toBeVisible({ timeout });
  if (await failure.isVisible()) throw new Error(`private payments failed: ${await failure.textContent()}`);
  return shown.textContent();
}

test.describe("live Sepolia private payments", () => {
  test.skip(!LIVE, "set LIVE_TESTNET=1 (needs internet: Sepolia RPCs)");

  test("S-17 (browser) Kohaku's Tornado plugin syncs from the shipped snapshot under the production CSP", async ({ browser }) => {
    test.setTimeout(600_000);
    const { page, requests } = await newUser(browser);
    await setUpPrivatePayments(page);
    expect(await waitForBalance(page, 480_000)).toBe("0 ETH");
    await expect(page.getByText(/^\d+ s$/)).toBeVisible(); // "Last sync"
    expect(requests.some((u) => /\/kohaku\/state-manager\.worker\.js$/.test(u))).toBe(true);
    expect(requests.some((u) => /\/kohaku\/tornado-sepolia-state\.json$/.test(u))).toBe(true);
    // The phrase is never stored in the clear: the key-storage Observatory test still passes.
    await page.goto("/#/app/observatory");
    await page.getByRole("button", { name: "Run Local key storage" }).click();
    const row = page.locator("li", { hasText: "OBS-11" });
    await expect(row.locator("span", { hasText: /^(PASS|FAIL)$/ }).first()).toBeVisible({ timeout: 60_000 });
    expect((await row.locator("span", { hasText: /^(PASS|FAIL)$/ }).first().textContent())?.trim()).toBe("PASS");
  });

  test("S-17 (browser, anonymous) the pool sync also runs entirely through the Nox mixnet", async ({ browser }) => {
    test.setTimeout(900_000);
    const { page, requests } = await newUser(browser);
    await page.goto("/#/app/privacy");
    await page.getByRole("radio", { name: "Anonymous (Anon-RPC, experimental)" }).click();
    await expect(page.getByRole("radio", { name: "Anonymous (Anon-RPC, experimental)" })).toBeChecked();
    await setUpPrivatePayments(page);
    expect(await waitForBalance(page, 840_000)).toBe("0 ETH");
    expect(requests.filter((u) => u.includes("sepolia.gateway.tenderly.co")), "history RPC contacted directly").toEqual([]);
    expect(requests.filter((u) => u.includes("ethereum-sepolia-rpc.publicnode.com")), "read RPC contacted directly").toEqual([]);
  });
});
