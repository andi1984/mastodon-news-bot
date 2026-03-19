import { createHash } from "node:crypto";

/**
 * Fast SHA-256 hash using Node.js native crypto.
 * Returns hex string.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
