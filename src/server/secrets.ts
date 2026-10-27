// Secret storage for connections. Secrets are encrypted (AES-256-GCM) in
// ~/.symbio/secrets.enc with a random master key kept in the OS credential
// store (Windows Credential Manager / macOS Keychain / Secret Service), so the
// file is useless without the user's OS login. One keyring entry, no size limits.
//
// Secret values never leave the Symbio server process: they are not returned
// by the API and never reach agents or models.

import { Entry } from "@napi-rs/keyring";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

// Overridable so tests never touch the real credential entry.
const SERVICE = process.env.SYMBIO_KEYRING_SERVICE ?? "symbio";
const MASTER_KEY_ACCOUNT = "vault-master-key";

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
    const entry = new Entry(SERVICE, MASTER_KEY_ACCOUNT);
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
    return Buffer.from(encoded, "base64");
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
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), enc]));
      await fs.rename(tmp, this.file);
    };
    this.writing = this.writing.catch(() => {}).then(write);
    return this.writing;
  }
}
