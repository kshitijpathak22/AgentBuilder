import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Exports the evaluation report shown on the Evaluation page (in its current language).
// jsPDF's built-in fonts cover Latin scripts only, so a report in another script (e.g. Hindi)
// goes through the browser's print dialog instead, where "Save as PDF" renders any script.

const LATIN_ONLY = /^[\u0000-ɏ -⁯€™\s]*$/;

const ratingFor = (score) => (score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : 'Needs Improvement');

const fileName = (report) => {
  const when = report.date ? new Date(report.date) : new Date();
  return `kcoach-report-${when.toISOString().slice(0, 10)}.pdf`;
};

const sections = (report) => [
  ['Top Strengths', report.strengths],
  ['Areas for Improvement', report.improvements],
  ['Actionable Insights', report.insights],
];

function downloadWithJsPdf(report) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 48;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const pageBottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;

  const ensureSpace = (needed) => {
    if (y + needed > pageBottom) { doc.addPage(); y = margin; }
  };
  const write = (text, { size = 11, bold = false, color = [30, 30, 30], gap = 4 } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(String(text), width);
    const lineHeight = size * 1.35;
    lines.forEach((line) => {
      ensureSpace(lineHeight);
      doc.text(line, margin, y + size);
      y += lineHeight;
    });
    y += gap;
  };

  write('KCoach Evaluation Report', { size: 20, bold: true, gap: 6 });
  if (report.subtitle) write(report.subtitle, { size: 10, color: [100, 100, 100], gap: 14 });
  write(`Overall score: ${report.score}/100 (${ratingFor(report.score)})`, { size: 14, bold: true, gap: 12 });

  if (report.dimensions.length > 0) {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Dimension', 'Score']],
      body: report.dimensions.map((d) => [d.name, `${d.score}/100`]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [79, 70, 229] },
      columnStyles: { 1: { halign: 'right', cellWidth: 80 } },
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  sections(report).forEach(([title, items]) => {
    if (!items.length) return;
    ensureSpace(40);
    write(title, { size: 13, bold: true, gap: 6 });
    items.forEach((item) => write(`•  ${item}`, { size: 11, gap: 6 }));
    y += 8;
  });

  if (report.betterResponses.length > 0) {
    ensureSpace(40);
    write('Sample Better Responses', { size: 13, bold: true, gap: 6 });
    report.betterResponses.forEach((item, idx) => {
      ensureSpace(60);
      write(`Turn ${idx + 1}`, { size: 11, bold: true, color: [79, 70, 229], gap: 2 });
      if (item.question) write(`Question: ${item.question}`, { size: 10, gap: 2 });
      if (item.yours) write(`Your response: ${item.yours}`, { size: 10, gap: 2 });
      if (item.better) write(`Better response: ${item.better}`, { size: 10, bold: true, gap: 2 });
      if (item.reason) write(`Tip: ${item.reason}`, { size: 10, color: [90, 90, 90], gap: 10 });
    });
  }

  doc.save(fileName(report));
}

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function printAsPdf(report) {
  const list = (items) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileName(report).replace('.pdf', ''))}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", sans-serif; color: #1e1e1e; margin: 40px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; }
  .muted { color: #666; font-size: 12px; } .score { font-size: 16px; font-weight: 700; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #4f46e5; color: #fff; } td:last-child, th:last-child { text-align: right; width: 90px; }
  .turn { margin-bottom: 14px; font-size: 13px; } .turn b { color: #4f46e5; }
</style></head><body>
<h1>KCoach Evaluation Report</h1>
${report.subtitle ? `<div class="muted">${escapeHtml(report.subtitle)}</div>` : ''}
<div class="score">Overall score: ${report.score}/100 (${ratingFor(report.score)})</div>
${report.dimensions.length ? `<table><tr><th>Dimension</th><th>Score</th></tr>${report.dimensions.map((d) => `<tr><td>${escapeHtml(d.name)}</td><td>${d.score}/100</td></tr>`).join('')}</table>` : ''}
${sections(report).filter(([, items]) => items.length).map(([title, items]) => `<h2>${title}</h2>${list(items)}`).join('')}
${report.betterResponses.length ? `<h2>Sample Better Responses</h2>${report.betterResponses.map((item, idx) => `<div class="turn"><b>Turn ${idx + 1}</b><br>
${item.question ? `Question: ${escapeHtml(item.question)}<br>` : ''}${item.yours ? `Your response: ${escapeHtml(item.yours)}<br>` : ''}
${item.better ? `<strong>Better response: ${escapeHtml(item.better)}</strong><br>` : ''}${item.reason ? `<span class="muted">Tip: ${escapeHtml(item.reason)}</span>` : ''}</div>`).join('')}` : ''}
</body></html>`;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const frameDoc = frame.contentWindow.document;
  frameDoc.open();
  frameDoc.write(html);
  frameDoc.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }, 250);
}

/**
 * @param {Object} report
 * @param {string} report.subtitle
 * @param {number} report.score
 * @param {string} [report.date]
 * @param {Array<{name: string, score: number}>} report.dimensions
 * @param {string[]} report.strengths
 * @param {string[]} report.improvements
 * @param {string[]} report.insights
 * @param {Array<{question: string, yours: string, better: string, reason: string}>} report.betterResponses
 * @returns {'download'|'print'} how the PDF was produced
 */
export function exportReportPdf(report) {
  const allText = [
    report.subtitle,
    ...report.dimensions.map((d) => d.name),
    ...report.strengths, ...report.improvements, ...report.insights,
    ...report.betterResponses.flatMap((b) => [b.question, b.yours, b.better, b.reason]),
  ].join(' ');
  if (LATIN_ONLY.test(allText)) {
    downloadWithJsPdf(report);
    return 'download';
  }
  printAsPdf(report);
  return 'print';
}
