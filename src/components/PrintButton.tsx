"use client";
export function PrintButton() {
  return <button type="button" className="btn-quiet" onClick={() => window.print()}>Print or save as PDF</button>;
}
