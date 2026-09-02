// Single source of truth for product-specific identifiers.
// Every script reads tags, the application id, and entity prefixes from here so
// that pointing the kit at a different product is a one-file change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const file = path.join(ROOT, "kit.config.json");
if (!fs.existsSync(file)) {
  console.error(`error: kit.config.json not found at ${file}`);
  process.exit(1);
}

export const config = JSON.parse(fs.readFileSync(file, "utf8"));

/** The application (interface) id used for applicationId scoping and user fetches. */
export const APP_ID = config.product.applicationId;

/** Tags that define automation membership. Membership is by TAG, never by name. */
export const AUTOMATION_TAGS = config.tags.automations;

/** Tags that define which object types are part of the product's data model. */
export const ENTITY_TAGS = config.tags.entityTypes;

/** Loud tag for throwaway clones, so they are never mistaken for the real family. */
export const TEST_TAG = config.tags.test;

/** Prefix every product object type name starts with (e.g. "icm" -> icmPlan). */
export const ENTITY_PREFIX = config.entities.prefix;

/** Default tag to use when a command takes --tag and none was passed. */
export const DEFAULT_TAG = AUTOMATION_TAGS[0];
