/**
 * Applies pending migrations and seeds products, then exits.
 * Usage: npm run db:migrate  (respects DB_PATH)
 */
import { loadConfig } from '../config';
import { openDatabase } from './database';

const { dbPath } = loadConfig();
const db = openDatabase(dbPath);
db.$client.close();
console.log(`Database ready at ${dbPath}`);
