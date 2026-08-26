// E6: a copy of the ledger's sqlite file taken with sqlite's online backup
// API, so it is consistent while the host keeps writing. Pure node; the
// host's own connection is untouched (a second, read-only handle drives it).

import { DatabaseSync, backup } from 'node:sqlite'

/** Copy the sqlite database at `source` to `destination` (overwritten); resolves to the number of pages copied. */
export async function backupSqlite(source: string, destination: string): Promise<number> {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    return await backup(db, destination)
  } finally {
    db.close()
  }
}
