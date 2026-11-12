import { expect, test, type Browser, type Page } from "@playwright/test";
import * as nip19 from "nostr-tools/nip19";

const ALICE_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const BOB_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PW = "correct horse battery staple";

async function newUser(browser: Browser, label: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${label}] page error: ${e.stack ?? e.message}`));
  await page.goto("/#/app");
  await page.getByLabel("Label (local only)").fill(label);
  await page.getByLabel("Device password", { exact: true }).fill(PW);
  await page.getByLabel("Repeat password").fill(PW);
  await page.getByRole("button", { name: "Generate identity" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  return page;
}

async function npubOf(page: Page): Promise<string> {
  await page.goto("/#/app/identity");
  return (await page.locator('span[title^="npub1"]').first().getAttribute("title"))!;
}

async function connectDevWallet(page: Page, address: string) {
  await page.goto("/#/app/wallet");
  await page.getByRole("button", { name: "Find devnet accounts" }).click();
  await page.locator("#dev-acct").selectOption(address);
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByText("Local test wallet (anvil)")).toBeVisible();
}

async function confirmWallet(page: Page) {
  const dialog = page.getByRole("dialog", { name: /local test wallet/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
}

async function obsStatus(page: Page, id: string) {
  return (await page.locator("li", { hasText: id }).locator("span", { hasText: /^(PASS|FAIL|LIMITED|NOT TESTED)$/ }).first().textContent())?.trim();
}

test("two users: encrypted chat, signed payment request, wallet approval, on-chain verification", async ({ browser }) => {
  const alice = await newUser(browser, "Alice");
  const bob = await newUser(browser, "Bob");
  const aliceNpub = await npubOf(alice);
  const bobNpub = await npubOf(bob);
  const aliceHex = nip19.decode(aliceNpub).data as string;

  // Alice adds Bob and sends an encrypted message.
  await alice.goto("/#/app/messages");
  await alice.getByRole("button", { name: "Add contact" }).first().click();
  await alice.getByLabel("Public key").fill(bobNpub);
  await alice.getByLabel("Name (stored encrypted on this device)").fill("Bob");
  await alice.getByRole("dialog").getByRole("button", { name: "Add contact" }).click();
  await alice.getByLabel("Message").fill("Hello Bob, this is end-to-end encrypted.");
  await alice.getByLabel("Message").press("Enter");
  await expect(alice.getByText("2 relays").first()).toBeVisible();

  // Bob receives it.
  await bob.goto(`/#/app/messages/${aliceHex}`);
  await expect(bob.locator("section").getByText("Hello Bob, this is end-to-end encrypted.")).toBeVisible();

  // Both connect local test wallets (devnet unlocked accounts; Aava never sees keys).
  await connectDevWallet(alice, ALICE_WALLET);
  await connectDevWallet(bob, BOB_WALLET);

  // Alice requests 12.5 rmUSD; her wallet signs the EIP-712 request.
  await alice.goto(`/#/app/messages/${nip19.decode(bobNpub).data as string}`);
  await alice.getByRole("button", { name: "Request payment" }).click();
  await alice.getByLabel("Amount").fill("12.5");
  await alice.getByLabel("Description (visible to the payer)").fill("Design work");
  await alice.getByRole("button", { name: "Sign & send request" }).click();
  await confirmWallet(alice);
  await expect(alice.getByText("Awaiting payment")).toBeVisible();

  // Bob: unknown wallet is not trusted silently; he confirms it, then approves and pays.
  await bob.goto(`/#/app/messages/${aliceHex}`);
  await expect(bob.getByText("Rejected · unknown-wallet")).toBeVisible();
  await bob.getByRole("button", { name: /I confirmed this wallet/ }).click();
  await expect(bob.getByText("Verified · awaiting your approval")).toBeVisible();
  await bob.getByRole("button", { name: "Approve & pay" }).click();
  await confirmWallet(bob);
  await expect(bob.getByText("Paid · receipt verified on-chain")).toBeVisible({ timeout: 60_000 });
  await expect(bob.getByText("Exact matching transfer")).toBeVisible();

  // Alice independently verifies the receipt Bob sent (arrives live over NIP-17).
  await expect(alice.getByText("Paid · receipt verified on-chain")).toBeVisible({ timeout: 60_000 });
  await expect(alice.getByText(/Independent check of the payer's receipt/)).toBeVisible();

  // Reloading locks the vault: the key only ever lives in memory.
  await alice.reload();
  await expect(alice.getByRole("button", { name: "Unlock" })).toBeVisible();
});

test("Privacy Observatory runs real tests with evidence (incl. S-02 storage, OBS-12 failover)", async ({ browser }) => {
  const page = await newUser(browser, "Observer");
  await page.goto("/#/app/observatory");
  await page.getByRole("button", { name: "Run all tests" }).click();
  await expect(page.getByRole("button", { name: "Run all tests" })).toBeEnabled({ timeout: 90_000 });
  const expected: Record<string, string> = {
    "OBS-01": "PASS", // message encryption
    "OBS-02": "PASS", // relay plaintext exposure
    "OBS-03": "PASS", // trackers
    "OBS-04": "PASS", // endpoint inventory
    "OBS-05": "LIMITED", // relay-only, no TURN configured: no candidates, no leak
    "OBS-06": "NOT TESTED", // no wallet connected
    "OBS-07": "PASS",
    "OBS-08": "PASS",
    "OBS-09": "PASS",
    "OBS-10": "PASS",
    "OBS-11": "PASS", // S-02 in a real browser
    "OBS-12": "PASS", // failover between the two relays
    "OBS-13": "PASS",
    "OBS-14": "LIMITED", // same-origin manifest
    "OBS-15": "LIMITED", // direct RPC mode (the default): provider sees the IP
  };
  for (const [id, status] of Object.entries(expected)) expect(await obsStatus(page, id), id).toBe(status);
});

test("P-07 WebRTC relay-only mode exposes no host or reflexive candidates", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  const gather = (policy: RTCIceTransportPolicy) =>
    page.evaluate(async (p) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3478" }], iceTransportPolicy: p });
      const out: string[] = [];
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        pc.onicecandidate = (e) => (e.candidate ? out.push(e.candidate.candidate) : (clearTimeout(t), resolve()));
      });
      pc.close();
      return out.map((c) => / typ ([a-z]+)/.exec(c)?.[1] ?? "?");
    }, policy);
  const relayOnly = await gather("relay");
  expect(relayOnly.filter((t) => t !== "relay")).toEqual([]);
  // Sensitivity check: the default policy does produce host candidates in this environment.
  const all = await gather("all");
  expect(all).toContain("host");
});

test("identity backup, local wipe, and restore on a fresh install", async ({ browser }) => {
  const page = await newUser(browser, "Carol");
  const npub = await npubOf(page);
  await page.getByLabel("Backup password", { exact: true }).fill("carol backup passphrase");
  await page.getByLabel("Repeat backup password").fill("carol backup passphrase");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Create & verify backup" }).click()]);
  await expect(page.getByText("Backup created and verified")).toBeVisible();
  const file = await download.path();

  await page.getByLabel('Type "erase" to confirm').fill("erase");
  await page.getByRole("button", { name: "Erase all local data" }).click();
  await expect(page.getByRole("heading", { name: "Set up your identity" })).toBeVisible();
  const stored = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return { local: localStorage.length, dbs: dbs.map((d) => d.name) };
  });
  expect(stored.local).toBe(0);

  await page.getByRole("button", { name: "Restore backup" }).click();
  await page.locator('input[type="file"]').setInputFiles(file!);
  await page.getByLabel("Backup password").fill("carol backup passphrase");
  await page.getByLabel("New device password").fill("a brand new device pw");
  await page.getByLabel("Repeat password").fill("a brand new device pw");
  await page.getByRole("button", { name: "Restore identity" }).click();
  // The app returns to the route the user was on (Identity Vault).
  await expect(page.getByRole("button", { name: "Lock vault" })).toBeVisible();
  expect(await npubOf(page)).toBe(npub);
});

test("private-payments recovery phrase survives backup, wipe and restore (and a new device password)", async ({ browser }) => {
  const page = await newUser(browser, "Dave");
  await page.goto("/#/app/private");
  await page.getByLabel("Device password").fill(PW);
  await page.getByRole("button", { name: "Create recovery phrase" }).click();
  await expect(page.locator("ol li")).toHaveCount(24);
  const words = (await page.locator("ol li").allTextContents()).map((t) => t.replace(/^\d+\.\s*/, "").trim());
  await page.getByRole("button", { name: "I have written it down" }).click();

  // The phrase is never stored in plaintext.
  const dump = await page.evaluate(async () => {
    const out: string[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name || name === "relaymesh-cache") continue;
      const db = await new Promise<IDBDatabase>((res, rej) => Object.assign(indexedDB.open(name), { onsuccess: (e: Event) => res((e.target as IDBOpenDBRequest).result), onerror: rej }));
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((res) => Object.assign(db.transaction(store).objectStore(store).getAll(), { onsuccess: (e: Event) => res((e.target as IDBRequest).result as unknown[]) }));
        out.push(JSON.stringify(all));
      }
    }
    return out.join("\n");
  });
  expect(dump).not.toContain(words.slice(0, 6).join(" "));

  await npubOf(page); // Identity Vault page
  await page.getByLabel("Backup password", { exact: true }).fill("dave backup passphrase");
  await page.getByLabel("Repeat backup password").fill("dave backup passphrase");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Create & verify backup" }).click()]);
  await expect(page.getByText("Backup created and verified")).toBeVisible();
  const file = await download.path();
  await page.getByLabel('Type "erase" to confirm').fill("erase");
  await page.getByRole("button", { name: "Erase all local data" }).click();
  await expect(page.getByRole("heading", { name: "Set up your identity" })).toBeVisible();

  await page.getByRole("button", { name: "Restore backup" }).click();
  await page.locator('input[type="file"]').setInputFiles(file!);
  await page.getByLabel("Backup password").fill("dave backup passphrase");
  await page.getByLabel("New device password").fill("a brand new device pw");
  await page.getByLabel("Repeat password").fill("a brand new device pw");
  await page.getByRole("button", { name: "Restore identity" }).click();
  await expect(page.getByRole("button", { name: "Lock vault" })).toBeVisible();

  // Lock and unlock with the new password: private payments unlock with it too.
  await page.getByRole("button", { name: "Lock vault" }).click();
  await page.getByLabel("Device password").fill("a brand new device pw");
  await page.getByRole("button", { name: /^Unlock/ }).click();
  await expect(page.getByRole("button", { name: "Lock vault" })).toBeVisible();
  await page.goto("/#/app/private");
  await page.getByLabel("Device password to show the phrase").fill("a brand new device pw");
  await page.getByRole("button", { name: "Show recovery phrase" }).click();
  await expect(page.locator("ol li")).toHaveCount(24);
  const restored = (await page.locator("ol li").allTextContents()).map((t) => t.replace(/^\d+\.\s*/, "").trim());
  expect(restored).toEqual(words);
});
