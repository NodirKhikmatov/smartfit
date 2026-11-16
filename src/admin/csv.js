// Minimal RFC 4180 parser. Delimiter is ',' or ';' (Excel in ru/uz locales saves with ';'), picked from the header line.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const header = text.slice(0, text.search(/\r|\n|$/));
  const delim = (header.split(';').length > header.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unterminated quote');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Rows → CSV for Excel: UTF-8 BOM, ';' (the list separator of ru/uz Excel), every cell quoted.
// A cell starting with = + - @ tab or CR would run as a formula when opened, so it gets a leading apostrophe.
// A number is never a formula, so a negative one stays a number (task 39: a points correction down).
export function toCsv(rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
