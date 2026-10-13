import { quoteIdentifier } from "@/lib/db/database";

export function createFlowLogQueries(tableName: string) {
  const table = quoteIdentifier(tableName);

  return {
    prune: `DELETE FROM ${table} WHERE ts < $1`,
    insert(columns: string[], rowCount: number): string {
      const tuples = Array.from({ length: rowCount }, (_, rowIndex) => {
        const offset = rowIndex * columns.length;
        return `(${columns.map((__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
      });
      return `INSERT INTO ${table} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${tuples.join(", ")}`;
    },
  } as const;
}
