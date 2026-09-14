// Data change relay regression.
//
// Runs against a stand-in for postgres.js so the failure modes can be staged
// precisely: a listener that goes deaf without an error, a server that refuses
// connections for a while, and a relay stopped mid-retry. The live half -- that
// the triggers really announce commits and a real API server really relays them
// -- is covered by tests/store-postgres.mjs against a real server.

import { createDataChangeRelay } from "../server/data-change-relay.ts";
import { dataChangeChannel } from "../server/db-schema-postgres.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fastTimings = { healthIntervalMs: 20, healthTimeoutMs: 30, retryDelayMs: 10 };

/**
 * A stand-in for one postgres.js client. `deliver` simulates another hub's
 * committed write; `deaf` simulates the silent failure the health check exists
 * for: the listening connection is gone, but nothing reports an error.
 */
function createStandInServer() {
  const server = { clients: [], refuseConnections: 0, deaf: false, connectCount: 0 };

  server.connect = async () => {
    server.connectCount += 1;
    if (server.refuseConnections > 0) {
      server.refuseConnections -= 1;
      throw new Error("connection refused");
    }
    const client = { channel: null, onnotify: null, ended: false };
    client.listen = async (channel, onnotify, onlisten) => {
      client.channel = channel;
      client.onnotify = onnotify;
      onlisten?.();
      return { unlisten: async () => undefined };
    };
    // NOTIFY is delivered to every listener on the channel, including the sender.
    client.notify = async (channel, payload) => {
      queueMicrotask(() => server.deliver(payload, channel));
    };
    client.end = async () => {
      client.ended = true;
    };
    server.clients.push(client);
    return client;
  };

  server.deliver = (payload, channel = dataChangeChannel) => {
    if (server.deaf) return;
    for (const client of server.clients) {
      if (!client.ended && client.channel === channel) client.onnotify?.(payload);
    }
  };

  server.liveClients = () => server.clients.filter((client) => !client.ended);
  return server;
}

// --------------------------------------------------------------------------
// Changes are relayed; pings from any relay are not
// --------------------------------------------------------------------------

{
  const server = createStandInServer();
  const changes = [];
  const relay = createDataChangeRelay({ connect: server.connect, onChange: (reason) => changes.push(reason), log: () => undefined });

  await waitFor(() => changes.includes("listening"), "the first LISTEN did not trigger a catch-up refresh");
  assert(server.clients[0].channel === dataChangeChannel, `listened on the wrong channel: ${server.clients[0].channel}`);

  server.deliver("projects");
  server.deliver("ping:4242:1:1");
  server.deliver("issues");
  await waitFor(() => changes.includes("issues"), "a table notification was not relayed");
  assert(
    JSON.stringify(changes) === JSON.stringify(["listening", "projects", "issues"]),
    `another relay's health ping must not count as a change, saw ${JSON.stringify(changes)}`,
  );

  await relay.stop();
  assert(server.liveClients().length === 0, "stop() did not end the listener client");
}

// --------------------------------------------------------------------------
// A healthy listener is kept; a deaf one is replaced and catches up
// --------------------------------------------------------------------------

{
  const server = createStandInServer();
  const changes = [];
  const logs = [];
  const relay = createDataChangeRelay({
    connect: server.connect,
    onChange: (reason) => changes.push(reason),
    log: (message) => logs.push(message),
    ...fastTimings,
  });

  await waitFor(() => changes.includes("listening"), "the relay did not start listening");
  // Several health intervals pass with pings echoing back.
  await new Promise((resolve) => setTimeout(resolve, fastTimings.healthIntervalMs * 6));
  assert(server.connectCount === 1, `a healthy listener was replaced (${server.connectCount} connections)`);
  assert(!changes.some((reason) => reason.startsWith("ping:")), "the relay's own health ping was relayed as a change");

  // The connection goes silent without any error.
  server.deaf = true;
  await waitFor(() => server.clients[0].ended, "a listener that stopped receiving pings was not discarded");
  assert(logs.some((message) => message.includes("unavailable")), `the outage was not logged: ${JSON.stringify(logs)}`);
  server.deaf = false;

  const listensBefore = changes.filter((reason) => reason === "listening").length;
  await waitFor(() => server.liveClients().length === 1 && server.connectCount >= 2, "the relay did not reconnect");
  await waitFor(
    () => changes.filter((reason) => reason === "listening").length > listensBefore,
    "reconnecting did not trigger a catch-up refresh for writes missed while deaf",
  );

  server.deliver("comments");
  await waitFor(() => changes.includes("comments"), "the replacement listener did not relay changes");

  await relay.stop();
  assert(server.liveClients().length === 0, "stop() left a listener client open");
}

// --------------------------------------------------------------------------
// An unreachable server is retried, and the outage is logged once
// --------------------------------------------------------------------------

{
  const server = createStandInServer();
  server.refuseConnections = 3;
  const changes = [];
  const logs = [];
  const relay = createDataChangeRelay({
    connect: server.connect,
    onChange: (reason) => changes.push(reason),
    log: (message) => logs.push(message),
    ...fastTimings,
  });

  await waitFor(() => changes.includes("listening"), "the relay gave up on a server that became reachable");
  assert(server.connectCount === 4, `expected 3 refused attempts then 1 success, saw ${server.connectCount} attempts`);
  const outageLines = logs.filter((message) => message.includes("unavailable"));
  assert(outageLines.length === 1, `a continuing outage must be logged once, saw ${JSON.stringify(logs)}`);
  assert(logs.at(-1).includes("listening"), `recovery was not logged: ${JSON.stringify(logs)}`);

  await relay.stop();
}

// --------------------------------------------------------------------------
// stop() during an outage cancels the retry
// --------------------------------------------------------------------------

{
  const server = createStandInServer();
  server.refuseConnections = Number.POSITIVE_INFINITY;
  const relay = createDataChangeRelay({ connect: server.connect, onChange: () => undefined, log: () => undefined, ...fastTimings });

  await waitFor(() => server.connectCount >= 2, "the relay did not retry a refused connection");
  await relay.stop();
  const attemptsAtStop = server.connectCount;
  await new Promise((resolve) => setTimeout(resolve, fastTimings.retryDelayMs * 8));
  assert(server.connectCount === attemptsAtStop, `a stopped relay kept reconnecting (${attemptsAtStop} -> ${server.connectCount})`);
}

console.log("Data change relay regression passed");
