import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all customers
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const customers = await prisma.customer.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: { name: 'asc' }
    });
    res.json(customers.map((c) => ({
      ...c,
      disabled: c.status === 'Inactive'
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET customer by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        invoices: true,
        payments: true,
        _count: {
          select: {
            invoices: true,
            payments: true,
          }
        }
      }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
      ...customer,
      disabled: customer.status === 'Inactive'
    });
  } catch (error: any) {
    console.error('Error fetching customer by id:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// GET customer ledger by ID
router.get('/:id/ledger', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const customer = await prisma.customer.findUnique({
      where: { id },
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // 1. Fetch all SALES invoices for this customer (excluding Cancelled & Draft)
    const invoices = await prisma.invoice.findMany({
      where: {
        customerId: id,
        type: 'SALES',
        status: { notIn: ['Cancelled', 'Draft'] },
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

    // 2. Fetch all payments linked to this customer (excluding those linked to cancelled invoices)
    const payments = await prisma.payment.findMany({
      where: {
        customerId: id,
        OR: [
          { invoiceId: null },
          {
            invoice: {
              status: { notIn: ['Cancelled', 'Draft'] }
            }
          }
        ]
      },
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
        (acc: number, p: any) => acc + (p.direction === 'IN' ? Number(p.amount || 0) : -Number(p.amount || 0)),
        0
      );
      const totalPaidSoFar = totalPaidAtInv + totalPaymentsForInv;
      const dueAmount = Math.max(0, invTotal - totalPaidSoFar);
      const invoiceStatus = dueAmount <= 0.001 ? 'PAID' : (totalPaidSoFar > 0 ? 'PARTIAL' : 'CREDIT');

      // 1) Sales Invoice Entry (Debit: Increases customer receivable)
      txs.push({
        id: `inv-${inv.id}`,
        date: inv.date.toISOString(),
        rawDate: new Date(inv.date),
        type: 'INVOICE',
        voucherType: 'Sales Invoice',
        refNo: inv.invoiceNumber,
        invoiceId: inv.id,
        particulars: `Sales Invoice #${inv.invoiceNumber}${inv.items?.length ? ` (${inv.items.length} item${inv.items.length > 1 ? 's' : ''})` : ''}`,
        paymentMethod: inv.paymentType,
        debit: invTotal,
        credit: 0,
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
              voucherType: 'Invoice Payment',
              refNo: `RCP-${inv.invoiceNumber}`,
              invoiceId: inv.id,
              paymentId: p.id,
              particulars: p.description || `Payment received for ${inv.invoiceNumber} via ${p.paymentType}`,
              paymentMethod: p.paymentType,
              debit: p.direction === 'OUT' ? pAmount : 0,
              credit: p.direction === 'IN' ? pAmount : 0,
              status: 'SETTLED',
            });
          }
        }
      } else if (totalPaidAtInv > 0) {
        // Immediate payment at invoice time without separate Payment row
        txs.push({
          id: `inv-pay-${inv.id}`,
          date: inv.date.toISOString(),
          rawDate: new Date(inv.date),
          type: 'PAYMENT',
          voucherType: 'Immediate Receipt',
          refNo: `RCP-${inv.invoiceNumber}`,
          invoiceId: inv.id,
          particulars: `Payment received at invoice via ${inv.paymentType}`,
          paymentMethod: inv.paymentType,
          debit: 0,
          credit: totalPaidAtInv,
          status: 'SETTLED',
        });
      }
    }

    // 3) Standalone payments (not already processed as part of invoices)
    for (const p of payments) {
      if (paymentIdsProcessed.has(p.id)) continue;
      const pAmount = Number(p.amount || 0);
      if (pAmount <= 0) continue;

      const isReceipt = p.direction === 'IN';
      txs.push({
        id: `pay-${p.id}`,
        date: p.date.toISOString(),
        rawDate: new Date(p.date),
        type: 'PAYMENT',
        voucherType: isReceipt ? 'Payment Received' : 'Payment Refund',
        refNo: p.invoice?.invoiceNumber ? `RCP-${p.invoice.invoiceNumber}` : `PAY-${p.id.slice(0, 8).toUpperCase()}`,
        invoiceId: p.invoiceId || undefined,
        paymentId: p.id,
        particulars: p.description || (isReceipt ? 'Payment / Advance received from customer' : 'Refund to customer'),
        paymentMethod: p.paymentType,
        debit: isReceipt ? 0 : pAmount,
        credit: isReceipt ? pAmount : 0,
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

    // Compute running balance
    let runningBalance = 0;
    let totalDebits = 0;
    let totalCredits = 0;
    let totalSales = 0;
    let totalCreditAllowed = 0;

    for (const tx of txs) {
      totalDebits += tx.debit;
      totalCredits += tx.credit;
      if (tx.type === 'INVOICE') {
        totalSales += tx.debit;
        if (tx.details?.creditAmount) {
          totalCreditAllowed += tx.details.creditAmount;
        }
      }

      runningBalance = runningBalance + tx.debit - tx.credit;
      tx.signedBalance = runningBalance;
      tx.runningBalance = Math.abs(runningBalance);
      tx.balanceType = runningBalance > 0.001 ? 'DR' : (runningBalance < -0.001 ? 'CR' : 'SETTLED');
    }

    // Filter by date range if provided
    let filteredTxs = txs;
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate as string) : new Date(0);
      const end = endDate ? new Date(endDate as string) : new Date(8640000000000000);
      end.setHours(23, 59, 59, 999);
      filteredTxs = txs.filter(t => t.rawDate >= start && t.rawDate <= end);
    }

    const netBalance = runningBalance; // Positive = Customer owes us, Negative = Advance from customer
    const outstandingCredit = netBalance > 0.001 ? netBalance : 0;
    const advanceAmount = netBalance < -0.001 ? Math.abs(netBalance) : 0;

    res.json({
      party: {
        id: customer.id,
        name: customer.name,
        contact: customer.contact,
        email: customer.email,
        status: customer.status,
      },
      summary: {
        totalSales,
        totalPaid: totalCredits,
        totalCreditAllowed,
        outstandingBalance: outstandingCredit, // Pending / Due from customer
        advanceAmount: advanceAmount,         // Excess / Advance from customer
        netBalance,
        status: outstandingCredit > 0.001 ? 'PENDING' : (advanceAmount > 0.001 ? 'ADVANCE' : 'SETTLED'),
        invoicesCount: invoices.length,
        paymentsCount: payments.length,
        transactionsCount: txs.length
      },
      transactions: filteredTxs
    });
  } catch (error: any) {
    console.error('Error fetching customer ledger:', error);
    res.status(500).json({ error: 'Failed to fetch customer ledger' });
  }
});

// POST record payment for customer
router.post('/:id/payments', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      amount,
      paymentType,
      date,
      description,
      invoiceId,
      direction = 'IN',
      allocations,
      companyId
    } = req.body;

    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid payment amount is required' });
    }

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Resolve companyId: if not directly provided, find from default company or invoice
    let resolvedCompanyId = companyId || null;
    if (!resolvedCompanyId && invoiceId) {
      const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { companyId: true } });
      if (inv?.companyId) resolvedCompanyId = inv.companyId;
    }
    if (!resolvedCompanyId) {
      const defComp = await prisma.company.findFirst({ where: { isDefault: true }, select: { id: true } });
      if (defComp?.id) resolvedCompanyId = defComp.id;
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
                description: alloc.description || description || `Payment received for ${alloc.refNo || 'invoice'}`,
                customerId: id,
                invoiceId: alloc.invoiceId || null,
                companyId: resolvedCompanyId || null,
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
              description: description ? `${description} (Advance on Account)` : `Advance on Account from customer ${customer.name}`,
              customerId: id,
              invoiceId: null,
              companyId: resolvedCompanyId || null,
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
            description: description || `Payment received from customer ${customer.name}`,
            customerId: id,
            invoiceId: invoiceId || null,
            companyId: resolvedCompanyId || null,
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
    console.error('Error recording customer payment:', error);
    res.status(500).json({ error: error.message || 'Failed to record payment' });
  }
});

// POST new customer
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, contact, email, status, disabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const disabledVal = disabled !== undefined 
      ? Boolean(disabled) 
      : (status !== undefined ? (status === 'Inactive' || status === 'Disabled') : false);
    const statusVal = disabledVal ? 'Inactive' : (status || 'Active');

    const customer = await prisma.customer.create({
      data: { 
        name, 
        contact, 
        email,
        status: statusVal
      }
    });
    res.status(201).json({
      ...customer,
      disabled: customer.status === 'Inactive'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT update customer
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, contact, email, status, disabled } = req.body;
    if (!name && status === undefined && disabled === undefined && contact === undefined && email === undefined) {
      return res.status(400).json({ error: 'Data is required to update' });
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (contact !== undefined) updateData.contact = contact;
    if (email !== undefined) updateData.email = email;

    const disabledVal = disabled !== undefined 
      ? Boolean(disabled) 
      : (status !== undefined ? (status === 'Inactive' || status === 'Disabled') : undefined);

    if (disabledVal !== undefined) {
      updateData.status = disabledVal ? 'Inactive' : 'Active';
    } else if (status) {
      updateData.status = status;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: updateData
    });
    res.json({
      ...customer,
      disabled: customer.status === 'Inactive'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE customer
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.customer.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// POST bulk upload customers
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

        await prisma.customer.create({
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

// POST bulk import customers (JSON)
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
        const name = (row.name || row['Customer Name'] || row.customerName || row['Client Name'] || row.companyName || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const contact = (row.contact || row.phone || row['Phone / Contact'] || '').toString().trim() || null;
        const email = (row.email || row['Email'] || '').toString().trim() || null;

        const existing = await prisma.customer.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existing) {
          await prisma.customer.update({
            where: { id: existing.id },
            data: {
              contact: contact || existing.contact,
              email: email || existing.email,
            }
          });
          updatedCount++;
        } else {
          await prisma.customer.create({
            data: {
              name,
              contact,
              email
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
      message: `Successfully processed ${successCount} customers (${createdCount} created, ${updatedCount} updated).`,
      count: successCount,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to bulk import customers' });
  }
});

export default router;
