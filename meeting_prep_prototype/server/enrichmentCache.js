import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {"dynamo" | "file" | "none"} EnrichmentCacheMode */

let fileLock = Promise.resolve();

/**
 * @param {() => Promise<void>} fn
 */
function withFileLock(fn) {
  const run = () => fn();
  const next = fileLock.then(run, run);
  fileLock = next.catch(() => {});
  return next;
}

function isLambdaRuntime() {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Local default: next to this module (gitignored). Lambda default: /tmp only
 * writable path — /var/task is read-only (avoids EROFS without DynamoDB).
 */
function defaultFilePath() {
  const fromEnv = process.env.ENRICHMENT_CACHE_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(process.cwd(), fromEnv);
  }
  if (isLambdaRuntime()) {
    return "/tmp/meeting-prep-enrichment-cache.json";
  }
  return path.join(__dirname, ".enrichment-cache.json");
}

/**
 * @returns {{ mode: EnrichmentCacheMode, get: (key: string) => Promise<any|null>, set: (key: string, value: unknown) => Promise<void> }}
 */
export function createEnrichmentCache() {
  const table = process.env.ENRICHMENT_CACHE_TABLE?.trim();
  if (table) {
    const region = process.env.AWS_REGION || "us-east-1";
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    return {
      mode: "dynamo",
      async get(key) {
        const out = await doc.send(
          new GetCommand({ TableName: table, Key: { pk: key } })
        );
        const raw = out.Item?.payload;
        if (raw == null) return null;
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return raw;
      },
      async set(key, value) {
        const ttlSec = Number(process.env.ENRICHMENT_CACHE_TTL_SEC);
        const item = {
          pk: key,
          payload: JSON.stringify(value),
        };
        if (Number.isFinite(ttlSec) && ttlSec > 0) {
          item.ttl = Math.floor(Date.now() / 1000) + ttlSec;
        }
        await doc.send(new PutCommand({ TableName: table, Item: item }));
      },
    };
  }

  const filePath = defaultFilePath();
  return {
    mode: "file",
    async get(key) {
      try {
        const text = await readFile(filePath, "utf8");
        const all = JSON.parse(text);
        return all[key] ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await withFileLock(async () => {
        let all = {};
        try {
          const text = await readFile(filePath, "utf8");
          all = JSON.parse(text);
        } catch {
          all = {};
        }
        all[key] = value;
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(all, null, 0), "utf8");
      });
    },
  };
}
