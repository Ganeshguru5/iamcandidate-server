/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas and line
 * breaks inside quotes, CRLF or LF line endings and a leading BOM.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Rows as objects keyed by lowercase header, starting at the first row that
 * contains every `required` column. LinkedIn exports put notes above the header.
 */
export function csvRecords(
  text: string,
  required: string[],
): { headers: string[]; records: Array<Record<string, string>> } | undefined {
  const rows = parseCsv(text)
  const index = rows.findIndex((row) => {
    const cells = row.map((cell) => cell.trim().toLowerCase())
    return required.every((name) => cells.includes(name))
  })
  if (index < 0) return undefined
  const headers = (rows[index] ?? []).map((cell) => cell.trim().toLowerCase())
  const records = rows
    .slice(index + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => Object.fromEntries(headers.map((name, i) => [name, (row[i] ?? "").trim()])))
  return { headers, records }
}
