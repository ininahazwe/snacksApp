// Mouvements de compte client (phase 4) : paiement de dette, dépôt d'avoir,
// utilisation de l'avoir. Tout passe par des fonctions SQL atomiques
// (backup-scripts/phase4_mouvements_compte_client.sql) : le navigateur
// n'écrit plus jamais directement clients.debt / clients.credit ni sales.
// Chaque fonction lit et verrouille le solde EN BASE, enregistre l'acteur
// (sales.user_id) et renvoie les nouveaux soldes.
import { rpc, newRequestId } from './stockApi'

export { newRequestId }

// surplus : 'credit' (le trop-perçu devient de l'avoir) | 'change' (monnaie rendue)
// Retour : { duplicate, client_id, debt, credit, debt_repaid, credit_used,
//            credit_created, change_due, group_id, sale_ids }
export const recordClientPayment = (clientId, amount, surplus, requestId) =>
  rpc('record_client_payment', {
    p_client_id: clientId, p_amount: amount, p_surplus: surplus, p_request_id: requestId,
  })

// Applique min(avoir, dette) du client
export const applyClientCredit = (clientId, requestId) =>
  rpc('apply_client_credit', { p_client_id: clientId, p_request_id: requestId })

// Message lisible pour une erreur de ces fonctions
export function clientMovementError(err) {
  if (err?.isNetwork) return 'You are offline: payments need a connection. Try again once online.'
  if (err?.code === '42501') return 'You are not allowed to record this payment.'
  return err?.message || 'The payment could not be recorded.'
}
