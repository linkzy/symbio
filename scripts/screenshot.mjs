// Takes screenshots of the running UI with the locally installed Edge/Chrome.
// Usage: node scripts/screenshot.mjs <baseUrl> <outDir> [hashRoute ...]
import { chromium } from "playwright-core";
import path from "node:path";

const [baseUrl = "http://127.0.0.1:4310", outDir = ".", ...routes] = process.argv.slice(2);
const channel = process.env.BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome");

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: "dark" });
  for (const route of routes.length ? routes : [""]) {
    await page.goto(`${baseUrl}/${route}`);
    await page.waitForTimeout(2500);
    const name = (route.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "home") + ".png";
    await page.screenshot({ path: path.join(outDir, name) });
    console.log("saved", name);
  }
} finally {
  await browser.close();
}
