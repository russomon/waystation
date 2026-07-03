// Load .env (repo root) before any module reads process.env. Imported FIRST
// by server.ts so s3.ts sees B2 creds. Node 20.12+/25 has process.loadEnvFile.
import { existsSync } from "node:fs";

// Skip when the environment already provides B2 creds (proof scripts / CI set
// them inline) so we never clobber an explicit config with .env placeholders.
if (!process.env.B2_S3_ENDPOINT) {
  for (const p of ["../.env", ".env", "../../.env"]) {
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* older node / already loaded */ }
      break;
    }
  }
}
