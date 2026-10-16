// @ts-nocheck

function calendarEscape(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll(/\r?\n/g, "\\n");
}

function calendarTimestamp(value) {
  return new Date(value).toISOString().replaceAll(/[-:]/g, "").replace(".000", "");
}

export function meetingICalendar(meeting) {
  const recurrence = meeting.recurrence;
  const rule = recurrence ? [
    `FREQ=${String(recurrence.frequency).toUpperCase()}`,
    `INTERVAL=${recurrence.interval ?? 1}`,
    recurrence.until ? `UNTIL=${String(recurrence.until).replaceAll("-", "")}T235959Z` : "",
    recurrence.occurrences ? `COUNT=${recurrence.occurrences}` : "",
    recurrence.weekdays?.length ? `BYDAY=${recurrence.weekdays.map((day) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][day]).join(",")}` : ""
  ].filter(Boolean).join(";") : "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Team Spaces//Meetings//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${calendarEscape(meeting.id)}@teamspaces`,
    `DTSTAMP:${calendarTimestamp(meeting.updatedAt ?? meeting.createdAt)}`,
    `DTSTART:${calendarTimestamp(meeting.startsAt)}`,
    `DTEND:${calendarTimestamp(meeting.endsAt)}`,
    `SUMMARY:${calendarEscape(meeting.title)}`,
    `DESCRIPTION:${calendarEscape(meeting.description)}`,
    `LOCATION:${calendarEscape(meeting.location)}`,
    rule ? `RRULE:${rule}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].filter((line) => line !== "").join("\r\n");
}

function pdfEscape(value) {
  return String(value ?? "").replaceAll(/[^\x20-\x7e]/g, "?").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function meetingPdfBase64(meeting, branding = {}) {
  const agenda = (meeting.agendaItems ?? []).flatMap((item) => [
    `${item.section ?? "General"}: ${item.title}${item.durationMinutes ? ` (${item.durationMinutes} min)` : ""}`,
    item.notes ? `  ${item.notes}` : "",
    item.outcome ? `  Outcome: ${item.outcome}` : ""
  ]).filter(Boolean);
  const lines = [
    branding.organizationName ?? "",
    meeting.title,
    `${meeting.startsAt} - ${meeting.endsAt}`,
    meeting.location ?? "",
    meeting.description ?? "",
    "Agenda",
    ...agenda,
    "Minutes",
    meeting.minutes ?? "",
    branding.pdfFooter ?? ""
  ].filter(Boolean).flatMap((line) => String(line).match(/.{1,90}(?:\s|$)|.{1,90}/g) ?? [""]).slice(0, 55);
  const commands = lines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 10} Tf 50 ${760 - index * 13} Td (${pdfEscape(line.trim())}) Tj ET`).join("\n");
  const font = ({helvetica: "Helvetica", times: "Times-Roman", courier: "Courier"})[String(branding.pdfFont ?? "").toLowerCase()] ?? "Helvetica";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
    `<< /Length ${Buffer.byteLength(commands, "ascii")} >>\nstream\n${commands}\nendstream`
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
