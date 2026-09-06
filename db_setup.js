/* 连接 PostgreSQL，创建 kv 表（词库数据的存储位置），并做连通性自检 */
const { Client } = require('pg');

const cfg = {
  host: 'localhost',
  port: 5432,
  user: 'postuser',
  password: 'postuser',
  database: 'postuser',
};

(async () => {
  const c = new Client(cfg);
  try {
    await c.connect();
    const v = await c.query('select version()');
    console.log('✅ 连接成功');
    console.log('   PostgreSQL:', v.rows[0].version.split(' ').slice(0, 2).join(' '));

    await c.query(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log('✅ 已确保表 kv 存在');

    // 自检：写一条再读回来
    await c.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['__selfcheck__', { ok: true, ts: Date.now() }]
    );
    const r = await c.query('SELECT value FROM kv WHERE key=$1', ['__selfcheck__']);
    console.log('✅ 读写自检:', JSON.stringify(r.rows[0].value));
    await c.query('DELETE FROM kv WHERE key=$1', ['__selfcheck__']);
    console.log('✅ 清理自检数据完成');
  } catch (e) {
    console.error('❌ 数据库操作失败:', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
