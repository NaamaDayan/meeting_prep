import { createFileAdapter } from "./fileAdapter.js";
import { createDynamoAdapter } from "./dynamoAdapter.js";

export function createPersistence() {
  const mode = process.env.PERSISTENCE || "file";
  if (mode === "dynamo") {
    const table = process.env.DYNAMODB_TABLE_NAME;
    if (!table) throw new Error("DYNAMODB_TABLE_NAME is required for PERSISTENCE=dynamo");
    return createDynamoAdapter(table);
  }
  const filePath = process.env.MEETING_PREP_DEV_FILE || "data/preps.json";
  return createFileAdapter(filePath);
}
