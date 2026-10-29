import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Helper to get dates between start and end
const getDatesInRange = (startDate: Date, endDate: Date) => {
  const dates = [];
  let currentDate = new Date(startDate);
  currentDate.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (currentDate <= end) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }
  return dates;
};

// GET daily cash flow summary
router.get('/daily-cash-flow', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(String(startDate)) : new Date();
    const end = endDate ? new Date(String(endDate)) : new Date();
    
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    const dates = getDatesInRange(start, end);
    const report = [];

    for (const d of dates) {
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);

      // 1. Opening Balance (Sum of amountChange before this date)
      const obResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("amountChange"), 0) AS opening_balance
        FROM "CashLedger"
        WHERE date < ${d}::TIMESTAMP
      `;
      const openingBalance = obResult[0]?.opening_balance ? Number(obResult[0].opening_balance) : 0;

      // 2. Sales Info
      const salesResult: any = await prisma.$queryRaw`
        SELECT 
          COALESCE(SUM("totalAmount"), 0) AS total_sales,
          COALESCE(SUM("creditAmount"), 0) AS credit_sales,
          COALESCE(SUM("cashAmount"), 0) AS cash_sales,
          COALESCE(SUM("bankAmount"), 0) AS bank_sales
        FROM "Invoice"
        WHERE type = 'SALES' AND date >= ${d}::TIMESTAMP AND date < ${nextDay}::TIMESTAMP
      `;
      
      const sales = salesResult[0]?.total_sales ? Number(salesResult[0].total_sales) : 0;
      const creditSales = salesResult[0]?.credit_sales ? Number(salesResult[0].credit_sales) : 0;
      const cashSales = salesResult[0]?.cash_sales ? Number(salesResult[0].cash_sales) : 0;
      const bankSales = salesResult[0]?.bank_sales ? Number(salesResult[0].bank_sales) : 0;

      // 3. Purchases
      const purchasesResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("totalAmount"), 0) AS total_purchases
        FROM "Invoice"
        WHERE type = 'PURCHASE' AND date >= ${d}::TIMESTAMP AND date < ${nextDay}::TIMESTAMP
      `;
      const purchases = purchasesResult[0]?.total_purchases ? Number(purchasesResult[0].total_purchases) : 0;

      // 4. Expenses
      const expensesResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("amount"), 0) AS total_expenses
        FROM "Expense"
        WHERE date >= ${d}::TIMESTAMP AND date < ${nextDay}::TIMESTAMP
      `;
      const expenses = expensesResult[0]?.total_expenses ? Number(expensesResult[0].total_expenses) : 0;

      // 5. Payments (IN/OUT)
      const paymentsInResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("amount"), 0) AS total_in
        FROM "Payment"
        WHERE direction = 'IN' AND date >= ${d}::TIMESTAMP AND date < ${nextDay}::TIMESTAMP
      `;
      const paymentsIn = paymentsInResult[0]?.total_in ? Number(paymentsInResult[0].total_in) : 0;

      const paymentsOutResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("amount"), 0) AS total_out
        FROM "Payment"
        WHERE direction = 'OUT' AND date >= ${d}::TIMESTAMP AND date < ${nextDay}::TIMESTAMP
      `;
      const paymentsOut = paymentsOutResult[0]?.total_out ? Number(paymentsOutResult[0].total_out) : 0;

      // 6. Closing Balance
      const cbResult: any = await prisma.$queryRaw`
        SELECT COALESCE(SUM("amountChange"), 0) AS closing_balance
        FROM "CashLedger"
        WHERE date < ${nextDay}::TIMESTAMP
      `;
      const closingBalance = cbResult[0]?.closing_balance ? Number(cbResult[0].closing_balance) : 0;

      report.push({
        date: d,
        openingBalance,
        sales,
        creditSales,
        cashSales,
        bankSales,
        purchases,
        expenses,
        paymentsIn,
        paymentsOut,
        closingBalance
      });
    }

    res.json(report);
  } catch (error) {
    console.error('Error generating daily cash flow report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// GET Sales Report with Purchase Price, Sales Price, Date-wise Client & Supplier details
router.get('/sales-summary', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, search, customerId, supplierId, productId } = req.query;

    // 1. Fetch all purchase invoices to map PO -> Supplier
    const purchaseInvoices = await prisma.invoice.findMany({
      where: { type: 'PURCHASE' },
      include: {
        supplier: true,
        items: true,
      },
    });

    const poSupplierMap = new Map<string, { name: string; id: string }>();
    const poItemSupplierMap = new Map<string, { name: string; id: string; poNumber: string; unitCost: number }>();

    for (const pi of purchaseInvoices) {
      const supName = pi.supplier?.name || 'Direct Supplier';
      const supId = pi.supplier?.id || '';
      poSupplierMap.set(pi.invoiceNumber, { name: supName, id: supId });

      for (const pItem of pi.items) {
        poItemSupplierMap.set(pItem.id, {
          name: supName,
          id: supId,
          poNumber: pi.invoiceNumber,
          unitCost: Number(pItem.unitPrice),
        });
      }
    }

    // 2. Fetch sales invoices
    const whereClause: any = {
      type: 'SALES',
    };

    if (customerId) {
      whereClause.customerId = String(customerId);
    }

    if (startDate || endDate) {
      whereClause.date = {};
      if (startDate) {
        const s = new Date(String(startDate));
        s.setHours(0, 0, 0, 0);
        whereClause.date.gte = s;
      }
      if (endDate) {
        const e = new Date(String(endDate));
        e.setHours(23, 59, 59, 999);
        whereClause.date.lte = e;
      }
    }

    const salesInvoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        customer: true,
        items: {
          include: {
            product: {
              include: {
                unit: true,
                category: true,
              },
            },
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    // 3. Transform into Sales Report rows
    const rows: any[] = [];

    for (const inv of salesInvoices) {
      const clientName = inv.customer?.name || 'Walk-in Customer';
      const clientContact = inv.customer?.contact || '';

      for (const it of inv.items) {
        if (productId && it.productId !== productId) {
          continue;
        }

        const qty = Number(it.quantity) || 0;
        const salesPrice = Number(it.unitPrice) || 0;
        const totalSales = qty * salesPrice;

        // Process PO allocations and supplier names
        const rawAllocations: any[] = Array.isArray(it.poAllocations) ? (it.poAllocations as any[]) : [];
        const enrichedBatches: any[] = [];
        const supplierNamesSet = new Set<string>();

        let totalCost = 0;

        if (rawAllocations.length > 0) {
          for (const alloc of rawAllocations) {
            const batchQty = Number(alloc.quantity) || 0;
            const batchCost = Number(alloc.unitCost) || 0;
            const supInfo = (alloc.purchaseItemId ? poItemSupplierMap.get(alloc.purchaseItemId) : null) ||
              poSupplierMap.get(alloc.poNumber) || { name: 'Direct Purchase', id: '' };

            supplierNamesSet.add(supInfo.name);
            totalCost += batchQty * batchCost;

            enrichedBatches.push({
              poNumber: alloc.poNumber,
              supplierName: supInfo.name,
              supplierId: supInfo.id,
              quantity: batchQty,
              unitCost: batchCost,
              totalCost: batchQty * batchCost,
              totalRevenue: batchQty * salesPrice,
              profit: (batchQty * salesPrice) - (batchQty * batchCost),
            });
          }
        } else {
          // Single PO or fallback cost price
          const unitCost = Number(it.costPrice) || Number(it.product.cost_price) || 0;
          totalCost = qty * unitCost;

          let supName = 'Direct Purchase';
          if (it.purchaseInvoiceNo && poSupplierMap.has(it.purchaseInvoiceNo)) {
            supName = poSupplierMap.get(it.purchaseInvoiceNo)!.name;
          }
          supplierNamesSet.add(supName);

          enrichedBatches.push({
            poNumber: it.purchaseInvoiceNo || 'Direct',
            supplierName: supName,
            quantity: qty,
            unitCost,
            totalCost,
            totalRevenue: totalSales,
            profit: totalSales - totalCost,
          });
        }

        const avgPurchasePrice = qty > 0 ? (totalCost / qty) : (Number(it.costPrice) || 0);
        const grossProfit = totalSales - totalCost;
        const marginPct = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;
        const supplierDisplay = Array.from(supplierNamesSet).join(', ') || 'Direct Purchase';

        // Filter by supplierId if provided
        if (supplierId) {
          const hasMatchingSupplier = enrichedBatches.some((b) => b.supplierId === supplierId);
          if (!hasMatchingSupplier) continue;
        }

        // Search filtering (Client, Item, Supplier, Invoice Number)
        if (search) {
          const q = String(search).trim().toLowerCase();
          const match =
            inv.invoiceNumber.toLowerCase().includes(q) ||
            clientName.toLowerCase().includes(q) ||
            it.product.name.toLowerCase().includes(q) ||
            it.product.sku.toLowerCase().includes(q) ||
            supplierDisplay.toLowerCase().includes(q) ||
            (it.purchaseInvoiceNo || '').toLowerCase().includes(q);
          if (!match) continue;
        }

        rows.push({
          id: `${inv.id}-${it.id}`,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          date: inv.date.toISOString(),
          paymentType: inv.paymentType,
          clientName,
          clientContact,
          customerId: inv.customerId,
          productId: it.productId,
          itemCode: it.product.sku,
          itemName: it.product.name,
          categoryName: it.product.category?.name || 'General',
          uom: it.product.unit?.name || 'Pcs',
          quantity: qty,
          purchasePrice: avgPurchasePrice,
          salesPrice,
          totalCost,
          totalSales,
          grossProfit,
          marginPct,
          supplierName: supplierDisplay,
          poReference: it.purchaseInvoiceNo || 'Direct',
          batches: enrichedBatches,
        });
      }
    }

    // Calculate overall summaries
    const summary = rows.reduce(
      (acc, row) => {
        acc.totalUnits += row.quantity;
        acc.totalRevenue += row.totalSales;
        acc.totalCost += row.totalCost;
        acc.totalProfit += row.grossProfit;
        return acc;
      },
      { totalUnits: 0, totalRevenue: 0, totalCost: 0, totalProfit: 0 }
    );

    const overallMargin = summary.totalRevenue > 0
      ? (summary.totalProfit / summary.totalRevenue) * 100
      : 0;

    res.json({
      rows,
      summary: {
        ...summary,
        overallMargin,
        totalInvoices: new Set(rows.map((r) => r.invoiceId)).size,
      },
    });
  } catch (error: any) {
    console.error('Error generating sales summary report:', error);
    res.status(500).json({ error: error.message || 'Failed to generate sales report' });
  }
});

export default router;
