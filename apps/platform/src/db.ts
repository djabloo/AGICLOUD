// Database della piattaforma (SQLite integrato in Node, nessun servizio esterno).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Role = 'admin' | 'user';
export type Status = 'pending' | 'active' | 'suspended';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: Status;
  created_at: number;
  last_login_at: number | null;
}

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      pass_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- Accessi esterni (Google, GitHub): un utente puo' averne piu' di uno
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (provider, subject)
    );
  `);
  return db;
}
