// Test-process instrumentation. Report transcript access even if a collector catches its failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

if (process.argv[1]?.endsWith('/local/server.mjs') && process.env.WORKBENCH_TEST_AUDIT) {
  const audit = process.env.WORKBENCH_TEST_AUDIT,
    outside = process.env.WORKBENCH_TEST_OUTSIDE;
  const transcripts = path.join(process.env.WORKBENCH_CODEX_HOME, 'sessions');
  function deny(value) {
    fs.appendFileSync(audit, 'DENIED ' + value + '\n');
    throw Error('Blocked by test observer');
  }
  function check(arg) {
    const file = arg instanceof URL ? fileURLToPath(arg) : arg;
    if (
      typeof file === 'string' &&
      [outside, transcripts].some((p) => file === p || file.startsWith(p + '/'))
    )
      deny('filesystem ' + file);
  }
  for (const [obj, methods] of [
    [fs, ['readFile', 'readFileSync', 'createReadStream', 'open', 'openSync', 'readdir', 'readdirSync']],
    [fs.promises, ['readFile', 'open', 'readdir', 'opendir']],
  ]) {
    for (const method of methods) {
      const original = obj[method];
      obj[method] = function (file, ...args) {
        check(file);
        return original.call(this, file, ...args);
      };
    }
  }
  syncBuiltinESMExports();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (
      /\bFROM threads\b/i.test(sql) &&
      !/^SELECT (DISTINCT cwd|id,created_at,updated_at(?:,name)?) FROM threads WHERE cwd=\?/i.test(
        sql,
      ) &&
      sql !== 'SELECT cwd FROM threads WHERE id=?' &&
      sql !== 'SELECT rollout_path FROM threads WHERE id=? AND cwd=?'
    )
      deny('unscoped SQL or forbidden columns');
    const stmt = prepare.call(this, sql);
    if (sql.startsWith('SELECT id,created_at,updated_at')) {
      const all = stmt.all.bind(stmt);
      stmt.all = (cwd, ...args) => {
        if (cwd === outside || cwd.includes('外部链接')) deny('metadata before path check');
        fs.appendFileSync(audit, 'allowed metadata\n');
        return all(cwd, ...args);
      };
    }
    return stmt;
  };
}
