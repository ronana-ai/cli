// The CLI's own version, read from its package.json at run time (it sits one
// folder up from both `src/` and the published `dist/`), so it can never drift
// from the version npm installed.

import { createRequire } from "node:module";

export const CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
