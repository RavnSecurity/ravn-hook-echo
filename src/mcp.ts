/**
 * Reads over Ravn's MCP server, as the service account.
 *
 * After each delivered packet the hook asks Ravn four questions about the case
 * it was sent: `get_case`, `get_reporter_facts`, `find_similar` and
 * `lookup_precedents`. The server is MCP's Streamable HTTP transport in its
 * stateless form: one JSON-RPC message per POST, one JSON body back.
 *
 * ❗What is kept of an answer is its code and its counts (how many packets,
 * facts, similar cases), never a value. The answers are about a real case and
 * a real reporter; the viewer is on the internet.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const READ_TOOLS = [
  "get_case",
  "get_reporter_facts",
  "find_similar",
  "lookup_precedents",
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

/** One read, as the viewer shows it. */
export interface ReadRecord {
  tool: ReadTool;
  /** HTTP status, or null when nothing came back. */
  status: number | null;
  /** Ravn's answer code (`3-packets`, `not-observed`, `too-few`, `not_bound`, …), or why it was not asked. */
  code: string;
  isError: boolean;
  /** The length of each list in the answer, by its field path. Never a value. */
  counts: Record<string, number>;
  latencyMs: number;
}

export interface ReadContext {
  /** Ravn's report id, from the envelope. */
  reportId: string;
  /** The envelope's `asOf`: every read is as of the instant the packet was resolved. */
  asOf: string;
  /** The reporter's account at the source, when a packet named it. */
  reporter: { source: string; externalId: string } | null;
}

export interface Caller {
  accessToken(): Promise<string | null>;
  unauthorized(spent: string): Promise<string | null>;
}

export class McpReader {
  private readonly url: string;
  private readonly caller: Caller;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;
  private readonly now: () => number;
  private initialized = false;
  private nextId = 1;

  constructor(opts: {
    url: string;
    caller: Caller;
    version: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.url = opts.url;
    this.caller = opts.caller;
    this.version = opts.version;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async readAll(ctx: ReadContext): Promise<ReadRecord[]> {
    const caseArg = { asOf: ctx.asOf, case: ctx.reportId };
    const out: ReadRecord[] = [];
    out.push(await this.read("get_case", caseArg));
    out.push(
      ctx.reporter
        ? await this.read("get_reporter_facts", { asOf: ctx.asOf, reporter: ctx.reporter })
        : {
            tool: "get_reporter_facts",
            status: null,
            code: "not-asked: no packet for this case named its reporter",
            isError: false,
            counts: {},
            latencyMs: 0,
          },
    );
    out.push(await this.read("find_similar", caseArg));
    out.push(await this.read("lookup_precedents", { asOf: ctx.asOf }));
    return out;
  }

  private async read(tool: ReadTool, args: Record<string, unknown>): Promise<ReadRecord> {
    const started = this.now();
    const done = (r: Omit<ReadRecord, "tool" | "latencyMs">): ReadRecord => ({
      tool,
      ...r,
      latencyMs: Math.max(0, this.now() - started),
    });
    if (!this.initialized) {
      const init = await this.rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ravn-hook-echo", version: this.version },
      });
      if (!init.ok)
        return done({ status: init.status, code: init.code, isError: true, counts: {} });
      await this.rpc("notifications/initialized", undefined, true);
      this.initialized = true;
    }
    const r = await this.rpc("tools/call", { name: tool, arguments: args });
    if (!r.ok) return done({ status: r.status, code: r.code, isError: true, counts: {} });
    const result = r.result as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    const sc = result?.structuredContent ?? {};
    const err = sc.error as { code?: unknown } | undefined;
    const code =
      typeof sc.answer === "string"
        ? sc.answer
        : typeof err?.code === "string"
          ? err.code
          : result?.isError
            ? "tool-error"
            : "answered";
    return done({
      status: r.status,
      code,
      isError: result?.isError === true,
      counts: countsOf(sc),
    });
  }

  private async rpc(
    method: string,
    params: unknown,
    notification = false,
  ): Promise<
    | { ok: true; status: number; result: unknown }
    | { ok: false; status: number | null; code: string }
  > {
    let token = await this.caller.accessToken();
    if (!token) return { ok: false, status: null, code: "no-token" };
    const message = {
      jsonrpc: "2.0",
      ...(notification ? {} : { id: this.nextId++ }),
      method,
      ...(params === undefined ? {} : { params }),
    };
    for (let tries = 0; ; tries++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { ok: false, status: null, code: "network" };
      }
      if (res.status === 401 && tries === 0) {
        const next = await this.caller.unauthorized(token);
        if (next) {
          token = next;
          continue;
        }
      }
      if (notification) return { ok: true, status: res.status, result: null };
      let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        return { ok: false, status: res.status, code: `http-${res.status}` };
      }
      if (body.error) return { ok: false, status: res.status, code: rpcCode(body.error) };
      return { ok: true, status: res.status, result: body.result };
    }
  }
}

/**
 * Ravn's refusals carry a code word as the JSON-RPC message (`not_bound`,
 * `no_identity`, `unavailable`). Any other error's message can quote an
 * argument, and an argument came from the packet, so only its number is kept.
 */
function rpcCode(error: { code?: unknown; message?: unknown }): string {
  if (typeof error.message === "string" && /^[a-z_]{1,40}$/.test(error.message)) {
    return error.message;
  }
  return `jsonrpc-${typeof error.code === "number" ? error.code : "error"}`;
}

/**
 * The length of every list in an answer, by the path of field names to it.
 * Only names that read as field names (`thisProgram`, `facts`) are followed: a
 * map keyed by data is not walked into, so no key from it is kept either.
 */
export function countsOf(value: unknown, max = 20): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (node: unknown, path: string, depth: number): void => {
    if (Object.keys(counts).length >= max) return;
    if (Array.isArray(node)) {
      if (path) counts[path] = node.length;
      return;
    }
    if (!node || typeof node !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k)) continue;
      // A Maybe's list is the field's list: `similar.value` reads as `similar`.
      walk(v, k === "value" && path ? path : path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return counts;
}
