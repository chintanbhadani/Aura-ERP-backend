import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all payments
router.get('/', async (req: Request, res: Response) => {
  try {
    const payments = await prisma.payment.findMany({
      orderBy: { date: 'desc' },
      include: {
        customer: true,
        supplier: true,
        invoice: true,
      },
    });
    res.json(payments);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// POST new payment
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      date,
      paymentType,
      direction,
      amount,
      description,
      customerId,
      supplierId,
      invoiceId,
    } = req.body;

    if (!paymentType || !direction || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'paymentType, direction, and amount are required' });
    }

    const pType = paymentType; // CASH or BANK
    const pAmount = Number(amount);
    const paymentDate = date ? new Date(date) : new Date();
    const amountChange = direction === 'IN' ? pAmount : -pAmount;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create Payment record
      const payment = await tx.payment.create({
        data: {
          date: paymentDate,
          paymentType: pType,
          direction,
          amount: pAmount,
          description: description || null,
          customerId: customerId || null,
          supplierId: supplierId || null,
          invoiceId: invoiceId || null,
        },
      });

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
          paymentType: pType,
          sourceType: 'PAYMENT',
          amountChange: amountChange,
          runningBalance: newRunningBalance,
          paymentId: payment.id,
        }
      });

      // Update future balances if backdated
      await tx.$queryRaw`
          UPDATE "CashLedger"
          SET "runningBalance" = "runningBalance" + ${amountChange}
          WHERE CAST("paymentType" AS TEXT) = ${pType}
            AND date > ${paymentDate}::TIMESTAMP
      `;

      return payment;
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

export default router;
