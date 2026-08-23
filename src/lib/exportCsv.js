// Génère et télécharge un fichier CSV côté client (aucun serveur requis).
// headers: tableau de libellés de colonnes. rows: tableau de tableaux (mêmes colonnes).
export function downloadCsv(filename, headers, rows) {
  const escape = (value) => {
    const s = String(value ?? '')
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lines = [headers.map(escape).join(',')]
  rows.forEach(row => lines.push(row.map(escape).join(',')))

  // BOM UTF-8 pour qu'Excel affiche correctement les accents
  const csvContent = '﻿' + lines.join('\r\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
