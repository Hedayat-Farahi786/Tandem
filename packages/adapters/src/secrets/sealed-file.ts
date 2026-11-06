import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactor } from '@tandem/core';
import { KeychainSecrets, type SecretName, type SecretStore } from './keychain.js';

/**
 * Secrets on a computer without a system keychain (a Linux server, a container): kept in Tandem's
 * data folder, each sealed with AES-256-GCM under this computer's key (<home>/secret.key, the same
 * key the web app uses on one computer). Both files are readable by their owner only, and the
 * values never appear in plain text on disk or in logs.
 */
export class SealedFileSecrets implements SecretStore {
  private key: Buffer | undefined;
  constructor(private readonly home: string) {}

  private get file() {
    return join(this.home, 'secrets.sealed.json');
  }

  private secretKey(): Buffer {
    if (this.key) return this.key;
    const file = join(this.home, 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
      } catch {
        // made at the same moment by another process: read theirs
      }
    }
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is not a 32-byte key.`);
    this.key = key;
    return key;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>) {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async available(): Promise<{ ok: boolean; message: string }> {
    try {
      this.secretKey();
      return { ok: true, message: `No system keychain here, so secrets are sealed with this computer's key (${join(this.home, 'secret.key')}).` };
    } catch (err) {
      return { ok: false, message: `Secrets cannot be kept: ${String((err as Error).message ?? err)}` };
    }
  }

  async get(name: SecretName): Promise<string | undefined> {
    const sealed = this.read()[name];
    if (!sealed) return undefined;
    try {
      const [v, iv, tag, body] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !body) return undefined;
      const d = createDecipheriv('aes-256-gcm', this.secretKey(), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      const value = Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
      if (value) redactor.register(value);
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!value.trim()) throw new Error('The value is empty.');
    redactor.register(value);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    this.write({ ...this.read(), [name]: `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}` });
  }

  async delete(name: SecretName): Promise<void> {
    const all = this.read();
    if (!(name in all)) return;
    delete all[name];
    this.write(all);
  }
}

/** The system keychain when this computer has one; otherwise secrets sealed in Tandem's data folder. */
export async function localSecrets(home: string, keychain: SecretStore = new KeychainSecrets()): Promise<SecretStore> {
  return (await keychain.available()).ok ? keychain : new SealedFileSecrets(home);
}
