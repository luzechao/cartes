/**
 * `ResultsDb` over the app's Pyodide interpreter, where the last run's files are: Python's
 * `sqlite3` opens `last_run/eplusout.sql` read-only and prints the rows as one JSON line, which
 * is picked out of the output by its marker. The helper deletes itself, so the REPL namespace the
 * user sees is left as it was.
 */
import { ResultsError, type Cell, type QueryResult } from './index.js'

const MARK = '@@cartes-sql@@'

export interface PythonRunner {
  (code: string): Promise<{ ok: boolean; error?: string | undefined; stdout: string }>
}

/** The Python that runs one statement. JSON string literals are valid Python string literals. */
export function sqlProgram(sql: string, params: readonly Cell[]): string {
  return `
def _cartes_sql():
    import json, os, sqlite3
    path = os.path.join(last_run, "eplusout.sql") if last_run else ""
    if not path or not os.path.exists(path):
        return {"error": "nosql"}
    con = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    try:
        cur = con.execute(${JSON.stringify(sql)}, json.loads(${JSON.stringify(JSON.stringify(params))}))
        return {"columns": [d[0] for d in (cur.description or [])], "rows": cur.fetchall()}
    except Exception as error:
        return {"error": str(error)}
    finally:
        con.close()
print(${JSON.stringify(MARK)} + __import__("json").dumps(_cartes_sql(), default=str))
del _cartes_sql
`
}

export async function queryOverPython(run: PythonRunner, sql: string, params: readonly Cell[] = []): Promise<QueryResult> {
  const outcome = await run(sqlProgram(sql, params))
  if (!outcome.ok) throw new ResultsError(outcome.error ?? 'Python failed while reading the results.')
  const line = outcome.stdout.split('\n').find((l) => l.startsWith(MARK))
  if (!line) throw new ResultsError('No answer from the results database.')
  const r = JSON.parse(line.slice(MARK.length)) as QueryResult | { error: string }
  if ('error' in r) {
    throw new ResultsError(
      r.error === 'nosql'
        ? 'The last run wrote no eplusout.sql (the model has no Output:SQLite, or nothing has run yet). run_simulation adds SQLite output to its runs.'
        : r.error,
    )
  }
  return r
}
