// Formate un montant avec 2 décimales pour l'affichage
export const formatPrice = (n) =>
    Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Arrondit à 2 décimales pour les calculs (évite les artefacts flottants JS)
export const round2 = (n) => Math.round(n * 100) / 100