import { existsSync } from "node:fs";
import { ServiceAccount } from "./account.js";
import { Ravn, ravnUrls } from "./answers.js";
import { ConfigError, parseConfig, USAGE } from "./config.js";
import { McpReader } from "./mcp.js";
import { fetchPublishedSchema, loadVendoredSchema, SCHEMA_ID, StageSchema } from "./schema.js";
import { createHookServer } from "./server.js";
import { HOOKABLE } from "./stages.js";
import { DeliveryStore } from "./store.js";
import { VERSION } from "./version.js";

const SCHEMA_REFRESH_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`ravn-hook-echo: ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (config === "help") {
    console.log(USAGE);
    return;
  }
  const cfg = config;

  let schema = new StageSchema(loadVendoredSchema(), { kind: "vendored" });
  const refresh = async () => {
    const doc = await fetchPublishedSchema();
    if (doc) {
      schema = new StageSchema(doc, { kind: "published", fetchedAt: new Date().toISOString() });
    }
    return doc !== null;
  };
  if (cfg.fetchSchema) {
    const ok = await refresh();
    if (!ok) {
      console.log(`schema: ${SCHEMA_ID} is not reachable as JSON; using the vendored copy`);
    }
    setInterval(() => void refresh(), SCHEMA_REFRESH_MS).unref();
  }

  const store = new DeliveryStore({ retentionHours: cfg.retentionHours });
  setInterval(() => store.sweep(), 60_000).unref();

  // As a service account, when given a credential or a saved refresh token.
  const urls = ravnUrls(cfg.ravnUrl);
  let ravn: Ravn | undefined;
  if (cfg.unwrapToken || cfg.accessTokenOnly || existsSync(cfg.stateFile)) {
    const account = new ServiceAccount({
      gatewayUrl: urls.gateway,
      unwrapToken: cfg.unwrapToken,
      accessTokenOnly: cfg.accessTokenOnly,
      stateFile: cfg.stateFile,
    });
    await account.start();
    account.keepFresh();
    ravn = new Ravn({
      account,
      reader: new McpReader({ url: urls.mcp, caller: account, version: VERSION }),
      answersUrl: urls.answers,
      stages: new Set(cfg.answerStages),
      schema: () => schema,
    });
  }

  const server = createHookServer({
    secret: cfg.secret,
    viewToken: cfg.viewToken,
    showValues: cfg.showValues,
    retentionHours: cfg.retentionHours,
    version: VERSION,
    store,
    schema: () => schema,
    schemaId: SCHEMA_ID,
    ...(ravn ? { ravn } : {}),
  });

  server.listen(cfg.port, cfg.host, () => {
    const base = cfg.publicBaseUrl;
    console.log(`ravn-hook-echo ${VERSION} listening on ${cfg.host}:${cfg.port}`);
    console.log(`schema: ${schema.source.kind} (${SCHEMA_ID})`);
    console.log("hook URLs, one per stage:");
    for (const s of HOOKABLE) console.log(`  ${base}/${s}`);
    console.log(`  ${base}/  (dispatches on x-ravn-event)`);
    console.log("viewer (keep this URL private; the token is the part after #k=):");
    console.log(`  ${base}/view#k=${cfg.viewToken}`);
    if (cfg.showValues) console.log("--show-values is on: the viewer shows packet values.");
    if (ravn) {
      const stages = cfg.answerStages.length ? cfg.answerStages.join(", ") : "none";
      const { state, code } = ravn.status();
      console.log(
        `service account on ${cfg.ravnUrl}: ${state}${code ? ` (${code})` : ""}; ` +
          `answers ${stages}; reads over MCP`,
      );
    } else {
      console.log("no service account: receiving only (set RAVN_UNWRAP_TOKEN to answer)");
    }
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main();
