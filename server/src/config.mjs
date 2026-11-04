// Gateway settings: a JSON file (gateway.config.json, or $BEYT_GATEWAY_CONFIG)
// plus $BEYT_TOKEN and $PORT. See gateway.config.example.json.

import { readFile } from "node:fs/promises";

export async function loadConfig(file = process.env.BEYT_GATEWAY_CONFIG ?? "gateway.config.json") {
  const config = JSON.parse(await readFile(file, "utf8"));
  return normalize({
    ...config,
    token: process.env.BEYT_TOKEN ?? config.token,
    port: Number(process.env.PORT ?? config.port ?? 8787),
  });
}

export function normalize(config) {
  if (!config.token || String(config.token).length < 16) {
    throw new Error("Set a token of at least 16 characters ($BEYT_TOKEN or \"token\" in the config). The gateway never runs open.");
  }
  const sources = config.sources ?? [];
  const ids = new Set();
  for (const s of sources) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id ?? "")) throw new Error(`Invalid source id "${s.id}": lowercase letters, digits and dashes.`);
    if (ids.has(s.id)) throw new Error(`Duplicate source id "${s.id}".`);
    if (!s.host) throw new Error(`Source "${s.id}" needs a host.`);
    ids.add(s.id);
  }
  return {
    port: 8787,
    host: "127.0.0.1",
    prefix: "/beyt/v1",
    dataDir: "./data",
    allowOrigin: "*",
    allowWrite: false,
    ...config,
    sources,
  };
}
