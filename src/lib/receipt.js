import { formatPrice, round2 } from './format'

const SHOP_NAME = 'Douceurs POS'

// Ouvre une fenêtre d'impression avec un reçu formaté pour une vente.
// `sale` accepte soit les champs de SaleModal (productName, unitPrice…),
// soit ceux d'une ligne `sales` déjà en base (productName dérivé du join products).
export function printReceipt(sale) {
  const win = window.open('', '_blank', 'width=380,height=640')
  if (!win) {
    alert("Impossible d'ouvrir la fenêtre d'impression. Autorise les pop-ups pour ce site puis réessaie.")
    return
  }

  const date = new Date(sale.created_at ?? Date.now())
  const dateStr = date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
  const qty = sale.qty ?? 1
  const unitPrice = sale.unitPrice ?? (qty ? round2(sale.amount / qty) : sale.amount)
  const typeLabel = sale.type === 'cash' ? 'Cash'
      : sale.type === 'dette' ? 'On credit'
      : sale.type === 'paiement' ? 'Payment'
      : 'Store credit'
  const productName = sale.productName ?? sale.product_name ?? 'Item'
  const emoji = sale.emoji ?? ''
  // Vente à prix réduit (produit abîmé/cassé…) : originalAmount présent =
  // vente réduite, quelle que soit la forme (camelCase depuis SaleModal,
  // snake_case depuis une ligne `sales` lue directement en base).
  const originalAmount = sale.originalAmount ?? sale.original_amount ?? null
  const discountReason = sale.discountReason ?? sale.discount_reason ?? null

  const escapeHtml = (v) => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

  win.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Receipt</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: 'Courier New', monospace;
            width: 300px;
            margin: 0 auto;
            padding: 16px;
            color: #111;
          }
          h1 { font-size: 16px; text-align: center; margin: 0 0 4px; }
          .sub { text-align: center; font-size: 11px; color: #555; margin-bottom: 12px; }
          hr { border: none; border-top: 1px dashed #999; margin: 10px 0; }
          .row { display: flex; justify-content: space-between; font-size: 13px; margin: 4px 0; }
          .total { font-size: 15px; font-weight: bold; }
          .footer { text-align: center; font-size: 11px; color: #555; margin-top: 16px; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <h1>${SHOP_NAME}</h1>
        <div class="sub">${escapeHtml(dateStr)}${sale.offline ? ' &middot; recorded offline' : ''}</div>
        <hr />
        <div class="row"><span>${escapeHtml(emoji)} ${escapeHtml(productName)} &times; ${qty}</span><span>${formatPrice(unitPrice)}</span></div>
        ${originalAmount != null && originalAmount > sale.amount ? `<div class="row" style="color:#888;"><span>Discount${discountReason ? ` (${escapeHtml(discountReason)})` : ''}</span><span style="text-decoration:line-through;">${formatPrice(originalAmount)}</span></div>` : ''}
        <hr />
        <div class="row total"><span>Total</span><span>${formatPrice(sale.amount)} GH&#8373;</span></div>
        <div class="row"><span>Payment</span><span>${escapeHtml(typeLabel)}</span></div>
        ${sale.clientName ? `<div class="row"><span>Client</span><span>${escapeHtml(sale.clientName)}</span></div>` : ''}
        ${sale.appliedCredit > 0 ? `<div class="row"><span>Store credit used</span><span>&minus;${formatPrice(sale.appliedCredit)}</span></div>` : ''}
        ${sale.changeDue > 0 ? `<div class="row"><span>Change given</span><span>${formatPrice(sale.changeDue)}</span></div>` : ''}
        ${sale.newCredit > 0 ? `<div class="row"><span>New store credit</span><span>+${formatPrice(sale.newCredit)}</span></div>` : ''}
        <hr />
        <div class="footer">Thank you! &middot; Merci !</div>
      </body>
    </html>
  `)
  win.document.close()
  win.focus()
  setTimeout(() => { try { win.print() } catch { /* ignore */ } }, 200)
}
