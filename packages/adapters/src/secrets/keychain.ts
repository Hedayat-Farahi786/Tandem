import { redactor } from '@tandem/core';

export type SecretName = 'jira-token' | 'github-token' | 'aws-connection' | 'runner-key';

export interface SecretStore {
  /** Whether an OS keychain is usable on this machine. */
  available(): Promise<{ ok: boolean; message: string }>;
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

const SERVICE = 'tandem';

/**
 * Secrets live only in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
 * Service). There is no file fallback: if no keychain exists, saving a secret fails with a fix.
 * Every value read is registered with the redactor so it can never be logged.
 */
export class KeychainSecrets implements SecretStore {
  private entryCtor: EntryCtor | undefined;

  constructor(private readonly load: () => Promise<EntryCtor> = async () => (await import('@napi-rs/keyring')).Entry as unknown as EntryCtor) {}

  private async entry(name: SecretName): Promise<KeyringEntry> {
    this.entryCtor ??= await this.load();
    return new this.entryCtor(SERVICE, name);
  }

  async available(): Promise<{ ok: boolean; message: string }> {
    try {
      const e = await this.entry('jira-token');
      e.getPassword();
      return { ok: true, message: 'OS keychain is available.' };
    } catch (err) {
      return {
        ok: false,
        message: `No usable OS keychain (${String((err as Error).message ?? err).split('\n')[0]}). ${process.platform === 'linux' ? 'Install and unlock a Secret Service, for example gnome-keyring (sudo apt install gnome-keyring) and run Tandem from a desktop session.' : 'Unlock your keychain and try again.'}`,
      };
    }
  }

  async get(name: SecretName): Promise<string | undefined> {
    try {
      const v = (await this.entry(name)).getPassword() ?? undefined;
      if (v) redactor.register(v);
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!value.trim()) throw new Error('The value is empty.');
    redactor.register(value);
    try {
      (await this.entry(name)).setPassword(value);
    } catch (err) {
      throw new Error(`Could not save ${name} to the OS keychain: ${String((err as Error).message ?? err)}. Tandem never stores secrets in files.`, { cause: err });
    }
  }

  async delete(name: SecretName): Promise<void> {
    try {
      (await this.entry(name)).deletePassword();
    } catch {
      // nothing stored
    }
  }
}

/** For tests and environments where secrets come from elsewhere. Never persisted. */
export class MemorySecrets implements SecretStore {
  private readonly values = new Map<SecretName, string>();
  async available() {
    return { ok: true, message: 'in-memory' };
  }
  async get(name: SecretName) {
    return this.values.get(name);
  }
  async set(name: SecretName, value: string) {
    redactor.register(value);
    this.values.set(name, value);
  }
  async delete(name: SecretName) {
    this.values.delete(name);
  }
}
