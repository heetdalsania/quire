import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Read one exact Quick Tunnel hostname from a locally controlled file. */
export function readQuickTunnelHost(path) {
  if (process.platform === "win32") {
    throw new Error("Private host-file permissions cannot be verified on Windows; use --allow-host with a fixed hostname");
  }
  const parent = lstatSync(dirname(path));
  const stat = lstatSync(path);
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 ||
      !stat.isFile() || (stat.mode & 0o022) !== 0 ||
      (process.getuid && (parent.uid !== process.getuid() || stat.uid !== process.getuid()))) {
    throw new Error("Quick Tunnel host file and directory must be owned by you and not writable by others");
  }
  if (stat.size > 255) throw new Error("Quick Tunnel host file is too large");
  const host = readFileSync(path, "utf8").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(host)) {
    throw new Error("Quick Tunnel host file must contain one exact trycloudflare.com hostname");
  }
  return host;
}
