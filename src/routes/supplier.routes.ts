import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all suppliers
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const suppliers = await prisma.supplier.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: { name: 'asc' }
    });
    res.json(suppliers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// GET supplier by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        products: true,
        invoices: true,
        payments: true,
        _count: {
          select: {
            products: true,
            invoices: true,
            payments: true,
          }
        }
      }
    });

    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    res.json(supplier);
  } catch (error: any) {
    console.error('Error fetching supplier by id:', error);
    res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

// GET supplier ledger by ID
router.get('/:id/ledger', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const supplier = await prisma.supplier.findUnique({
      where: { id },
    });

    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    // 1. Fetch all PURCHASE invoices for this supplier
    const invoices = await prisma.invoice.findMany({
      where: {
        supplierId: id,
        type: 'PURCHASE',
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true }
            }
          }
        },
        payments: true,
      },
      orderBy: { date: 'asc' },
    });

    // 2. Fetch all payments linked to this supplier
    const payments = await prisma.payment.findMany({
      where: { supplierId: id },
      include: {
        invoice: {
          select: { id: true, invoiceNumber: true }
        }
      },
      orderBy: { date: 'asc' },
    });

    // 3. Build unified transaction list
    interface LedgerTx {
      id: string;
      date: string;
      rawDate: Date;
      type: 'INVOICE' | 'PAYMENT';
      voucherType: string;
      refNo: string;
      invoiceId?: string;
      paymentId?: string;
      particulars: string;
      paymentMethod: string;
      debit: number;
      credit: number;
      runningBalance?: number;
      signedBalance?: number;
      balanceType?: 'DR' | 'CR' | 'SETTLED';
      status?: string;
      details?: any;
    }

    const txs: LedgerTx[] = [];
    const paymentIdsProcessed = new Set<string>();

    for (const inv of invoices) {
      const invTotal = Number(inv.totalAmount || 0);
      const cashAmt = Number(inv.cashAmount || 0);
      const bankAmt = Number(inv.bankAmount || 0);
      const mmAmt = Number(inv.mobileMoneyAmount || 0);
      const totalPaidAtInv = cashAmt + bankAmt + mmAmt;
      const creditAmt = Number(inv.creditAmount || (invTotal - totalPaidAtInv));

      // Calculate payments recorded for this invoice in Payment table
      const totalPaymentsForInv = (inv.payments || []).reduce(
        (acc: number, p: any) => acc + (p.direction === 'OUT' ? Number(p.amount || 0) : -Number(p.amount || 0)),
        0
      );
      const totalPaidSoFar = totalPaidAtInv + totalPaymentsForInv;
      const dueAmount = Math.max(0, invTotal - totalPaidSoFar);
      const invoiceStatus = dueAmount <= 0.001 ? 'PAID' : (totalPaidSoFar > 0 ? 'PARTIAL' : 'CREDIT');

      // 1) Purchase Invoice Entry (Credit: Increases what we owe the supplier)
      txs.push({
        id: `inv-${inv.id}`,
        date: inv.date.toISOString(),
        rawDate: new Date(inv.date),
        type: 'INVOICE',
        voucherType: 'Purchase Invoice',
        refNo: inv.invoiceNumber,
        invoiceId: inv.id,
        particulars: `Purchase Invoice #${inv.invoiceNumber}${inv.items?.length ? ` (${inv.items.length} item${inv.items.length > 1 ? 's' : ''})` : ''}`,
        paymentMethod: inv.paymentType,
        debit: 0,
        credit: invTotal,
        status: invoiceStatus,
        details: {
          totalAmount: invTotal,
          cashAmount: cashAmt,
          bankAmount: bankAmt,
          creditAmount: creditAmt,
          mobileMoneyAmount: mmAmt,
          dueDate: inv.dueDate,
          notes: inv.notes,
          paymentTerms: inv.paymentTerms,
          itemsCount: inv.items.length,
          paidAmount: totalPaidSoFar,
          dueAmount: dueAmount,
        }
      });

      // 2) If payments were recorded for this invoice in the Payment table:
      if (inv.payments && inv.payments.length > 0) {
        for (const p of inv.payments) {
          paymentIdsProcessed.add(p.id);
          const pAmount = Number(p.amount || 0);
          if (pAmount > 0) {
            txs.push({
              id: `pay-${p.id}`,
              date: p.date.toISOString(),
              rawDate: new Date(p.date),
              type: 'PAYMENT',
              voucherType: 'Bill Payment',
              refNo: `PMT-${inv.invoiceNumber}`,
              invoiceId: inv.id,
              paymentId: p.id,
              particulars: p.description || `Payment made for ${inv.invoiceNumber} via ${p.paymentType}`,
              paymentMethod: p.paymentType,
              debit: p.direction === 'OUT' ? pAmount : 0,
              credit: p.direction === 'IN' ? pAmount : 0,
              status: 'SETTLED',
            });
          }
        }
      } else if (totalPaidAtInv > 0) {
        // Immediate payment at purchase invoice time without separate Payment row
        txs.push({
          id: `inv-pay-${inv.id}`,
          date: inv.date.toISOString(),
          rawDate: new Date(inv.date),
          type: 'PAYMENT',
          voucherType: 'Immediate Payment',
          refNo: `PMT-${inv.invoiceNumber}`,
          invoiceId: inv.id,
          particulars: `Settled at bill creation via ${inv.paymentType}`,
          paymentMethod: inv.paymentType,
          debit: totalPaidAtInv,
          credit: 0,
          status: 'SETTLED',
        });
      }
    }

    // 3) Standalone payments (not already processed as part of invoices)
    for (const p of payments) {
      if (paymentIdsProcessed.has(p.id)) continue;
      const pAmount = Number(p.amount || 0);
      if (pAmount <= 0) continue;

      const isPayment = p.direction === 'OUT';
      txs.push({
        id: `pay-${p.id}`,
        date: p.date.toISOString(),
        rawDate: new Date(p.date),
        type: 'PAYMENT',
        voucherType: isPayment ? 'Payment Made' : 'Supplier Refund',
        refNo: p.invoice?.invoiceNumber ? `PMT-${p.invoice.invoiceNumber}` : `PAY-${p.id.slice(0, 8).toUpperCase()}`,
        invoiceId: p.invoiceId || undefined,
        paymentId: p.id,
        particulars: p.description || (isPayment ? 'Payment / Advance to supplier' : 'Refund received from supplier'),
        paymentMethod: p.paymentType,
        debit: isPayment ? pAmount : 0,
        credit: isPayment ? 0 : pAmount,
        status: 'SETTLED',
      });
    }

    // Sort chronologically (if same timestamp, INVOICE before PAYMENT)
    txs.sort((a, b) => {
      const timeDiff = a.rawDate.getTime() - b.rawDate.getTime();
      if (timeDiff !== 0) return timeDiff;
      if (a.type === 'INVOICE' && b.type === 'PAYMENT') return -1;
      if (a.type === 'PAYMENT' && b.type === 'INVOICE') return 1;
      return 0;
    });

    // Compute running balance for Supplier (Liability: Credit - Debit)
    let runningBalance = 0;
    let totalCredits = 0;
    let totalDebits = 0;
    let totalPurchases = 0;
    let totalCreditAllowed = 0;

    for (const tx of txs) {
      totalCredits += tx.credit; // Invoices increase liability
      totalDebits += tx.debit;   // Payments decrease liability
      if (tx.type === 'INVOICE') {
        totalPurchases += tx.credit;
        if (tx.details?.creditAmount) {
          totalCreditAllowed += tx.details.creditAmount;
        }
      }

      runningBalance = runningBalance + tx.credit - tx.debit;
      tx.signedBalance = runningBalance;
      tx.runningBalance = Math.abs(runningBalance);
      tx.balanceType = runningBalance > 0.001 ? 'CR' : (runningBalance < -0.001 ? 'DR' : 'SETTLED');
    }

    // Filter by date range if provided
    let filteredTxs = txs;
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate as string) : new Date(0);
      const end = endDate ? new Date(endDate as string) : new Date(8640000000000000);
      end.setHours(23, 59, 59, 999);
      filteredTxs = txs.filter(t => t.rawDate >= start && t.rawDate <= end);
    }

    const netBalance = runningBalance; // Positive = We owe supplier (Credit Payable), Negative = Advance paid to supplier
    const outstandingCredit = netBalance > 0.001 ? netBalance : 0;
    const advanceAmount = netBalance < -0.001 ? Math.abs(netBalance) : 0;

    res.json({
      party: {
        id: supplier.id,
        name: supplier.name,
        contact: supplier.contact,
        email: supplier.email,
        status: supplier.status,
      },
      summary: {
        totalPurchases,
        totalPaid: totalDebits,
        totalCreditAllowed,
        outstandingBalance: outstandingCredit, // Pending / Due to supplier
        advanceAmount: advanceAmount,         // Advance paid to supplier
        netBalance,
        status: outstandingCredit > 0.001 ? 'PAYABLE' : (advanceAmount > 0.001 ? 'ADVANCE' : 'SETTLED'),
        invoicesCount: invoices.length,
        paymentsCount: payments.length,
        transactionsCount: txs.length
      },
      transactions: filteredTxs
    });
  } catch (error: any) {
    console.error('Error fetching supplier ledger:', error);
    res.status(500).json({ error: 'Failed to fetch supplier ledger' });
  }
});

// POST record payment to supplier
router.post('/:id/payments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      amount,
      paymentType,
      date,
      description,
      invoiceId,
      direction = 'OUT', // Default paying supplier (OUT)
      allocations
    } = req.body;

    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid payment amount is required' });
    }

    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const pType = paymentType || 'CASH';
    const paymentDate = date ? new Date(date) : new Date();
    const amountChange = direction === 'IN' ? numAmount : -numAmount;

    const result = await prisma.$transaction(async (tx) => {
      const createdPayments: any[] = [];
      let totalAllocated = 0;

      // 1. If multi-invoice allocations are provided
      if (Array.isArray(allocations) && allocations.length > 0) {
        for (const alloc of allocations) {
          const allocAmt = Number(alloc.amount);
          if (allocAmt > 0) {
            totalAllocated += allocAmt;
            const p = await tx.payment.create({
              data: {
                date: paymentDate,
                paymentType: pType as any,
                direction,
                amount: allocAmt,
                description: alloc.description || description || `Payment made for ${alloc.refNo || 'invoice'}`,
                supplierId: id,
                invoiceId: alloc.invoiceId || null,
              }
            });
            createdPayments.push(p);
          }
        }

        // Remaining unallocated advance amount
        const unallocatedAdvance = numAmount - totalAllocated;
        if (unallocatedAdvance > 0.001) {
          const advP = await tx.payment.create({
            data: {
              date: paymentDate,
              paymentType: pType as any,
              direction,
              amount: unallocatedAdvance,
              description: description ? `${description} (Advance on Account)` : `Advance payment to supplier ${supplier.name}`,
              supplierId: id,
              invoiceId: null,
            }
          });
          createdPayments.push(advP);
        }
      } else {
        // Standard single payment / general payment
        const payment = await tx.payment.create({
          data: {
            date: paymentDate,
            paymentType: pType as any,
            direction,
            amount: numAmount,
            description: description || `Payment made to supplier ${supplier.name}`,
            supplierId: id,
            invoiceId: invoiceId || null,
          }
        });
        createdPayments.push(payment);
      }

      // 2. Update Cash Ledger
      const currentBalanceResult: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
        FROM "CashLedger"
        WHERE CAST("paymentType" AS TEXT) = ${pType}
          AND date < ${paymentDate}::TIMESTAMP
      `;
      const balanceBefore = currentBalanceResult[0]?.balance_before ? Number(currentBalanceResult[0].balance_before) : 0;
      const newRunningBalance = balanceBefore + amountChange;

      await tx.cashLedger.create({
        data: {
          date: paymentDate,
          paymentType: pType as any,
          sourceType: 'PAYMENT',
          amountChange: amountChange,
          runningBalance: newRunningBalance,
          paymentId: createdPayments[0]?.id || null,
          invoiceId: invoiceId || null,
        }
      });

      // Update future balances
      await tx.$queryRaw`
        UPDATE "CashLedger"
        SET "runningBalance" = "runningBalance" + ${amountChange}
        WHERE CAST("paymentType" AS TEXT) = ${pType}
          AND date > ${paymentDate}::TIMESTAMP
      `;

      return createdPayments.length === 1 ? createdPayments[0] : { success: true, count: createdPayments.length, payments: createdPayments };
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Error recording supplier payment:', error);
    res.status(500).json({ error: error.message || 'Failed to record payment' });
  }
});

// POST new supplier
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, contact, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const supplier = await prisma.supplier.create({
      data: { name, contact, email }
    });
    res.status(201).json(supplier);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// PUT update supplier
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, contact, email, status } = req.body;
    if (!name && !status) return res.status(400).json({ error: 'Data is required to update' });

    const updateData: any = {};
    if (name) updateData.name = name;
    if (contact !== undefined) updateData.contact = contact;
    if (email !== undefined) updateData.email = email;
    if (status) updateData.status = status;

    const supplier = await prisma.supplier.update({
      where: { id },
      data: updateData
    });
    res.json(supplier);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// DELETE supplier
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.supplier.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

// POST bulk upload suppliers
router.post('/bulk-upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any>(sheet);

    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.name) {
          errors.push(`Row ${i + 2}: Missing name`);
          continue;
        }

        await prisma.supplier.create({
          data: { 
            name: row.name,
            contact: row.contact ? String(row.contact) : null,
            email: row.email ? String(row.email) : null
          }
        });
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    res.json({ message: `Successfully processed ${successCount} rows.`, errors });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process bulk upload' });
  }
});

// POST bulk import suppliers (JSON array)
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    let successCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const name = (row.name || row.supplierName || row['Supplier Name'] || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const contact = (row.contact || row.phone || row['Phone / Contact'] || '').toString().trim() || null;
        const email = (row.email || row['Email'] || '').toString().trim() || null;
        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);
        const status = disabled ? 'Inactive' : 'Active';

        const existing = await prisma.supplier.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existing) {
          await prisma.supplier.update({
            where: { id: existing.id },
            data: {
              contact: contact || existing.contact,
              email: email || existing.email,
              status
            }
          });
          updatedCount++;
        } else {
          await prisma.supplier.create({
            data: {
              name,
              contact,
              email,
              status
            }
          });
          createdCount++;
        }
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    res.json({
      message: `Successfully processed ${successCount} suppliers (${createdCount} created, ${updatedCount} updated).`,
      count: successCount,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    console.error('Failed to bulk import suppliers:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import suppliers' });
  }
});

export default router;
