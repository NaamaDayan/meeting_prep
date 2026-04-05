const DEFAULT_PORT = 3847;
const DEFAULT_DEV_FILE = "data/preps.json";
const DEFAULT_AWS_REGION = "eu-central-1";

function normalizeAppEnv(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "prod") return "production";
  if (raw === "dev") return "development";
  if (raw === "test") return "test";
  return raw || "development";
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthy(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function buildAllowedOriginChecker(config) {
  const allowed = new Set(config.corsAllowedOrigins);

  return function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowed.has(origin)) return true;

    if (origin.startsWith("chrome-extension://")) {
      if (allowed.has("chrome-extension://*")) return true;
      if (config.isDevelopment && config.allowChromeExtensionOriginsInDev) return true;
    }

    if (config.isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return true;
    }

    return false;
  };
}

export function getConfig() {
  const appEnv = normalizeAppEnv(
    process.env.APP_ENV || process.env.NODE_ENV || (process.env.AWS_LAMBDA_FUNCTION_NAME ? "production" : "development")
  );
  const isDevelopment = appEnv !== "production";

  const config = {
    appEnv,
    isDevelopment,
    isProduction: appEnv === "production",
    port: Number(process.env.PORT || DEFAULT_PORT),
    persistenceMode: String(process.env.PERSISTENCE || (isDevelopment ? "file" : "dynamo")).trim().toLowerCase(),
    devFilePath: String(process.env.MEETING_PREP_DEV_FILE || DEFAULT_DEV_FILE).trim(),
    awsRegion: String(process.env.AWS_REGION || DEFAULT_AWS_REGION).trim(),
    dynamoTableName: String(process.env.DYNAMODB_TABLE_NAME || "").trim(),
    adminToken: String(process.env.ADMIN_TOKEN || "").trim(),
    corsAllowedOrigins: parseCsv(process.env.CORS_ALLOWED_ORIGINS),
    allowChromeExtensionOriginsInDev: isTruthy(process.env.CORS_ALLOW_CHROME_EXTENSION_IN_DEV, true),
  };

  config.isAllowedOrigin = buildAllowedOriginChecker(config);
  return config;
}
