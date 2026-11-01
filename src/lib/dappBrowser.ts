import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type DappPageRequest = {
  id: number;
  origin: string;
  method: string;
  params: string;
};

type DappBrowserApi = {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
  setVisible(options: { visible: boolean }): Promise<void>;
  respond(options: { id: number; ok: boolean; payload: string }): Promise<void>;
  emit(options: { event: string; payload: string }): Promise<void>;
  addListener(event: "request", handler: (event: DappPageRequest) => void): Promise<PluginListenerHandle>;
  addListener(event: "closed", handler: () => void): Promise<PluginListenerHandle>;
};

const plugin = registerPlugin<DappBrowserApi>("DappBrowser");

export function dappBrowserAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export async function openDappBrowser(url: string): Promise<void> {
  await plugin.open({ url });
}

export async function closeDappBrowser(): Promise<void> {
  try {
    await plugin.close();
  } catch {
    // The page is already gone.
  }
}

export async function setDappBrowserVisible(visible: boolean): Promise<void> {
  try {
    await plugin.setVisible({ visible });
  } catch {
    // The browser was closed while a prompt was open.
  }
}

export async function respondDapp(id: number, ok: boolean, payload: unknown): Promise<void> {
  await plugin.respond({ id, ok, payload: JSON.stringify(payload) });
}

export async function emitDapp(event: "accountsChanged" | "chainChanged", payload: unknown): Promise<void> {
  try {
    await plugin.emit({ event, payload: JSON.stringify(payload) });
  } catch {
    // The page navigated away.
  }
}

export async function listenDapp(
  onRequest: (event: DappPageRequest) => void,
  onClosed: () => void,
): Promise<() => void> {
  const request = await plugin.addListener("request", onRequest);
  const closed = await plugin.addListener("closed", onClosed);
  return () => {
    void request.remove();
    void closed.remove();
  };
}
