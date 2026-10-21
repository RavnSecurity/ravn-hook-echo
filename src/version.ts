import { readFileSync } from "node:fs";

/** This package's version, as `ranBy.version` in every echo output. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
