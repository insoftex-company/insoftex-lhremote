// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH
//
// READ-ONLY probe: prints the fields of LinkedHelper's in-memory account list
// (runningLiAccountsService.extendedLinkedInAccountsBS), secrets redacted.
// Usage: node probe-account-fields.mjs <launcherCdpPort> <path\to\lhremote-core\dist\index.js>
import { pathToFileURL } from "node:url";

const [portArg, corePath] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || !corePath) {
  console.error("usage: node probe-account-fields.mjs <launcherCdpPort> <lhremote-core dist/index.js>");
  process.exit(2);
}
const { LauncherService } = await import(pathToFileURL(corePath).href);
const svc = new LauncherService(port);
await svc.connect();
try {
  const expr = `(async () => {
    ${LauncherService.LH_SERVICES_INIT}
    if (!lhSvc) return { error: "LH services not found" };
    const raw = lhSvc.runningLi.extendedLinkedInAccountsBS?.value;
    const entries = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
    const SECRET = /token|cookie|pass|secret|proxy|credential|jwt|apikey|api_key/i;
    const flat = (o, prefix, out, depth) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        const name = prefix + k;
        if (SECRET.test(k)) { out[name] = "[redacted]"; continue; }
        if (v === null || v === undefined || typeof v === "boolean" || typeof v === "number") out[name] = v ?? null;
        else if (typeof v === "string") out[name] = v.length <= 80 ? v : "[string " + v.length + "]";
        else if (Array.isArray(v)) out[name] = "[array " + v.length + "]";
        else if (typeof v === "object" && depth < 2) flat(v, name + ".", out, depth + 1);
        else out[name] = "[" + typeof v + "]";
      }
      return out;
    };
    return entries.map((a) => flat(a, "", {}, 0));
  })()`;
  // launcherEvaluate / ensureConnected are TypeScript-private, reachable at runtime.
  const result = await svc["launcherEvaluate"](svc["ensureConnected"](), expr, true);
  console.log(JSON.stringify(result, null, 2));
} finally {
  svc.disconnect();
}
