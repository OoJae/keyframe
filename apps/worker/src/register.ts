// Node 24 runs this package's TypeScript directly (type stripping). The vendored protocol (src/protocol) keeps
// NodeNext-style "./x.js" specifiers so the same bytes also typecheck and bundle in its other consumers; Node does
// not map ".js" to ".ts" by itself, so this hook does it for relative specifiers whose .js file does not exist.
// Import this module before anything that (transitively) imports src/protocol.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (
      parent?.startsWith("file:") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      const asJs = new URL(specifier, parent);
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, parent);
      if (!existsSync(asJs) && existsSync(asTs)) return nextResolve(asTs.href, context);
    }
    return nextResolve(specifier, context);
  },
});
