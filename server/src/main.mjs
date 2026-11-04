import { loadConfig } from "./config.mjs";
import { createGateway } from "./server.mjs";

const config = await loadConfig();
const server = await createGateway(config);
server.listen(config.port, config.host, () => {
  console.log(`Beyt gateway on http://${config.host}:${config.port}${config.prefix} (${config.sources.length} source(s))`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
