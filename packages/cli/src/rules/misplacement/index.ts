import type { Rule } from "../../types.js";
import { serverLogicInClient } from "./server-logic-in-client.js";
import { authCryptoInClient } from "./auth-crypto-in-client.js";
import { clientFetchCouldBeServer } from "./client-fetch-could-be-server.js";
import { envVarMisuse } from "./env-var-misuse.js";
import { thirdPartyScriptAsImport } from "./third-party-script-as-import.js";
import { staticContentRenderedClient } from "./static-content-rendered-client.js";
import { useServerFileMixedExports } from "./use-server-file-mixed-exports.js";
import { middlewareHeavyImports } from "./middleware-heavy-imports.js";

export const misplacementRules: Rule[] = [
  serverLogicInClient,
  authCryptoInClient,
  clientFetchCouldBeServer,
  envVarMisuse,
  thirdPartyScriptAsImport,
  staticContentRenderedClient,
  useServerFileMixedExports,
  middlewareHeavyImports,
];
