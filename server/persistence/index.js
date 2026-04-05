import { createFileAdapter } from "./fileAdapter.js";
import { createDynamoAdapter } from "./dynamoAdapter.js";
import { getConfig } from "../config.js";

export function createPersistence() {
  const config = getConfig();
  const mode = config.persistenceMode;
  if (mode === "dynamo") {
    const table = config.dynamoTableName;
    if (!table) throw new Error("DYNAMODB_TABLE_NAME is required for PERSISTENCE=dynamo");
    return createDynamoAdapter(table, config.awsRegion);
  }
  const filePath = config.devFilePath;
  return createFileAdapter(filePath);
}
