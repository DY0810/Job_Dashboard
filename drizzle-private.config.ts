import { defineConfig } from 'drizzle-kit';

// Generation only. Use db:private:migrate for validated, explicit database access.
export default defineConfig({
  schema: './lib/private-db/schema.ts',
  out: './drizzle-private',
  dialect: 'sqlite',
});
