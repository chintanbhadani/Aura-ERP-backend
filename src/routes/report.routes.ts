import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';

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
          initialOpeningCash: 0,
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
    } else if (type === 'EXPENSE') {
      const cleanDesc = description?.trim() || 'Store Operating Expense';
      createdPayment = await prisma.expense.create({
        data: {
          date: txDate,
          description: cleanDesc,
          amount: numAmount,
          paymentType: (paymentType as any) || 'CASH'
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
    const { companyId } = req.query;
    let config = await prisma.cashBookConfig.findFirst({ where: { key: 'DEFAULT' } });
    const initialCash = config ? Number(config.initialOpeningCash) : 0;
    const initialBank = config ? Number(config.initialOpeningBank) : 0;
    const initialAirtel = config ? Number(config.initialOpeningAirtel) : 0;

    const invoiceWhere: any = {
      status: { notIn: ['Cancelled', 'Draft'] }
    };
    if (companyId && companyId !== 'ALL') {
      invoiceWhere.companyId = String(companyId);
    }

    const expenseWhere: any = {};
    if (companyId && companyId !== 'ALL') {
      expenseWhere.companyId = String(companyId);
    }

    const paymentWhere: any = {
      OR: [
        { invoiceId: null },
        {
          invoice: {
            status: { notIn: ['Cancelled', 'Draft'] }
          }
        }
      ]
    };
    if (companyId && companyId !== 'ALL') {
      paymentWhere.AND = [
        {
          OR: [
            { invoice: { companyId: String(companyId) } },
            { companyId: String(companyId) },
            { companyId: null, invoiceId: null }
          ]
        }
      ];
    }

    // 2. Fetch all transactions chronologically (excluding Cancelled & Draft invoices)
    const [invoices, expenses, payments] = await Promise.all([
      prisma.invoice.findMany({
        where: invoiceWhere,
        orderBy: { date: 'asc' },
        include: {
          customer: { select: { id: true, name: true, contact: true } },
          supplier: { select: { id: true, name: true, contact: true } },
          company: { select: { id: true, name: true, code: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, sku: true } }
            }
          }
        }
      }),
      prisma.expense.findMany({
        where: expenseWhere,
        orderBy: { date: 'asc' },
        include: {
          company: { select: { id: true, name: true, code: true } }
        }
      }),
      prisma.payment.findMany({
        where: paymentWhere,
        orderBy: { date: 'asc' },
        include: {
          customer: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          company: { select: { id: true, name: true, code: true } }
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
      let dayMobileMoneyCustomerIn = 0;
      let dayMobileMoneySupplierOut = 0;

      for (const pay of dayPayments) {
        const amt = Number(pay.amount || 0);
        const desc = (pay.description || '').toLowerCase();
        const pType = pay.paymentType;
        const dir = pay.direction;

        const isBankTransfer = desc.includes('bank') || desc.includes('deposit') || desc.includes('withdraw');
        // Customer credit settlement ONLY if customerId exists or explicitly noted as customer/credit collection
        const isCustomerPayment = Boolean(pay.customerId) || desc.includes('customer') || desc.includes('client') || desc.includes('credit sale') || desc.includes('credit collection') || desc.includes('received payment for credit');
        // Supplier payout ONLY if supplierId exists or explicitly noted as supplier payout
        const isSupplierPayment = Boolean(pay.supplierId) || desc.includes('supplier') || desc.includes('vendor') || desc.includes('payment to supplier') || desc.includes('purchase payout');

        if (pType === 'CASH') {
          if (dir === 'IN') {
            if (isBankTransfer) {
              dayCashOutFromBank += amt; // Withdrawn from bank into cash
            } else if (isCustomerPayment) {
              dayReceivedCreditSale += amt; // Cash collected from client for credit sale
            } else {
              // Direct capital / opening balance injection / business cash (does NOT touch customer credit receivables)
              dayCashSales += amt;
            }
          } else if (dir === 'OUT') {
            if (isBankTransfer) {
              dayCashInBank += amt; // Cash deposited into bank
            } else if (isSupplierPayment) {
              dayCashPaymentForPurchase += amt; // Cash paid to supplier
            } else {
              dayCashExpenses += amt; // Cash operating expense
            }
          }
        } else if (pType === 'BANK') {
          if (dir === 'IN') {
            if (isCustomerPayment) {
              dayBankCustomerIn += amt;
            } else {
              dayBankSales += amt;
            }
          } else if (dir === 'OUT') {
            if (isSupplierPayment) {
              dayBankSupplierOut += amt;
            } else {
              dayBankExpenses += amt;
            }
          }
        } else if (pType === 'MOBILE_MONEY') {
          if (dir === 'IN') {
            if (isCustomerPayment) {
              dayMobileMoneyCustomerIn += amt;
            } else {
              dayMobileMoneySales += amt;
            }
          } else if (dir === 'OUT') {
            if (isSupplierPayment) {
              dayMobileMoneySupplierOut += amt;
            } else {
              dayMobileMoneyExpenses += amt;
            }
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
      runningAirtel += (dayMobileMoneySales + dayMobileMoneyCustomerIn) - (dayMobileMoneyPurchases + dayMobileMoneyExpenses + dayMobileMoneySupplierOut);
      runningCreditReceivable += (dayCreditSales - dayReceivedCreditSale - dayBankCustomerIn - dayMobileMoneyCustomerIn);
      runningCreditPayable += (dayCreditPurchases - dayCashPaymentForPurchase - dayBankSupplierOut - dayMobileMoneySupplierOut);

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
        mobileMoneyPaymentForPurchase: dayMobileMoneySupplierOut,
        bankPaymentForPurchase: dayBankSupplierOut,
        mobileMoneyCustomerIn: dayMobileMoneyCustomerIn,
        cashInBank: dayCashInBank,
        cashOutFromBank: dayCashOutFromBank,
        closingBalance: dayClosingCash,
        hasActivity: (dayTotalSales + dayTotalPurchases + dayCashExpenses + dayBankExpenses + dayMobileMoneyExpenses + dayPayments.length) > 0,
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
      mobileMoneyPaymentForPurchase: (acc.mobileMoneyPaymentForPurchase || 0) + (d.mobileMoneyPaymentForPurchase || 0),
      bankPaymentForPurchase: (acc.bankPaymentForPurchase || 0) + (d.bankPaymentForPurchase || 0),
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
      mobileMoneyPaymentForPurchase: 0,
      bankPaymentForPurchase: 0,
      cashInBank: 0,
      cashOutFromBank: 0,
    });

    // Calculate live Inventory / Stock Valuation for Finance Balance Sheet
    const productWhere: any = {};
    if (companyId && companyId !== 'ALL') {
      productWhere.OR = [
        { companyId: String(companyId) },
        { invoiceItems: { some: { invoice: { companyId: String(companyId), status: { notIn: ['Cancelled', 'Draft'] } } } } },
        { stockLedgers: { some: { invoice: { companyId: String(companyId), status: { notIn: ['Cancelled', 'Draft'] } } } } }
      ];
    }

    const allProducts = await prisma.product.findMany({
      where: productWhere,
      select: {
        id: true,
        quantity: true,
        cost_price: true,
        selling_price: true,
      }
    });

    const pIds = allProducts.map(p => p.id);
    let totalStockValuation = 0;
    let totalSalesValuation = 0;
    let totalStockQuantity = 0;

    if (pIds.length > 0) {
      // Latest purchase rates
      const purchaseRates = await prisma.invoiceItem.findMany({
        where: {
          productId: { in: pIds },
          invoice: {
            type: 'PURCHASE',
            status: { notIn: ['Cancelled', 'Draft'] },
            ...(companyId && companyId !== 'ALL' ? { companyId: String(companyId) } : {})
          }
        },
        select: {
          productId: true,
          unitPrice: true,
          invoice: { select: { date: true } }
        },
        orderBy: { invoice: { date: 'desc' } }
      });

      const pRateMap = new Map<string, number>();
      for (const pi of purchaseRates) {
        if (!pRateMap.has(pi.productId)) {
          pRateMap.set(pi.productId, Number(pi.unitPrice) || 0);
        }
      }

      // Live ledger quantities
      const stockLedgerSums: any = await prisma.$queryRaw`
        SELECT 
          sl."productId", 
          SUM(sl."quantityChange") AS "ledgerSum"
        FROM "StockLedger" sl
        WHERE sl."productId" IN (${Prisma.join(pIds)})
        GROUP BY sl."productId"
      `;
      const qtyMap = new Map<string, number>();
      for (const s of stockLedgerSums) {
        qtyMap.set(s.productId, Number(s.ledgerSum) || 0);
      }

      for (const prod of allProducts) {
        const qty = qtyMap.has(prod.id) ? qtyMap.get(prod.id)! : (Number(prod.quantity) || 0);
        const pRate = pRateMap.has(prod.id) ? pRateMap.get(prod.id)! : (Number(prod.cost_price) || 0);
        const sRate = Number(prod.selling_price) || 0;

        if (qty > 0) {
          totalStockQuantity += qty;
          totalStockValuation += qty * pRate;
          totalSalesValuation += qty * sRate;
        }
      }
    }

    res.json({
      summary: {
        currentStoreCash: runningStoreCash,
        currentBankBalance: runningBank,
        currentAirtelBalance: runningAirtel,
        totalCreditReceivable: Math.max(0, runningCreditReceivable),
        totalCreditPayable: Math.max(0, runningCreditPayable),
        stockValuation: totalStockValuation,
        salesValuation: totalSalesValuation,
        totalStockQuantity,
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
    const { startDate, endDate, search, customerId, supplierId, productId, companyId } = req.query;

    const purchaseWhere: any = {
      type: 'PURCHASE',
      status: { notIn: ['Cancelled', 'Draft'] }
    };
    if (companyId && companyId !== 'ALL') {
      purchaseWhere.companyId = String(companyId);
    }

    // 1. Fetch all purchase invoices to map PO -> Supplier (excluding Cancelled & Draft)
    const purchaseInvoices = await prisma.invoice.findMany({
      where: purchaseWhere,
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

    // 2. Fetch sales invoices (excluding Cancelled & Draft)
    const whereClause: any = {
      type: 'SALES',
      status: { notIn: ['Cancelled', 'Draft'] }
    };

    if (companyId && companyId !== 'ALL') {
      whereClause.companyId = String(companyId);
    }

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
        company: true,
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
          companyId: inv.companyId || null,
          companyName: (inv as any).company?.name || 'All Companies',
          companyCode: (inv as any).company?.code || '',
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

// GET party ledger summary report (all customers and suppliers)
router.get('/party-ledger', async (req: Request, res: Response) => {
  try {
    const { type, search, companyId } = req.query; // type: 'ALL' | 'CUSTOMER' | 'SUPPLIER'

    const customerInvoiceWhere: any = {
      type: 'SALES',
      status: { notIn: ['Cancelled', 'Draft'] }
    };
    if (companyId && companyId !== 'ALL') {
      customerInvoiceWhere.companyId = String(companyId);
    }

    const customerPaymentWhere: any = {
      OR: [
        { invoiceId: null },
        {
          invoice: {
            status: { notIn: ['Cancelled', 'Draft'] }
          }
        }
      ]
    };
    if (companyId && companyId !== 'ALL') {
      customerPaymentWhere.AND = [
        {
          OR: [
            { invoice: { companyId: String(companyId) } },
            { companyId: String(companyId) }
          ]
        }
      ];
    }

    // Fetch customers
    const customers = await prisma.customer.findMany({
      where: search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
      include: {
        invoices: {
          where: customerInvoiceWhere,
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            cashAmount: true,
            bankAmount: true,
            creditAmount: true,
            mobileMoneyAmount: true,
            date: true,
          }
        },
        payments: {
          where: customerPaymentWhere,
          select: {
            id: true,
            amount: true,
            direction: true,
            date: true,
            invoiceId: true,
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const supplierInvoiceWhere: any = {
      type: 'PURCHASE',
      status: { notIn: ['Cancelled', 'Draft'] }
    };
    if (companyId && companyId !== 'ALL') {
      supplierInvoiceWhere.companyId = String(companyId);
    }

    const supplierPaymentWhere: any = {
      OR: [
        { invoiceId: null },
        {
          invoice: {
            status: { notIn: ['Cancelled', 'Draft'] }
          }
        }
      ]
    };
    if (companyId && companyId !== 'ALL') {
      supplierPaymentWhere.AND = [
        {
          OR: [
            { invoice: { companyId: String(companyId) } },
            { companyId: String(companyId) }
          ]
        }
      ];
    }

    // Fetch suppliers
    const suppliers = await prisma.supplier.findMany({
      where: search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
      include: {
        invoices: {
          where: supplierInvoiceWhere,
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            cashAmount: true,
            bankAmount: true,
            creditAmount: true,
            mobileMoneyAmount: true,
            date: true,
          }
        },
        payments: {
          where: supplierPaymentWhere,
          select: {
            id: true,
            amount: true,
            direction: true,
            date: true,
            invoiceId: true,
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const rows: any[] = [];
    let rowIdx = 1;

    // Process customers if requested
    if (!type || type === 'ALL' || type === 'CUSTOMER') {
      for (const cust of customers) {
        let totalSales = 0;
        let totalCashPaidOnInvoices = 0;
        let totalCredit = 0;
        let lastDate: Date | null = null;

        const processedPayIds = new Set<string>();

        for (const inv of cust.invoices) {
          const invTotal = Number(inv.totalAmount || 0);
          const cAmt = Number(inv.cashAmount || 0);
          const bAmt = Number(inv.bankAmount || 0);
          const mmAmt = Number(inv.mobileMoneyAmount || 0);
          const paidAtInv = cAmt + bAmt + mmAmt;

          totalSales += invTotal;
          totalCashPaidOnInvoices += paidAtInv;
          totalCredit += Number(inv.creditAmount || (invTotal - paidAtInv));

          const invD = new Date(inv.date);
          if (!lastDate || invD > lastDate) lastDate = invD;
        }

        let totalStandalonePayments = 0;
        for (const p of cust.payments) {
          if (p.invoiceId) continue; // Avoid double count
          const amt = Number(p.amount || 0);
          if (p.direction === 'IN') {
            totalStandalonePayments += amt;
          } else {
            totalStandalonePayments -= amt;
          }
          const pD = new Date(p.date);
          if (!lastDate || pD > lastDate) lastDate = pD;
        }

        const totalCashReceived = totalCashPaidOnInvoices + totalStandalonePayments;
        const pending = totalSales - totalCashReceived; // Positive = Customer owes us, Negative = Advance from customer
        const creditDue = pending > 0.001 ? pending : 0;
        const advanceAmt = pending < -0.001 ? Math.abs(pending) : 0;

        rows.push({
          no: rowIdx++,
          partyId: cust.id,
          partyName: cust.name,
          partyType: 'CUSTOMER',
          contact: cust.contact,
          email: cust.email,
          creditPurchase: 0,
          paymentForPurchase: 0,
          sale: totalSales,
          credit: totalCredit,
          cash: totalCashReceived,
          pending: pending,
          creditDue: creditDue,
          advance: advanceAmt,
          closingMonthEnd: 0,
          date: lastDate ? toDateStr(lastDate) : '-',
          invoicesCount: cust.invoices.length,
          paymentsCount: cust.payments.length
        });
      }
    }

    // Process suppliers if requested
    if (!type || type === 'ALL' || type === 'SUPPLIER') {
      for (const supp of suppliers) {
        let totalPurchases = 0;
        let totalCashPaidOnInvoices = 0;
        let totalCredit = 0;
        let lastDate: Date | null = null;

        for (const inv of supp.invoices) {
          const invTotal = Number(inv.totalAmount || 0);
          const cAmt = Number(inv.cashAmount || 0);
          const bAmt = Number(inv.bankAmount || 0);
          const mmAmt = Number(inv.mobileMoneyAmount || 0);
          const paidAtInv = cAmt + bAmt + mmAmt;

          totalPurchases += invTotal;
          totalCashPaidOnInvoices += paidAtInv;
          totalCredit += Number(inv.creditAmount || (invTotal - paidAtInv));

          const invD = new Date(inv.date);
          if (!lastDate || invD > lastDate) lastDate = invD;
        }

        let totalStandalonePayments = 0;
        for (const p of supp.payments) {
          if (p.invoiceId) continue;
          const amt = Number(p.amount || 0);
          if (p.direction === 'OUT') {
            totalStandalonePayments += amt;
          } else {
            totalStandalonePayments -= amt;
          }
          const pD = new Date(p.date);
          if (!lastDate || pD > lastDate) lastDate = pD;
        }

        const totalPaidToSupplier = totalCashPaidOnInvoices + totalStandalonePayments;
        const pending = totalPurchases - totalPaidToSupplier; // Positive = We owe supplier, Negative = Advance paid
        const creditPayable = pending > 0.001 ? pending : 0;
        const advanceAmt = pending < -0.001 ? Math.abs(pending) : 0;

        rows.push({
          no: rowIdx++,
          partyId: supp.id,
          partyName: supp.name,
          partyType: 'SUPPLIER',
          contact: supp.contact,
          email: supp.email,
          creditPurchase: totalPurchases,
          paymentForPurchase: totalPaidToSupplier,
          sale: 0,
          credit: totalCredit,
          cash: totalPaidToSupplier,
          pending: pending,
          creditDue: creditPayable,
          advance: advanceAmt,
          closingMonthEnd: 0,
          date: lastDate ? toDateStr(lastDate) : '-',
          invoicesCount: supp.invoices.length,
          paymentsCount: supp.payments.length
        });
      }
    }

    // Grand totals
    const grandSummary = rows.reduce((acc, r) => {
      acc.totalCreditPurchase += r.creditPurchase;
      acc.totalPaymentForPurchase += r.paymentForPurchase;
      acc.totalSale += r.sale;
      acc.totalCredit += r.credit;
      acc.totalCash += r.cash;
      acc.netPending += r.pending;
      acc.totalCreditDue += r.creditDue;
      acc.totalAdvance += r.advance;
      return acc;
    }, {
      totalCreditPurchase: 0,
      totalPaymentForPurchase: 0,
      totalSale: 0,
      totalCredit: 0,
      totalCash: 0,
      netPending: 0,
      totalCreditDue: 0,
      totalAdvance: 0,
    });

    res.json({
      rows,
      summary: grandSummary
    });
  } catch (error: any) {
    console.error('Error generating party ledger report:', error);
    res.status(500).json({ error: error.message || 'Failed to generate party ledger report' });
  }
});

export default router;
