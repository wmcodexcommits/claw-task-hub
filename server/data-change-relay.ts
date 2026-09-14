// Relays Postgres change notifications to this process's open UIs.
//
// The triggers in server/db-schema-postgres.ts announce every committed write on
// one channel. This listens on that channel and calls onChange, which the API
// server turns into the same `data-refresh` event its own writes already send.
// The result is that a UI refreshes when ANY hub sharing the database writes,
// whether it is on this machine or another one.
//
// Why a health check
// ------------------
// postgres.js re-issues LISTEN after its dedicated connection drops, but it
// makes a single attempt and swallows the failure. A reconnect that happens
// while the server is still unreachable (a restart, a network blip, a laptop
// waking up) leaves the process listening to nothing, with no error anywhere,
// and the UI goes back to needing a manual refresh. So the relay checks itself
// end to end: on an interval it sends a ping on the channel and expects to hear
// it back. A ping that does not come back replaces the whole client.
//
// Every successful LISTEN, including the first one and each reconnect, also
// calls onChange. Writes made while nobody was listening are never delivered
// later, so the only way to catch up on them is to refresh.
//
// The module takes its client from `connect` and imports nothing from the data
// layer, so tests can drive it with a stand-in.

import { dataChangeChannel } from "./db-schema-postgres.js";

export type ListenerClient = {
  listen: (
    channel: string,
    onnotify: (payload: string) => void,
    onlisten?: () => void,
  ) => Promise<{ unlisten: () => Promise<void> }>;
  notify: (channel: string, payload: string) => Promise<unknown>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

export type DataChangeRelayOptions = {
  connect: () => ListenerClient | Promise<ListenerClient>;
  /** Called with a short reason: the changed table's name, or "listening". */
  onChange: (reason: string) => void;
  channel?: string;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  retryDelayMs?: number;
  log?: (message: string) => void;
};

export type DataChangeRelay = {
  stop: () => Promise<void>;
};

// Every relay on the channel hears every ping, so pings are recognized by this
// prefix and never treated as a data change. Only the sender's token matters to
// its own health check.
const pingPrefix = "ping:";

export function createDataChangeRelay(options: DataChangeRelayOptions): DataChangeRelay {
  const channel = options.channel ?? dataChangeChannel;
  const healthIntervalMs = options.healthIntervalMs ?? 30_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const log = options.log ?? ((message: string) => process.stderr.write(`claw-task-hub: ${message}\n`));

  let stopped = false;
  let client: ListenerClient | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPing: { token: string; received: () => void } | null = null;
  // Log transitions rather than every attempt, so an unreachable server does not
  // print a line every few seconds.
  let healthy: boolean | null = null;
  let pingCounter = 0;

  function handleNotification(payload: string) {
    if (payload.startsWith(pingPrefix)) {
      if (pendingPing && payload === pendingPing.token) pendingPing.received();
      return;
    }
    options.onChange(payload || "change");
  }

  function markHealthy() {
    if (healthy !== true) log(`live refresh listening on Postgres channel ${channel}`);
    healthy = true;
  }

  function markUnhealthy(reason: string) {
    if (healthy !== false) log(`live refresh unavailable (${reason}); retrying every ${Math.round(retryDelayMs / 1000)}s`);
    healthy = false;
  }

  async function discardClient() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    pendingPing = null;
    const previous = client;
    client = null;
    await previous?.end({ timeout: 1 }).catch(() => undefined);
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMs);
    retryTimer.unref?.();
  }

  async function connect() {
    if (stopped) return;
    let next: ListenerClient | null = null;
    try {
      next = await options.connect();
      if (stopped) {
        await next.end({ timeout: 1 }).catch(() => undefined);
        return;
      }
      client = next;
      await next.listen(channel, handleNotification, () => {
        if (stopped || client !== next) return;
        markHealthy();
        options.onChange("listening");
      });
    } catch (error) {
      if (client === next) await discardClient();
      else await next?.end({ timeout: 1 }).catch(() => undefined);
      markUnhealthy(error instanceof Error ? error.message : String(error));
      scheduleReconnect();
      return;
    }
    healthTimer = setInterval(() => void checkHealth(), healthIntervalMs);
    healthTimer.unref?.();
  }

  async function checkHealth() {
    const current = client;
    if (stopped || !current || pendingPing) return;
    pingCounter += 1;
    const token = `${pingPrefix}${process.pid}:${Date.now()}:${pingCounter}`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const echoed = await new Promise<boolean>((resolve) => {
      pendingPing = { token, received: () => resolve(true) };
      timeout = setTimeout(() => resolve(false), healthTimeoutMs);
      current.notify(channel, token).catch(() => resolve(false));
    });
    clearTimeout(timeout);
    pendingPing = null;
    if (stopped || client !== current) return;
    if (echoed) {
      markHealthy();
      return;
    }
    markUnhealthy("the listener stopped receiving notifications");
    await discardClient();
    scheduleReconnect();
  }

  void connect();

  return {
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      await discardClient();
    },
  };
}
