// Load .env into process.env (real env vars win). Missing file is fine.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

export const port = Number(process.env.PORT) || 3000;
