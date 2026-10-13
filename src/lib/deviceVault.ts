import { registerPlugin } from "@capacitor/core";

export type VaultEntry = { key: string; value: string };

type DeviceVaultApi = {
  list(): Promise<{ entries?: VaultEntry[] }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

const plugin = registerPlugin<DeviceVaultApi>("DeviceVault");

export async function vaultList(): Promise<VaultEntry[]> {
  const result = await plugin.list();
  const entries = result?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((row) => row && typeof row.key === "string" && typeof row.value === "string");
}

export async function vaultSet(key: string, value: string): Promise<void> {
  await plugin.set({ key, value });
}

export async function vaultDelete(key: string): Promise<void> {
  await plugin.remove({ key });
}
