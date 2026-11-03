import { defineConfig } from 'drizzle-kit';

// Used by `npm run db:generate` to turn src/db/schema.ts into SQL migrations in ./drizzle.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
