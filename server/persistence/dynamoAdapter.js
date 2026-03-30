import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

function makePk(userSub, eventId) {
  return `${userSub}#${encodeURIComponent(eventId)}`;
}

export function createDynamoAdapter(tableName, region) {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: region || process.env.AWS_REGION || "us-east-1" })
  );

  return {
    async get(userSub, eventId) {
      const pk = makePk(userSub, eventId);
      const r = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk },
        })
      );
      return r.Item || null;
    },

    async put(record) {
      const pk = makePk(record.userSub, record.calendarEventId);
      const item = { ...record, pk };
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
        })
      );
    },

    async delete(userSub, eventId) {
      const pk = makePk(userSub, eventId);
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk },
        })
      );
    },
  };
}
