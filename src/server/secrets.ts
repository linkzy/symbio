// Secret storage for connections. Secrets are encrypted (AES-256-GCM) in
// ~/.symbio/secrets.enc with a random master key kept in the OS credential
// store (Windows Credential Manager / macOS Keychain / Secret Service), so the
// file is useless without the user's OS login. One keyring entry, no size limits.
//
// Secret values never leave the Symbio server process: they are not returned
// by the API and never reach agents or models.

import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

// Overridable so tests never touch the real credential entry.
const SERVICE = process.env.SYMBIO_KEYRING_SERVICE ?? "symbio";
const MASTER_KEY_ACCOUNT = "vault-master-key";
/**
 * The credential store's binding, loaded when a secret is first needed rather than at startup: it's
 * a native module, and on a Windows without the Microsoft Visual C++ runtime it can't load at all
 * (seen on a clean Windows). Symbio must still start then; only stored secrets are unavailable.
 */
let keyring: { Entry: typeof KeyringEntry } | null = null;
function keyringEntry(service: string, account: string): KeyringEntry {
  if (!keyring) {
    try {
      keyring = createRequire(import.meta.url)("@napi-rs/keyring") as { Entry: typeof KeyringEntry };
    } catch (err) {
      throw new Error(keyringLoadError(err as Error));
    }
  }
  return new keyring.Entry(service, account);
}

/** Says why the credential store's module didn't load, and what to do about it. */
export function keyringLoadError(err: Error, platform: NodeJS.Platform = process.platform): string {
  // Windows says "The specified module could not be found" when a DLL the module needs is missing.
  const chain: string[] = [];
  for (let e: any = err; e && chain.length < 10; e = e.cause) chain.push(String(e.message ?? ""));
  if (platform === "win32" && chain.some((m) => /specified module could not be found/i.test(m))) {
    return (
      "Symbio can't reach Windows' Credential Manager, where it keeps the key to stored passwords and tokens: " +
      "Windows is missing the Microsoft Visual C++ Redistributable. Install it (https://aka.ms/vs/17/release/vc_redist.x64.exe, " +
      "or run Symbio's installer again), then restart Symbio."
    );
  }
  return `Symbio can't reach the OS credential store, where it keeps the key to stored passwords and tokens: ${chain[0] || err.message}`;
}

/** The vault key, once read or created (by service). */
const keys = new Map<string, Buffer>();

export class SecretVault {
  private cache: Record<string, string> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  static at(dir: string) {
    return new SecretVault(path.join(dir, "secrets.enc"));
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const all = await this.load();
    all[key] = value;
    await this.save(all);
  }

  /** Deletes every secret whose key starts with the prefix (e.g. all of one connection's). */
  async deletePrefix(prefix: string): Promise<void> {
    const all = await this.load();
    for (const k of Object.keys(all)) if (k.startsWith(prefix)) delete all[k];
    await this.save(all);
  }

  private masterKey(): Buffer {
    // Read once per process: on Windows, reading the credential again has come back empty while
    // other processes wrote and deleted theirs (seen in the tests), which looked like a lost key.
    const known = keys.get(SERVICE);
    if (known) return known;
    const entry = keyringEntry(SERVICE, MASTER_KEY_ACCOUNT);
    let encoded: string | null = null;
    try {
      encoded = entry.getPassword() ?? null;
    } catch (err) {
      // A locked or unavailable credential store must not be mistaken for "no key yet":
      // replacing the key would make the existing secrets unreadable for good.
      if (existsSync(this.file)) throw new Error(`Couldn't read the vault key from the OS credential store: ${(err as Error).message}`);
    }
    if (!encoded) {
      if (existsSync(this.file)) {
        throw new Error(
          "The vault key is missing from the OS credential store, so the stored connection secrets can't be read. " +
            `Delete ${this.file} and re-enter the credentials in Settings.`,
        );
      }
      encoded = randomBytes(32).toString("base64");
      entry.setPassword(encoded);
    }
    const key = Buffer.from(encoded, "base64");
    keys.set(SERVICE, key);
    return key;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.file);
    } catch (err: any) {
      if (err.code === "ENOENT") return (this.cache = {});
      throw err;
    }
    // Layout: 12-byte IV | 16-byte auth tag | ciphertext
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey(), blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    try {
      const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
      this.cache = JSON.parse(plain.toString("utf8"));
    } catch {
      throw new Error(
        "Could not decrypt the connection secrets (the master key in the OS credential store doesn't match). " +
          "Re-enter the credentials in Settings.",
      );
    }
    return this.cache!;
  }

  private save(all: Record<string, string>): Promise<void> {
    this.cache = all;
    const write = async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.masterKey(), iv);
      const enc = Buffer.concat([cipher.update(JSON.stringify(all), "utf8"), cipher.final()]);
      await writeFileAtomic(this.file, Buffer.concat([iv, cipher.getAuthTag(), enc]));
    };
    this.writing = this.writing.catch(() => {}).then(write);
    return this.writing;
  }
}
