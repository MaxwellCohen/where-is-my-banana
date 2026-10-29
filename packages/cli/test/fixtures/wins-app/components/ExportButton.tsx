"use client";
import XLSX from "xlsx";

export default function ExportButton() {
  return <button onClick={() => XLSX.writeFile({}, "out.xlsx")}>Export</button>;
}
