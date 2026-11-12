// An FTP connection: added and tested in Settings, used by an agent to publish a folder, and a change approved from Needs you.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fakeFtp, type FakeFtp } from "../fake-ftp.js";
import { closeBrowser, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
let ftp: FakeFtp;
before(async () => {
  symbio = await startSymbio();
  ftp = await fakeFtp("site", "hosting-pass");
});
after(async () => {
  ftp?.close();
  await closeBrowser();
  await symbio?.stop();
});

test("add an FTP connection in Settings, test it, and publish a folder with remote_upload", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator("button", { hasText: "FTP" }).click();
  const field = (label: string) => page.locator("label.field").filter({ has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) }).locator("input");
  await field("Name").fill("Site hosting");
  await field("Host").fill("ftp://127.0.0.1/");
  await page.locator(".seg button", { hasText: "Plain FTP" }).click();
  await field("Port").fill(String(ftp.port));
  await field("User").fill("site");
  await field("Password").fill("hosting-pass");
  await page.locator("button", { hasText: "Save and test" }).click();
  await page.locator(".conn-test.ok", { hasText: "Connected (unencrypted)" }).waitFor();
  await page.locator(".list-sub", { hasText: "FTP · site@127.0.0.1" }).waitFor();

  // A project that may use it without asking; core publishes its build folder.
  const { project, core, directory } = await projectWithCore(symbio, "Site");
  const conn = (await symbio.call("GET", "/connections")).find((c: any) => c.name === "Site hosting");
  assert.ok(!JSON.stringify(conn).includes("hosting-pass"), "the browser never gets the password");
  await symbio.call("PATCH", `/projects/${project.id}`, { connections: [{ id: conn.id, policy: "allow" }] });
  mkdirSync(path.join(directory, "dist"), { recursive: true });
  writeFileSync(path.join(directory, "dist", "index.html"), "<h1>Live</h1>");
  const upload = { connection: "Site hosting", local_path: "dist", remote_path: "public_html", reason: "Publish the site" };
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: `@core tool remote_upload ${JSON.stringify(upload)}` });
  await idle(symbio, project.id);
  await until("the file to arrive on the FTP server", () => {
    try {
      return readFileSync(path.join(ftp.root, "public_html", "index.html"), "utf8") === "<h1>Live</h1>";
    } catch {
      return false;
    }
  });

  // With "Ask me", a change on the FTP account (a rename) waits in Needs you until approved.
  await symbio.call("PATCH", `/projects/${project.id}`, { connections: [{ id: conn.id, policy: "ask" }] });
  const rename = { connection: "Site hosting", command: "mv public_html/index.html public_html/old.html", reason: "Keep the old page" };
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: `@core tool remote_exec ${JSON.stringify(rename)}` });
  await idle(symbio, project.id);
  assert.ok(existsSync(path.join(ftp.root, "public_html", "index.html")), "nothing changes before the approval");
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const item = page.locator(".inbox-item", { hasText: "Use Site hosting" });
  await item.locator("pre.command", { hasText: "mv public_html/index.html public_html/old.html" }).waitFor();
  await item.locator("button", { hasText: "Approve" }).click();
  await until("the file to be renamed", () => existsSync(path.join(ftp.root, "public_html", "old.html")));
});
