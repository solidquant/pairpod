import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source uses NodeNext ".js" import specifiers that resolve to ".ts" at build time. node --test
// strips types but doesn't rewrite the extension, so map ".js" → ".ts" when the sibling exists.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const tsURL = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(tsURL))) return { url: tsURL.href, shortCircuit: true };
  }
  return next(specifier, context);
}
