import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePk(userSub, eventId) {
  return `${userSub}#${encodeURIComponent(eventId)}`;
}

export function createFileAdapter(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(__dirname, "..", filePath);

  async function readAll() {
    try {
      const raw = await fs.readFile(resolved, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === "ENOENT") return { records: {} };
      throw e;
    }
  }

  async function writeAll(data) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, JSON.stringify(data, null, 2), "utf8");
  }

  return {
    async get(userSub, eventId) {
      const db = await readAll();
      const pk = makePk(userSub, eventId);
      return db.records[pk] || null;
    },

    async put(record) {
      const db = await readAll();
      const pk = makePk(record.userSub, record.calendarEventId);
      db.records[pk] = { ...record, pk };
      await writeAll(db);
    },

    async delete(userSub, eventId) {
      const db = await readAll();
      const pk = makePk(userSub, eventId);
      delete db.records[pk];
      await writeAll(db);
    },
  };
}
