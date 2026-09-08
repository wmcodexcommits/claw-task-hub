const defaultApiBase = `http://127.0.0.1:${process.env.PORT ?? "4781"}/api`;

export async function notifyOpenUis(source: string) {
  const apiBase = (process.env.CLAW_TASK_HUB_API_BASE ?? defaultApiBase).replace(/\/$/, "");
  try {
    await fetch(`${apiBase}/events/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
      signal: AbortSignal.timeout(250),
    });
  } catch {
    // The API/UI is optional for CLI and stdio MCP use. The mutation remains
    // durable even when no UI process is available to receive the edge event.
  }
}
