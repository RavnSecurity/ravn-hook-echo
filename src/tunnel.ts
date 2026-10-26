import { existsSync } from "node:fs";
import type { Server } from "node:http";

export const TUNNEL_PROVIDERS = ["cloudflare", "ngrok"] as const;
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number];

export type TunnelConfig =
  | { provider: "cloudflare" }
  /** `authtoken` is never printed. `domain` is ngrok's fixed address, when there is one. */
  | { provider: "ngrok"; authtoken: string; domain: string | null };

export interface Tunnel {
  /** The public HTTPS address, with no trailing slash. */
  url: string;
  close: () => Promise<void>;
}

/** Opens a tunnel to `target`, a local `http://host:port`. */
export type OpenTunnel = (config: TunnelConfig, target: string) => Promise<Tunnel>;

/** A tunnel that did not open. The message is the provider's reason, safe to print. */
export class TunnelError extends Error {}

const OPEN_TIMEOUT_MS = 60_000;

/**
 * Listens, then opens the tunnel when there is one. A tunnel that fails to
 * open closes the server again, so nothing is left serving on a local address
 * nobody can reach.
 */
export async function listenPublic(
  server: Server,
  opts: { port: number; host: string; publicBaseUrl: string; tunnel: TunnelConfig | null },
  open: OpenTunnel = openTunnel,
): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const closeServer = () => new Promise<void>((r) => server.close(() => r()));
  if (!opts.tunnel) return { base: opts.publicBaseUrl, close: closeServer };

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  let tunnel: Tunnel;
  try {
    tunnel = await open(opts.tunnel, `http://${reachable(opts.host)}:${port}`);
  } catch (e) {
    await closeServer();
    throw e;
  }
  return {
    base: tunnel.url.replace(/\/+$/, ""),
    close: async () => {
      await tunnel.close().catch(() => {});
      await closeServer();
    },
  };
}

/** The address a tunnel dials: a wildcard bind is reached on loopback. */
function reachable(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** The real providers. Each library is an optional dependency, loaded only here. */
export const openTunnel: OpenTunnel = (config, target) =>
  config.provider === "cloudflare" ? openCloudflare(target) : openNgrok(config, target);

async function load<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new TunnelError(
        `the ${name} package is not installed. It is an optional dependency of ravn-hook-echo: ` +
          `install without --omit=optional (or --no-optional), or run \`npm install ${name}\` beside it.`,
      );
    }
    throw e;
  }
}

interface CloudflaredTunnel {
  once(event: "url", listener: (url: string) => void): unknown;
  once(event: "connected", listener: () => void): unknown;
  once(event: "error", listener: (e: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "stderr", listener: (data: string) => void): unknown;
  stop: () => boolean;
}

interface CloudflaredModule {
  bin: string;
  install: (to: string) => Promise<string>;
  Tunnel: { quick: (url: string) => CloudflaredTunnel };
}

/** A Cloudflare quick tunnel: no account, a new `*.trycloudflare.com` address each start. */
async function openCloudflare(target: string): Promise<Tunnel> {
  const cf = await load<CloudflaredModule>("cloudflared");
  if (!existsSync(cf.bin)) {
    console.log(`tunnel: downloading cloudflared to ${cf.bin} (first use only)`);
    try {
      await cf.install(cf.bin);
    } catch (e) {
      throw new TunnelError(`could not download cloudflared: ${(e as Error).message}`);
    }
  }
  const t = cf.Tunnel.quick(target);
  // cloudflared is a child process: however this one ends, it goes too.
  const orphan = () => t.stop();
  process.once("exit", orphan);
  // cloudflared says why it failed on stderr, in lines marked ERR.
  const errors: string[] = [];
  t.on("stderr", (data) => {
    for (const line of data.split("\n")) {
      if (/\bERR\b/.test(line)) errors.push(line.replace(/^\S+\s+ERR\s+/, "").trim());
    }
  });
  const exited = new Promise<void>((r) => t.once("exit", () => r()));
  const url = await new Promise<string>((resolve, reject) => {
    let found: string | null = null;
    let connected = false;
    let settled = false;
    const done = () => {
      if (found && connected && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(found);
      }
    };
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      t.stop();
      reject(new TunnelError(`cloudflare: ${why}`));
    };
    const timer = setTimeout(
      () => fail(errors.at(-1) ?? `no tunnel within ${OPEN_TIMEOUT_MS / 1000}s`),
      OPEN_TIMEOUT_MS,
    );
    t.once("url", (u) => {
      found = u;
      done();
    });
    t.once("connected", () => {
      connected = true;
      done();
    });
    t.once("error", (e) => fail(e.message));
    t.once("exit", (code) =>
      fail(errors.at(-1) ?? `cloudflared exited (${code ?? "signal"}) before the tunnel opened`),
    );
  });
  return {
    url,
    close: async () => {
      process.off("exit", orphan);
      if (t.stop()) await exited;
    },
  };
}

interface NgrokModule {
  forward: (config: {
    addr: string;
    authtoken: string;
    domain?: string;
  }) => Promise<{ url: () => string | null; close: () => Promise<void> }>;
}

/** ngrok: needs an authtoken; `domain` is the fixed address on the free plan. */
async function openNgrok(
  config: Extract<TunnelConfig, { provider: "ngrok" }>,
  target: string,
): Promise<Tunnel> {
  const ngrok = await load<NgrokModule>("@ngrok/ngrok");
  // ❗Whatever ngrok says goes to the log; the authtoken never does.
  const scrub = (s: string) => s.split(config.authtoken).join("<NGROK_AUTHTOKEN>");
  let listener: Awaited<ReturnType<NgrokModule["forward"]>>;
  try {
    listener = await ngrok.forward({
      addr: target.replace(/^http:\/\//, ""),
      authtoken: config.authtoken,
      ...(config.domain ? { domain: config.domain } : {}),
    });
  } catch (e) {
    throw new TunnelError(`ngrok: ${scrub((e as Error).message ?? String(e))}`);
  }
  const url = listener.url();
  if (!url) {
    await listener.close().catch(() => {});
    throw new TunnelError("ngrok: the tunnel opened without an address");
  }
  return { url, close: () => listener.close() };
}
