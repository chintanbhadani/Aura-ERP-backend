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

// Helper to format date YYYY-MM-DD in local time
const toDateStr = (d: Date | string) => {
  const dt = new Date(d);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// GET Cash Book Config (Initial Opening Balances)
router.get('/cash-book/config', async (req: Request, res: Response) => {
  try {
    let config = await prisma.cashBookConfig.findFirst({ where: { key: 'DEFAULT' } });
    if (!config) {
      config = await prisma.cashBookConfig.create({
        data: {
          key: 'DEFAULT',
          initialOpeningCash: 201000,
          initialOpeningBank: 0,
          initialOpeningAirtel: 0,
          notes: 'Standard Initial Opening Balances'
        }
      });
    }
    res.json(config);
  } catch (error: any) {
    console.error('Error fetching cash book config:', error);
    res.status(500).json({ error: 'Failed to fetch cash book configuration' });
  }
});

// POST Update Cash Book Config
router.post('/cash-book/config', async (req: Request, res: Response) => {
  try {
    const { initialOpeningCash, initialOpeningBank, initialOpeningAirtel, notes } = req.body;
    let config = await prisma.cashBookConfig.findFirst({ where: { key: 'DEFAULT' } });

    if (config) {
      config = await prisma.cashBookConfig.update({
        where: { id: config.id },
        data: {
          initialOpeningCash: initialOpeningCash !== undefined ? Number(initialOpeningCash) : config.initialOpeningCash,
          initialOpeningBank: initialOpeningBank !== undefined ? Number(initialOpeningBank) : config.initialOpeningBank,
          initialOpeningAirtel: initialOpeningAirtel !== undefined ? Number(initialOpeningAirtel) : config.initialOpeningAirtel,
          notes: notes !== undefined ? notes : config.notes
        }
      });
    } else {
      config = await prisma.cashBookConfig.create({
        data: {
          key: 'DEFAULT',
          initialOpeningCash: Number(initialOpeningCash || 0),
          initialOpeningBank: Number(initialOpeningBank || 0),
          initialOpeningAirtel: Number(initialOpeningAirtel || 0),
          notes
        }
      });
    }
    res.json(config);
  } catch (error: any) {
    console.error('Error saving cash book config:', error);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// POST Quick Cash Movement Entry (Bank Deposit/Withdrawal, Credit Collection, Supplier Settlement)
router.post('/cash-book/quick-entry', async (req: Request, res: Response) => {
  try {
    const { type, amount, date, description, customerId, supplierId, paymentType } = req.body;
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const txDate = date ? new Date(date) : new Date();

    let createdPayment: any = null;

    if (type === 'BANK_DEPOSIT') {
      // Cash out of store into bank
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: 'CASH',
          direction: 'OUT',
          amount: numAmount,
          description: description || 'Cash Deposit into Bank'
        }
      });
    } else if (type === 'BANK_WITHDRAWAL') {
      // Cash into store from bank
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: 'CASH',
          direction: 'IN',
          amount: numAmount,
          description: description || 'Cash Withdrawal from Bank'
        }
      });
    } else if (type === 'CREDIT_COLLECTION') {
      // Customer payment for credit sale
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: (paymentType as any) || 'CASH',
          direction: 'IN',
          amount: numAmount,
          customerId: customerId || null,
          description: description || 'Received Payment for Credit Sale'
        }
      });
    } else if (type === 'CREDIT_PAYMENT') {
      // Supplier payout for credit purchase
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: (paymentType as any) || 'CASH',
          direction: 'OUT',
          amount: numAmount,
          supplierId: supplierId || null,
          description: description || 'Payment to Supplier for Purchase'
        }
      });
    } else if (type === 'OPENING_BALANCE' || type === 'CAPITAL_INFLOW') {
      // Starting opening balance or capital inflow into store cash
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: (paymentType as any) || 'CASH',
          direction: 'IN',
          amount: numAmount,
          description: description || 'Starting Opening Balance / Capital Inflow'
        }
      });
    } else {
      createdPayment = await prisma.payment.create({
        data: {
          date: txDate,
          paymentType: (paymentType as any) || 'CASH',
          direction: 'IN',
          amount: numAmount,
          description: description || 'Cash Movement Entry'
        }
      });
    }

    res.status(201).json(createdPayment);
  } catch (error: any) {
    console.error('Error creating cash movement entry:', error);
    res.status(500).json({ error: error.message || 'Failed to record entry' });
  }
});

// GET Cash Book & Balance Sheet Report (Auto-generated from Invoices, Expenses & Payments)
router.get('/cash-book', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, search } = req.query;

    // 1. Fetch initial configuration
    let config = await prisma.cashBookConfig.findFirst({ where: { key: 'DEFAULT' } });
    const initialCash = config ? Number(config.initialOpeningCash) : 0;
    const initialBank = config ? Number(config.initialOpeningBank) : 0;
    const initialAirtel = config ? Number(config.initialOpeningAirtel) : 0;

    // 2. Fetch all transactions chronologically
    const [invoices, expenses, payments] = await Promise.all([
      prisma.invoice.findMany({
        orderBy: { date: 'asc' },
        include: {
          customer: { select: { id: true, name: true, contact: true } },
          supplier: { select: { id: true, name: true, contact: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, sku: true } }
            }
          }
        }
      }),
      prisma.expense.findMany({
        orderBy: { date: 'asc' }
      }),
      prisma.payment.findMany({
        orderBy: { date: 'asc' },
        include: {
          customer: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } }
        }
      })
    ]);

    // 3. Collect chronological sequence of all active transaction dates
    const dateSet = new Set<string>();
    invoices.forEach(i => dateSet.add(toDateStr(i.date)));
    expenses.forEach(e => dateSet.add(toDateStr(e.date)));
    payments.forEach(p => dateSet.add(toDateStr(p.date)));

    if (dateSet.size === 0) {
      dateSet.add(toDateStr(new Date()));
    }

    // Determine span
    const allDates = Array.from(dateSet).sort();
    const earliestDate = new Date(allDates[0]);
    const latestDate = new Date(allDates[allDates.length - 1]);
    const today = new Date();
    const finalDate = latestDate > today ? latestDate : today;

    // Build contiguous calendar days
    const calendarDays = getDatesInRange(earliestDate, finalDate).map(d => toDateStr(d));

    // 4. Rolling calculations
    let runningStoreCash = initialCash;
    let runningBank = initialBank;
    let runningAirtel = initialAirtel;
    let runningCreditReceivable = 0;
    let runningCreditPayable = 0;

    const allCalculatedDays: any[] = [];

    for (const dStr of calendarDays) {
      const dayOpeningCash = runningStoreCash;

      const dayInvoices = invoices.filter(i => toDateStr(i.date) === dStr);
      const dayExpenses = expenses.filter(e => toDateStr(e.date) === dStr);
      const dayPayments = payments.filter(p => toDateStr(p.date) === dStr);

      // --- SALES BREAKDOWN ---
      let dayTotalSales = 0;
      let dayCreditSales = 0;
      let dayBankSales = 0;
      let dayMobileMoneySales = 0;
      let dayCashSales = 0;

      // --- PURCHASES BREAKDOWN ---
      let dayTotalPurchases = 0;
      let dayCashPurchases = 0;
      let dayCreditPurchases = 0;
      let dayBankPurchases = 0;
      let dayMobileMoneyPurchases = 0;

      for (const inv of dayInvoices) {
        const total = Number(inv.totalAmount || 0);
        const cash = Number(inv.cashAmount || 0);
        const bank = Number(inv.bankAmount || 0);
        const credit = Number(inv.creditAmount || 0);
        const mobileMoney = Number((inv as any).mobileMoneyAmount || 0);
        const pType = inv.paymentType;

        if (inv.type === 'SALES') {
          dayTotalSales += total;
          if (pType === 'CASH') {
            dayCashSales += (cash > 0 ? cash : total);
          } else if (pType === 'CREDIT') {
            dayCreditSales += (credit > 0 ? credit : total);
          } else if (pType === 'BANK') {
            dayBankSales += (bank > 0 ? bank : total);
          } else if (pType === 'MOBILE_MONEY') {
            dayMobileMoneySales += (mobileMoney > 0 ? mobileMoney : total);
          } else if (pType === 'PARTIAL') {
            dayCashSales += cash;
            dayBankSales += bank;
            dayCreditSales += credit;
            dayMobileMoneySales += mobileMoney;
          } else {
            dayCashSales += total;
          }
        } else if (inv.type === 'PURCHASE') {
          dayTotalPurchases += total;
          if (pType === 'CASH') {
            dayCashPurchases += (cash > 0 ? cash : total);
          } else if (pType === 'CREDIT') {
            dayCreditPurchases += (credit > 0 ? credit : total);
          } else if (pType === 'BANK') {
            dayBankPurchases += (bank > 0 ? bank : total);
          } else if (pType === 'MOBILE_MONEY') {
            dayMobileMoneyPurchases += (mobileMoney > 0 ? mobileMoney : total);
          } else if (pType === 'PARTIAL') {
            dayCashPurchases += cash;
            dayBankPurchases += bank;
            dayCreditPurchases += credit;
            dayMobileMoneyPurchases += mobileMoney;
          } else {
            dayCashPurchases += total;
          }
        }
      }

      // --- EXPENSES BREAKDOWN ---
      let dayCashExpenses = 0;
      let dayBankExpenses = 0;
      let dayMobileMoneyExpenses = 0;

      for (const exp of dayExpenses) {
        const amt = Number(exp.amount || 0);
        const pType = exp.paymentType;
        if (pType === 'BANK') {
          dayBankExpenses += amt;
        } else if (pType === 'MOBILE_MONEY') {
          dayMobileMoneyExpenses += amt;
        } else {
          dayCashExpenses += amt;
        }
      }

      // --- PAYMENTS & CASH MOVEMENTS BREAKDOWN ---
      let dayReceivedCreditSale = 0;
      let dayCashPaymentForPurchase = 0;
      let dayCashInBank = 0;
      let dayCashOutFromBank = 0;
      let dayBankCustomerIn = 0;
      let dayBankSupplierOut = 0;

      for (const pay of dayPayments) {
        const amt = Number(pay.amount || 0);
        const desc = (pay.description || '').toLowerCase();
        const pType = pay.paymentType;
        const dir = pay.direction;

        const isBankTransfer = desc.includes('bank') || desc.includes('deposit') || desc.includes('withdraw');
        const isOpeningCapital = desc.includes('opening balance') || desc.includes('capital') || desc.includes('starting balance');

        if (pType === 'CASH') {
          if (dir === 'IN') {
            if (isBankTransfer) {
              dayCashOutFromBank += amt; // Withdrawn from bank into cash
            } else if (isOpeningCapital) {
              // Direct capital / opening balance injection into store cash (without distorting credit receivables)
              dayCashSales += amt;
            } else {
              dayReceivedCreditSale += amt; // Cash collected from client
            }
          } else if (dir === 'OUT') {
            if (isBankTransfer) {
              dayCashInBank += amt; // Cash deposited into bank
            } else {
              dayCashPaymentForPurchase += amt; // Cash paid to supplier
            }
          }
        } else if (pType === 'BANK') {
          if (dir === 'IN') {
            dayBankCustomerIn += amt;
          } else if (dir === 'OUT') {
            dayBankSupplierOut += amt;
          }
        }
      }

      // Cash at store calculation
      // Closing = Opening + Cash Sale + Received Credit Sale + Cash Out From Bank - Cash Purchase - Cash Expense - Cash Payment for Purchase - Cash in Bank
      const dayClosingCash = 
        dayOpeningCash + 
        dayCashSales + 
        dayReceivedCreditSale + 
        dayCashOutFromBank - 
        dayCashPurchases - 
        dayCashExpenses - 
        dayCashPaymentForPurchase - 
        dayCashInBank;

      // Update rolling balances
      runningStoreCash = dayClosingCash;
      runningBank += (dayBankSales + dayCashInBank + dayBankCustomerIn) - (dayBankPurchases + dayBankExpenses + dayCashOutFromBank + dayBankSupplierOut);
      runningAirtel += (dayMobileMoneySales - dayMobileMoneyPurchases - dayMobileMoneyExpenses);
      runningCreditReceivable += (dayCreditSales - dayReceivedCreditSale - dayBankCustomerIn);
      runningCreditPayable += (dayCreditPurchases - dayCashPaymentForPurchase - dayBankSupplierOut);

      allCalculatedDays.push({
        date: dStr,
        openingBalance: dayOpeningCash,
        totalSale: dayTotalSales,
        creditSale: dayCreditSales,
        bankSale: dayBankSales,
        mobileMoneySale: dayMobileMoneySales,
        cashSale: dayCashSales,
        receivedCreditSale: dayReceivedCreditSale,
        cashPurchase: dayCashPurchases,
        cashExpense: dayCashExpenses,
        cashPaymentForPurchase: dayCashPaymentForPurchase,
        cashInBank: dayCashInBank,
        cashOutFromBank: dayCashOutFromBank,
        closingBalance: dayClosingCash,
        hasActivity: (dayTotalSales + dayTotalPurchases + dayCashExpenses + dayBankExpenses + dayPayments.length) > 0,
        details: {
          sales: dayInvoices.filter(i => i.type === 'SALES'),
          purchases: dayInvoices.filter(i => i.type === 'PURCHASE'),
          expenses: dayExpenses,
          payments: dayPayments
        }
      });
    }

    // Filter to requested range if query params present
    let resultDays = allCalculatedDays;
    if (startDate) {
      const s = String(startDate).split('T')[0];
      resultDays = resultDays.filter(d => d.date >= s);
    }
    if (endDate) {
      const e = String(endDate).split('T')[0];
      resultDays = resultDays.filter(d => d.date <= e);
    }

    if (search) {
      const q = String(search).toLowerCase();
      resultDays = resultDays.filter(d => d.date.includes(q));
    }

    // Period aggregations
    const periodTotals = resultDays.reduce((acc, d) => ({
      totalSale: acc.totalSale + d.totalSale,
      creditSale: acc.creditSale + d.creditSale,
      bankSale: acc.bankSale + d.bankSale,
      mobileMoneySale: acc.mobileMoneySale + d.mobileMoneySale,
      cashSale: acc.cashSale + d.cashSale,
      receivedCreditSale: acc.receivedCreditSale + d.receivedCreditSale,
      cashPurchase: acc.cashPurchase + d.cashPurchase,
      cashExpense: acc.cashExpense + d.cashExpense,
      cashPaymentForPurchase: acc.cashPaymentForPurchase + d.cashPaymentForPurchase,
      cashInBank: acc.cashInBank + d.cashInBank,
      cashOutFromBank: acc.cashOutFromBank + d.cashOutFromBank,
    }), {
      totalSale: 0,
      creditSale: 0,
      bankSale: 0,
      mobileMoneySale: 0,
      cashSale: 0,
      receivedCreditSale: 0,
      cashPurchase: 0,
      cashExpense: 0,
      cashPaymentForPurchase: 0,
      cashInBank: 0,
      cashOutFromBank: 0,
    });

    res.json({
      summary: {
        currentStoreCash: runningStoreCash,
        currentBankBalance: runningBank,
        currentAirtelBalance: runningAirtel,
        totalCreditReceivable: runningCreditReceivable,
        totalCreditPayable: runningCreditPayable,
        initialCash,
        initialBank,
        initialAirtel,
        periodTotals
      },
      days: resultDays
    });

  } catch (error: any) {
    console.error('Error generating cash book report:', error);
    res.status(500).json({ error: error.message || 'Failed to generate cash book' });
  }
});

// GET Legacy daily-cash-flow summary alias
router.get('/daily-cash-flow', async (req: Request, res: Response) => {
  res.redirect(307, '/api/reports/cash-book');
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
          createdAt: inv.createdAt.toISOString(),
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
