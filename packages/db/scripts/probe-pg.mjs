import postgres from 'postgres';
const url = process.env.PROBE_URL;
const sql = postgres(url, { ssl: 'prefer', connect_timeout: 10, max: 1 });
try {
  const tables =
    await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
  const exts = await sql`SELECT extname FROM pg_extension ORDER BY extname`;
  const pgver = await sql`SHOW server_version`;
  const avail =
    await sql`SELECT name FROM pg_available_extensions WHERE name IN ('postgis','pgcrypto','uuid-ossp','pg_trgm') ORDER BY name`;
  console.log('server_version:', pgver[0].server_version);
  console.log('installed_extensions:', exts.map((e) => e.extname).join(','));
  console.log('available_relevant:', avail.map((e) => e.name).join(','));
  console.log('table_count:', tables.length);
  console.log(
    'tables:',
    tables
      .slice(0, 30)
      .map((t) => t.table_name)
      .join(','),
  );
} catch (e) {
  console.log('error:', String(e).slice(0, 200));
}
await sql.end();
