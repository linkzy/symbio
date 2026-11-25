// Approving connection requests from Needs you without being there for each one: approve and always
// allow plain commands like it, approve and allow the agent for a while (Stop ends it), and Approve all.
// Against a tiny SSH server that answers every command.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import ssh2 from "ssh2";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio, openProjectSettings } from "./harness.js";

let symbio: Symbio;
// ssh2 sometimes generates an ed25519 key it can't parse back (about 1 in 200): try again.
function hostKey(): string {
  for (;;) {
    const key = ssh2.utils.generateKeyPairSync("ed25519").private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
}
let sshd: InstanceType<typeof ssh2.Server>;
let port = 0;
const ran: string[] = [];
before(async () => {
  symbio = await startSymbio();
  sshd = new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "vps-pass" ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () =>
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec, _reject, info) => {
          ran.push(info.command);
          const stream = acceptExec();
          stream.write(`ran: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      }),
    );
  });
  await new Promise<void>((ok) => sshd.listen(0, "127.0.0.1", ok));
  port = (sshd.address() as AddressInfo).port;
});
after(async () => {
  sshd?.close();
  await closeBrowser();
  await symbio?.stop();
});

test("approve once, always for commands like it, for a while, or all at once", async () => {
  const conn = await symbio.call("POST", "/connections", { type: "server", name: "VPS", host: "127.0.0.1", port, username: "ops", auth: "password", password: "vps-pass" });
  const { project, core } = await projectWithCore(symbio, "Inspect");
  await symbio.call("PATCH", `/projects/${project.id}`, { connections: [{ id: conn.id, policy: "ask" }] });
  const exec = async (command: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, {
      text: `@core tool remote_exec ${JSON.stringify({ connection: "VPS", command, reason: "Inspect the server" })}`,
    });
    await idle(symbio, project.id);
  };
  const pending = async () => (await symbio.call("GET", `/projects/${project.id}/approvals`)).filter((a: any) => a.status === "pending");

  // "Approve, and always allow" with the suggested pattern: later commands like it run at once.
  await exec("systemctl status nginx");
  const { page } = await openPage(symbio);
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const item = page.locator(".inbox-item", { hasText: "Use VPS" });
  assert.equal(await item.getByLabel("Commands to always allow").inputValue(), "systemctl status *");
  await item.getByRole("button", { name: "Approve, and always allow" }).click();
  await until("it to run", () => ran.includes("systemctl status nginx"));
  await until("core to get the result", async () => /ran: systemctl status nginx/.test(await history(symbio, project.id, core.id)));
  await exec("systemctl status ssh");
  await until("a command like it to run without asking", () => ran.includes("systemctl status ssh"));
  assert.equal((await pending()).length, 0);
  // Chained onto an allowed command, it still asks.
  await exec("systemctl status ssh; rm -rf /tmp/x");
  assert.equal((await pending()).length, 1);
  assert.ok(!ran.some((c) => c.includes("rm -rf")));

  // "Approve, and allow for 1 hour": everything core does on the VPS runs until Stop.
  await page.locator(".inbox-item", { hasText: "rm -rf" }).getByRole("button", { name: /^Approve, and allow core on VPS for/ }).click();
  await until("the approved one to run", () => ran.some((c) => c.includes("rm -rf")));
  await exec("uptime");
  await until("uptime to run without asking", () => ran.includes("uptime"));
  await page.keyboard.press("Escape");
  await openProjectSettings(page, "connections");
  const grant = page.locator(".pick-grant", { hasText: "core acts without asking until" });
  await grant.waitFor();
  assert.ok(await page.locator(".pick-command code", { hasText: "systemctl status *" }).isVisible(), "the always-allowed command is listed");
  await grant.getByRole("button", { name: "Stop" }).click();
  await grant.waitFor({ state: "detached" });

  // Asks again; two requests waiting: Approve all.
  await exec("df -h");
  await exec("free -m");
  assert.equal((await pending()).length, 2);
  await page.locator(".needs-you").click();
  await page.getByRole("button", { name: "Approve all" }).click();
  await until("both to run", () => ran.includes("df -h") && ran.includes("free -m"));
  await until("nothing left waiting", async () => (await pending()).length === 0);
  assert.deepEqual((page as any).errors, []);
});
