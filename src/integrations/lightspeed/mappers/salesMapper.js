/**
 * Lightspeed → Internes Format: Sales Mapper
 *
 * Isoliert alle Transformationen. Wenn Lightspeed das API-Format ändert,
 * wird nur dieser Mapper angepasst — der Rest der App bleibt unberührt.
 */

/**
 * @param {Object} raw - Lightspeed API response sale object
 * @returns {import('../types/index.js').LightspeedSale}
 */
export function mapSale(raw) {
  return {
    id:            raw.id,
    locationId:    raw.location_id,
    registerId:    raw.register_id,
    employeeId:    raw.employee_id   || null,
    completedAt:   raw.completed_at,
    totalNet:      toCents(raw.total_price),
    totalGross:    toCents(raw.total_price_incl),
    totalTax:      toCents(raw.total_tax),
    totalTip:      toCents(raw.tip_amount || 0),
    paymentMethod: mapPaymentMethod(raw.payment_type_id),
    status:        mapSaleStatus(raw.status),
    lineItems:     (raw.sale_lines?.data || []).map(mapLineItem),
  }
}

export function mapLineItem(raw) {
  return {
    id:           raw.id,
    productId:    raw.product_id,
    productName:  raw.product?.name || raw.note || 'Unbekannt',
    categoryId:   raw.product?.category_id || null,
    quantity:     parseFloat(raw.qty || 1),
    unitPriceNet: toCents(raw.unit_price),
    totalNet:     toCents(raw.price),
    totalTax:     toCents(raw.tax || 0),
  }
}

/**
 * Aggregiert Rohdaten zu Dashboard-Metriken
 */
export function mapDashboardMetrics(salesData, hourlyData, date) {
  const sales = (salesData.data || []).map(mapSale)

  const totalNet  = sales.reduce((s, x) => s + x.totalNet, 0)
  const peakHour  = (hourlyData.data || []).reduce(
    (max, h) => h.revenue > (max.revenue || 0) ? h : max, {}
  )

  return {
    revenueToday:    totalNet,
    revenueYesterday: 0,  // Separater Call nötig
    revenueWeek:     0,
    revenueMonth:    0,
    transactionsToday:   sales.length,
    averageOrderValue:   sales.length ? Math.round(totalNet / sales.length) : 0,
    peakHour:            peakHour.hour ?? null,
    hourlyRevenue:       (hourlyData.data || []).map(h => ({
      hour:         parseInt(h.hour, 10),
      revenue:      toCents(h.net_sales || 0),
      transactions: parseInt(h.count || 0, 10),
    })),
    revenueByEmployee: aggregateByEmployee(sales),
  }
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function toCents(value) {
  return Math.round(parseFloat(value || 0) * 100)
}

function mapPaymentMethod(typeId) {
  const map = { 1:'cash', 2:'card', 3:'voucher' }
  return map[typeId] || 'mixed'
}

function mapSaleStatus(status) {
  const map = { 1:'completed', 2:'voided', 3:'refunded' }
  return map[status] || 'completed'
}

function aggregateByEmployee(sales) {
  const byEmp = {}
  for (const sale of sales) {
    if (!sale.employeeId) continue
    if (!byEmp[sale.employeeId]) byEmp[sale.employeeId] = { employeeId: sale.employeeId, name: '', revenue: 0, transactions: 0 }
    byEmp[sale.employeeId].revenue      += sale.totalNet
    byEmp[sale.employeeId].transactions += 1
  }
  return Object.values(byEmp)
}
