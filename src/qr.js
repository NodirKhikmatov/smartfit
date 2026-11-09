// QR codes (SVG, built offline) and the public address they point to.
import qrcode from 'qrcode-generator';

export function qrSvg(url, cellSize = 6) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: cellSize > 6 ? 4 : 2, scalable: true });
}

// PUBLIC_URL when set (QR codes printed for a real domain), else the address this request came to.
export const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
