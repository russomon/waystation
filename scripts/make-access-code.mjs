#!/usr/bin/env node
// Generate a judge access code and its scrypt hash.
//
//   node scripts/make-access-code.mjs
//
// The CODE is printed once, to this terminal only. Put it in a password manager
// and hand it to judges privately. The HASH is what goes on the VPS as
// WAYSTATION_ACCESS_CODE_HASH — the plaintext code is never stored, committed,
// logged, or written to documentation.
//
// Rotation (see the MVP runbook): generate a new pair, update the VPS secret,
// restart the gateway, reissue instructions, retire the old code.
import { randomBytes } from "node:crypto";
import { hashAccessCode } from "../gateway/src/auth.ts";

// ~103 bits of entropy in an unambiguous alphabet (no O/0/I/l), grouped for
// dictation over a call without transcription errors.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const pick = (n) =>
  Array.from(randomBytes(n))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join("");
const code = [pick(5), pick(5), pick(5), pick(5)].join("-");

console.log("\n  access code (give privately, store in a password manager):\n");
console.log(`    ${code}\n`);
console.log("  gateway configuration (safe to place in VPS secret config):\n");
console.log(`    WAYSTATION_ACCESS_CODE_HASH='${hashAccessCode(code)}'`);
console.log(`    WAYSTATION_SESSION_SECRET='${randomBytes(32).toString("base64url")}'\n`);
console.log("  Do not commit these. Do not put the code in Devpost text, docs, or screenshots.\n");
