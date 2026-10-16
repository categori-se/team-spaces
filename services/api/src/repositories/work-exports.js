// @ts-nocheck

const columns = Object.freeze([
  ["ID", "id"],
  ["Project", "projectName"],
  ["Subject", "title"],
  ["Type", "type"],
  ["Status", "status"],
  ["Priority", "priority"],
  ["Assignee", "assigneeName"],
  ["Accountable", "accountableId"],
  ["Start", "startDate"],
  ["Due", "dueDate"],
  ["Remaining minutes", "remainingMinutes"],
  ["Progress", "percentComplete"],
  ["Updated", "updatedAt"]
]);

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function xml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function pdfEscape(value) {
  return String(value ?? "").replaceAll(/[^\x20-\x7e]/g, "?").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function simplePdfBase64(title, lines, branding = {}) {
  const organization = String(branding.organizationName ?? "").trim();
  const footer = String(branding.pdfFooter ?? "").trim().slice(0, 160);
  const text = [organization, title, ...lines].filter(Boolean).flatMap((line) => String(line).match(/.{1,105}(?:\s|$)|.{1,105}/g) ?? [""]).slice(0, 54);
  const commands = text.map((line, index) => `BT /F1 ${index === 0 ? 16 : 8} Tf 36 ${760 - index * 13} Td (${pdfEscape(line.trim())}) Tj ET`).join("\n");
  const footerCommand = footer ? `\nBT /F1 7 Tf 36 24 Td (${pdfEscape(footer)}) Tj ET` : "";
  const font = ({helvetica: "Helvetica", times: "Times-Roman", courier: "Courier"})[String(branding.pdfFont ?? "").toLowerCase()] ?? "Helvetica";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
    `<< /Length ${Buffer.byteLength(commands + footerCommand, "ascii")} >>\nstream\n${commands}${footerCommand}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "ascii").toString("base64");
}

export function workItemExport(format, items, {title = "Team Spaces work items", generatedAt = new Date().toISOString(), branding = {}} = {}) {
  const basename = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work-items";
  if (format === "csv") {
    const content = [columns.map(([label]) => csvCell(label)).join(","), ...items.map((item) => columns.map(([, key]) => csvCell(item[key])).join(","))].join("\r\n");
    return {format, filename: `${basename}.csv`, contentType: "text/csv; charset=utf-8", content};
  }
  if (format === "xls") {
    const rows = [columns.map(([label]) => label), ...items.map((item) => columns.map(([, key]) => item[key] ?? ""))];
    const content = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Work items"><Table>${rows.map((row) => `<Row>${row.map((value) => `<Cell><Data ss:Type="String">${xml(value)}</Data></Cell>`).join("")}</Row>`).join("")}</Table></Worksheet></Workbook>`;
    return {format, filename: `${basename}.xls`, contentType: "application/vnd.ms-excel; charset=utf-8", content};
  }
  if (format === "atom") {
    const content = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:team-spaces:work-items</id><title>${xml(title)}</title><updated>${xml(generatedAt)}</updated>${items.map((item) => `<entry><id>urn:team-spaces:work-item:${xml(item.id)}</id><title>${xml(item.title)}</title><updated>${xml(item.updatedAt ?? generatedAt)}</updated><summary>${xml(`${item.type ?? "task"} · ${item.status ?? "new"} · ${item.projectName ?? item.projectId ?? ""}`)}</summary><link href="/app/project?id=${encodeURIComponent(item.projectId)}#${encodeURIComponent(item.id)}" /></entry>`).join("")}</feed>`;
    return {format, filename: `${basename}.atom`, contentType: "application/atom+xml; charset=utf-8", content};
  }
  if (format === "pdf") {
    const lines = items.map((item) => `${item.projectName ?? item.projectId ?? ""} | ${item.title} | ${item.type ?? "task"} | ${item.status ?? "new"} | ${item.assigneeName ?? item.assigneeId ?? "Unassigned"} | ${item.dueDate ?? "No due date"}`);
    return {format, filename: `${basename}.pdf`, contentType: "application/pdf", base64: simplePdfBase64(title, [`Generated ${generatedAt}`, ...lines], branding)};
  }
  throw new Error("Unsupported work item export format");
}

export function ganttPdfExport(items, {title = "Team Spaces Gantt", generatedAt = new Date().toISOString(), branding = {}} = {}) {
  const scheduled = [...items].sort((left, right) => String(left.startDate ?? left.dueDate ?? "9999-12-31").localeCompare(String(right.startDate ?? right.dueDate ?? "9999-12-31")) || String(left.title).localeCompare(String(right.title)));
  const lines = scheduled.map((item) => {
    const start = item.startDate ?? item.dueDate ?? "Unscheduled";
    const due = item.dueDate ?? item.startDate ?? "Unscheduled";
    const milestone = item.type === "milestone" || item.milestoneName ? " [milestone]" : "";
    const dependency = item.blockedBy?.length ? ` depends on ${item.blockedBy.join(", ")}` : "";
    return `${start} -> ${due} | ${String(Number(item.percentComplete ?? 0)).padStart(3, " ")}% | ${item.title}${milestone}${dependency}`;
  });
  const basename = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "gantt";
  return {
    format: "pdf",
    view: "gantt",
    filename: `${basename}.pdf`,
    contentType: "application/pdf",
    base64: simplePdfBase64(title, [`Generated ${generatedAt}`, "Start -> due | progress | work item", ...lines], branding)
  };
}
