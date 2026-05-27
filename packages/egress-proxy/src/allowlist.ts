// Hostname allowlist matching with wildcard prefix support.
//
// Supported pattern forms:
//   - Exact:    "api.systema.test"        only matches "api.systema.test"
//   - Wildcard: "*.systema.test"          matches "systema.test", "api.systema.test",
//                                         "v2.systema.test", "a.b.systema.test"
//
// Matching is case-insensitive on the hostname only (DNS names are
// case-insensitive). We do not match against IPs specially — if someone
// allowlists "127.0.0.1" or "10.0.0.5" it works as an exact string match.

export function hostnameAllowed(hostname: string, allowlist: string[]): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  for (const raw of allowlist) {
    const pattern = raw.toLowerCase().trim();
    if (!pattern) continue;
    if (pattern === host) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      if (!suffix) continue;
      if (host === suffix) return true;
      if (host.endsWith("." + suffix)) return true;
    }
  }
  return false;
}
