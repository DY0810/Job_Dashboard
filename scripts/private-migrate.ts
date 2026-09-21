import { getPrivateDb, migratePrivateDb, PrivateConfigurationError, type PrivateDb } from '../lib/private-db/index.ts';

let db: PrivateDb | undefined;
try {
  db = getPrivateDb();
  await migratePrivateDb(db);
  console.log('Private database migrations applied.');
} catch (error) {
  console.error(error instanceof PrivateConfigurationError ? error.message : 'Private database migration failed.');
  process.exitCode = 1;
} finally {
  db?.$client.close();
}
