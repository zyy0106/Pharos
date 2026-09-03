import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import { resolve } from "node:path";

const inputDir = process.env.AUTOMCM_WORKBOOK_DIR || resolve(process.cwd(), "attachments");

for (const name of ["result1.xlsx", "result2.xlsx", "result3.xlsx"]) {
  const path = resolve(inputDir, name);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(path));
  const result = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 12000, tableMaxRows: 12, tableMaxCols: 16, tableMaxCellChars: 120 });
  console.log(`--- ${name} ---\n${result.ndjson}`);
}
