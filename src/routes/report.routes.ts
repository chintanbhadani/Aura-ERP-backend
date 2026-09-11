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

export default router;
