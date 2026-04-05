import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { getConfig } from "./config.js";

const ssmValueCache = new Map();
let ssmClient;

function getSsmClient() {
  if (!ssmClient) {
    const config = getConfig();
    ssmClient = new SSMClient({ region: config.awsRegion });
  }
  return ssmClient;
}

function looksLikeSsmParameterPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") || trimmed.startsWith("ssm://");
}

function normalizeSsmParameterName(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("ssm://")) {
    const withoutScheme = trimmed.slice("ssm://".length);
    return withoutScheme.startsWith("/") ? withoutScheme : `/${withoutScheme}`;
  }
  return trimmed;
}

export async function resolveSecretValue(rawValue) {
  const input = String(rawValue || "").trim();
  if (!input) return "";
  if (!looksLikeSsmParameterPath(input)) return input;

  const parameterName = normalizeSsmParameterName(input);
  if (ssmValueCache.has(parameterName)) {
    return ssmValueCache.get(parameterName);
  }

  const client = getSsmClient();
  const response = await client.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    })
  );

  const value = String(response.Parameter?.Value || "").trim();
  ssmValueCache.set(parameterName, value);
  return value;
}

export async function resolveEnvSecret(envName) {
  const resolved = await resolveSecretValue(process.env[envName]);
  if (resolved) {
    process.env[envName] = resolved;
  }
  return resolved;
}
