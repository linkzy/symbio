// An FTP connection: added and tested in Settings, then used by an agent to publish a folder.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const field = (label: string) => page.locator("label.field", { hasText: label }).locator("input");
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
});
