/** Numbered, append-only migrations. Never edit one that has shipped; add a new one. */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE repos (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX tasks_state ON tasks (state);
      CREATE INDEX tasks_project ON tasks (project_id);
      CREATE TABLE transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX transitions_task ON transitions (task_id, id);
      CREATE TABLE specs (task_id TEXT NOT NULL, version INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (task_id, version));
      CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX approvals_task ON approvals (task_id);
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT, thread_id TEXT, doc TEXT NOT NULL);
      CREATE INDEX runs_task ON runs (task_id);
      CREATE INDEX runs_thread ON runs (thread_id);
      CREATE TABLE verify_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX verify_runs_task ON verify_runs (task_id);
      CREATE TABLE criterion_tests (task_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE findings (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX findings_task ON findings (task_id);
      CREATE TABLE prs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT, doc TEXT NOT NULL);
      CREATE INDEX prs_task ON prs (task_id);
      CREATE INDEX prs_status ON prs (status);
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, doc TEXT NOT NULL);
      CREATE INDEX threads_project ON threads (project_id);
      CREATE INDEX threads_task ON threads (task_id);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX messages_thread ON messages (thread_id, seq);
      CREATE TABLE rules (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, status TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX rules_repo ON rules (repo_id, status);
      CREATE TABLE usage (id TEXT PRIMARY KEY, task_id TEXT, at TEXT NOT NULL, prompts INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX usage_task ON usage (task_id);
      CREATE INDEX usage_at ON usage (at);
      CREATE TABLE jobs (task_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE settings (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE tracker_comments (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX tracker_comments_key ON tracker_comments (key, created_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE audit (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, task_id TEXT, action TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX audit_task ON audit (task_id, seq);
      CREATE INDEX audit_at ON audit (at);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE agent_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, seq INTEGER NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX agent_steps_run ON agent_steps (run_id, seq);
      CREATE INDEX agent_steps_task ON agent_steps (task_id, at);
    `,
  },
];
