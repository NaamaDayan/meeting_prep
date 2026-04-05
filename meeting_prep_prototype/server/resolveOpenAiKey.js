import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Resolved key or null; only successful resolutions stay cached. */
let cachePromise = null;

/**
 * OPENAI_API_KEY may be:
 * - A raw key (starts with `sk-`) — used as-is (typical for local `server/.env`).
 * - An SSM parameter path (starts with `/`) — decrypted value loaded from Parameter Store (Lambda).
 */
export async function resolveOpenAiApiKey() {
  const raw = process.env.OPENAI_API_KEY?.trim();
  if (!raw) return null;

  if (cachePromise) return cachePromise;

  if (raw.startsWith("sk-")) {
    cachePromise = Promise.resolve(raw);
    return cachePromise;
  }

  if (raw.startsWith("/")) {
    cachePromise = (async () => {
      try {
        const client = new SSMClient({
          region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
        });
        const out = await client.send(
          new GetParameterCommand({ Name: raw, WithDecryption: true })
        );
        const value = out.Parameter?.Value?.trim();
        if (!value) throw new Error("SSM parameter value is empty");
        return value;
      } catch (e) {
        cachePromise = null;
        throw e;
      }
    })();
    return cachePromise;
  }

  cachePromise = Promise.resolve(raw);
  return cachePromise;
}
