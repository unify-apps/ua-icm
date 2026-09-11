#!/usr/bin/env node
// UPLOAD a local file into platform storage, and print the `fileDetails` object an
// automation's CSV loop node reads (`sourceType` + `source`).
//
//   node scripts/ua-upload.mjs <file.csv> [--env orbit|tool]
//
// WHY THIS EXISTS. A bulk-upload automation takes a FILE, not rows, so its regression
// suite needs files that already sit in storage. The app uploads through the SDK's Uppy
// plugin; from a script the same three calls it makes are enough, read from
// www/packages/carbon/src/hooks/useUppy/NfsMultipartUpload and uacode FileRestAPI.java:
//
//   GET  /api/file/upload-bucket                     -> { directory }
//   POST /api/file/create-multipart-upload           { fileName, mimeType, directory } -> { uploadId }
//   POST /api/file/upload-part                       multipart: file, partNumber, uploadId
//   POST /api/file/complete-multipart-upload?uploadId=...&accessScope=ALL_USERS -> { key, location }
//
// That is the "unifyapps" storage provider, which is what tool answers from
// /api/file/cloud-storage-provider (checked 2026-09-11). The script asks first and refuses
// any other provider rather than uploading somewhere the loop node cannot read.
//
// It writes a FILE, never a record, and nothing references the file until a suite or a
// caller passes its `fileDetails` on. Writes to PRODUCTION only with an explicit
// `--env tool` on the command line.

import fs from "node:fs";
import path from "node:path";
import { resolveEnv } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const { env, baseUrl, cookie, args } = resolveEnv({ write: true });
const [file] = args;
if (!file) die("usage: ua-upload.mjs <file> [--env orbit|tool]");
if (!fs.existsSync(file)) die(`no such file: ${file}`);

const auth = { cookie: `_at=${cookie}` };
async function call(pathname, init = {}) {
  const res = await fetch(baseUrl + pathname, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const { provider } = await call("/api/file/cloud-storage-provider");
if (provider !== "unifyapps") die(`storage provider on ${env} is "${provider}", not "unifyapps" - this script only speaks the NFS multipart API`);

const bytes = fs.readFileSync(file);
const fileName = path.basename(file);
const mimeType = fileName.toLowerCase().endsWith(".csv") ? "text/csv" : "application/octet-stream";

const { directory } = await call("/api/file/upload-bucket");
const { uploadId } = await call("/api/file/create-multipart-upload", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ fileName, mimeType, directory }),
});
if (!uploadId) die("create-multipart-upload returned no uploadId");

const form = new FormData();
form.append("file", new Blob([bytes], { type: mimeType }), fileName);
form.append("partNumber", "1");
form.append("uploadId", uploadId);
await call("/api/file/upload-part", { method: "POST", body: form });

const { key, location } = await call(
  `/api/file/complete-multipart-upload?uploadId=${encodeURIComponent(uploadId)}&accessScope=ALL_USERS&isBuilderAsset=false`,
  { method: "POST" },
);
if (!key) die("complete-multipart-upload returned no key");

// The same shape the app's usePlatformUpload hands a bulk callable.
console.log(JSON.stringify({
  id: `upload-${uploadId}`, name: fileName, url: location ?? "", sourceType: "CLOUD_STORAGE", source: key,
  fileType: path.extname(fileName).slice(1) || "csv", size: bytes.length, type: "FILE", mimeType,
  progress: 100, isUploaded: true,
  meta: { accessScope: "ALL_USERS", name: fileName, type: mimeType, publicAcl: false, useExternalApi: false },
  hasError: false,
}));
