/**
 * The prompts on an interactive start: the unwrap token, then the hook's
 * signing secret, each read with no echo. They run after the server is up and
 * the addresses are printed, so the person can create the hook in Ravn with
 * the address and paste its secret back.
 *
 * ❗Nothing typed is ever written back: not echoed, not quoted in a rejection,
 * not logged.
 */

export interface PromptInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface PromptOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

export interface PromptIO {
  input: PromptInput;
  output: PromptOutput;
}

export const UNWRAP_PREFIX = "rvu_";

export const TOKEN_QUESTION =
  "Unwrap token, from Service accounts in Ravn (Enter to skip: receive only):";

export function secretQuestion(address: string): string {
  return `Create the hook in Ravn with delivery address ${address}, then paste its signing secret:`;
}

/** Prompt only when both ends are a terminal: never in Docker without -it, or in Kubernetes. */
export function interactive(io: PromptIO): boolean {
  return io.input.isTTY === true && io.output.isTTY === true;
}

/** What to ask for. An environment variable, or a saved value, always wins over a prompt. */
export function whatToAsk(opts: {
  interactive: boolean;
  unwrapToken: string | null;
  accessTokenOnly: string | null;
  savedRefreshToken: boolean;
  secret: string | null;
}): { token: boolean; secret: boolean } {
  if (!opts.interactive) return { token: false, secret: false };
  return {
    token: !opts.unwrapToken && !opts.accessTokenOnly && !opts.savedRefreshToken,
    secret: opts.secret === null,
  };
}

/** Why a paste into the token prompt is refused, or null. Empty is a skip, not a refusal. */
export function refuseToken(value: string): string | null {
  if (/\s/.test(value)) return "that has whitespace in it; paste the unwrap token again";
  if (!value.startsWith(UNWRAP_PREFIX)) {
    return `that is not an unwrap token (they start ${UNWRAP_PREFIX}); paste it again, or Enter to skip`;
  }
  return null;
}

/** Why a paste into the secret prompt is refused, or null. */
export function refuseSecret(value: string): string | null {
  if (value === "") return "nothing was pasted; paste the hook's signing secret (Ctrl-C to quit)";
  if (/\s/.test(value)) return "that has whitespace in it; paste the signing secret again";
  if (value.startsWith(UNWRAP_PREFIX)) {
    return "that is the unwrap token, not the hook's signing secret; paste the signing secret";
  }
  return null;
}

/**
 * Read one line with no echo, in raw mode. Backspace deletes, Ctrl-U clears,
 * Enter (or Ctrl-D) submits, Ctrl-C resolves null. Escape sequences, such as
 * a terminal's bracketed-paste markers, are dropped.
 */
export function readHidden(io: PromptIO, question: string): Promise<string | null> {
  const { input, output } = io;
  output.write(`${question} `);
  input.setRawMode?.(true);
  return new Promise((resolve) => {
    let value = "";
    const done = (result: string | null) => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      const text = String(chunk).replace(/\x1b\[[0-9;]*[~A-Za-z]/g, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(value);
        if (ch === "\u0003") return done(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch === "\u0015") value = "";
        else if (ch === "\t" || ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}

export interface SetupOptions {
  io: PromptIO;
  ask: { token: boolean; secret: boolean };
  /** The `/` URL Ravn delivers to. */
  address: string;
  /** Redeem the token and print the account's state. */
  onToken: (token: string) => Promise<void>;
  /** Put the secret into effect and save it. */
  onSecret: (secret: string) => void | Promise<void>;
}

/** Ask what `ask` says, again after each refused paste. "interrupted": Ctrl-C. */
export async function promptSetup(opts: SetupOptions): Promise<"done" | "interrupted"> {
  const { io } = opts;
  const say = (line: string) => io.output.write(`${line}\n`);
  if (opts.ask.token) {
    for (;;) {
      const token = await readHidden(io, TOKEN_QUESTION);
      if (token === null) return "interrupted";
      if (token === "") {
        say("skipped: receive only, no answers or reads");
        break;
      }
      const why = refuseToken(token);
      if (why) {
        say(why);
        continue;
      }
      await opts.onToken(token);
      break;
    }
  }
  if (opts.ask.secret) {
    for (;;) {
      const secret = await readHidden(io, secretQuestion(opts.address));
      if (secret === null) return "interrupted";
      const why = refuseSecret(secret);
      if (why) {
        say(why);
        continue;
      }
      await opts.onSecret(secret);
      break;
    }
  }
  return "done";
}
