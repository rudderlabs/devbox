import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { config } from "../config";
import * as schema from "./schema";

const client = new SQL(config.databaseUrl);
export const db = drizzle({ client, schema });
export { schema };
