import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Helper: Ensure PostgreSQL tables exist
let tablesInitialized = false;
async function ensureTables() {
  if (tablesInitialized) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "StockCountSession" (
        "id" TEXT PRIMARY KEY,
        "sessionNumber" TEXT UNIQUE NOT NULL,
        "periodType" TEXT NOT NULL DEFAULT 'WEEKLY',
        "countDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "title" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'Draft',
        "totalItems" INTEGER NOT NULL DEFAULT 0,
        "matchedItems" INTEGER NOT NULL DEFAULT 0,
        "discrepantItems" INTEGER NOT NULL DEFAULT 0,
        "netVarianceQty" INTEGER NOT NULL DEFAULT 0,
        "netVarianceValue" DECIMAL(12, 2) NOT NULL DEFAULT 0,
        "notes" TEXT,
        "reconciledAt" TIMESTAMP(3),
        "reconciledBy" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "StockCountItem" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL REFERENCES "StockCountSession"("id") ON DELETE CASCADE,
        "productId" TEXT NOT NULL,
        "itemCode" TEXT NOT NULL,
        "itemName" TEXT NOT NULL,
        "itemGroup" TEXT,
        "uom" TEXT,
        "location" TEXT,
        "costPrice" DECIMAL(10, 2) NOT NULL DEFAULT 0,
        "systemQty" INTEGER NOT NULL DEFAULT 0,
        "countedQty" INTEGER,
        "varianceQty" INTEGER NOT NULL DEFAULT 0,
        "varianceValue" DECIMAL(12, 2) NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'Pending',
        "reason" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "StockCountItem_sessionId_idx" ON "StockCountItem"("sessionId")
      `);
    } catch (_) {}

    tablesInitialized = true;
  } catch (err) {
    console.error('Error creating StockCount tables:', err);
    throw err;
  }
}

// Helper: calculate Monday of given date's week
function getMonday(dateInput?: string | Date): Date {
  const d = dateInput ? new Date(dateInput) : new Date();
  const day = d.getDay(); // 0 is Sunday, 1 is Monday...
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Helper: Format ISO week number
function getWeekNumber(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

// GET or Create Active Stock Count Session for period (Default: Weekly / Every Monday)
router.get('/session', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { date, periodType = 'WEEKLY' } = req.query;

    const targetMonday = getMonday(date ? String(date) : undefined);
    const endOfWeek = new Date(targetMonday);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    // 1. Look for existing session for this week/Monday
    let session = await prisma.stockCountSession.findFirst({
      where: {
        periodType: String(periodType),
        countDate: {
          gte: targetMonday,
          lt: endOfWeek,
        },
      },
      include: {
        items: {
          orderBy: [
            { itemGroup: 'asc' },
            { itemCode: 'asc' },
          ],
        },
      },
    });

    const products = await prisma.product.findMany({
      where: { status: 'Active' },
      include: { category: true, unit: true },
      orderBy: { sku: 'asc' },
    });

    // 2. If no session exists for this week, create a new one
    if (!session) {
      const year = targetMonday.getFullYear();
      const weekNum = getWeekNumber(targetMonday);
      const sessionNumber = `SC-${year}-W${String(weekNum).padStart(2, '0')}`;
      const title = `Weekly Stock Count - Monday, ${targetMonday.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} (Week ${weekNum})`;

      session = await prisma.stockCountSession.create({
        data: {
          sessionNumber,
          periodType: String(periodType),
          countDate: targetMonday,
          title,
          status: 'Draft',
          totalItems: products.length,
          matchedItems: 0,
          discrepantItems: 0,
          netVarianceQty: 0,
          netVarianceValue: 0,
          items: {
            create: products.map((p) => ({
              productId: p.id,
              itemCode: p.sku,
              itemName: p.name,
              itemGroup: p.category?.name || 'General',
              uom: p.unit?.name || 'Nos',
              location: p.location || '-',
              costPrice: Number(p.cost_price || 0),
              systemQty: Number(p.quantity || 0),
              countedQty: null, // Initially uncounted
              varianceQty: 0,
              varianceValue: 0,
              status: 'Pending',
            })),
          },
        },
        include: {
          items: {
            orderBy: [
              { itemGroup: 'asc' },
              { itemCode: 'asc' },
            ],
          },
        },
      });
    } else {
      // 3. If session exists and is still Draft/In Progress, synchronize any newly added products
      if (session.status !== 'Reconciled') {
        const existingProductIds = new Set(session.items.map((i) => i.productId));
        const missingProducts = products.filter((p) => !existingProductIds.has(p.id));

        if (missingProducts.length > 0) {
          await prisma.stockCountItem.createMany({
            data: missingProducts.map((p) => ({
              sessionId: session!.id,
              productId: p.id,
              itemCode: p.sku,
              itemName: p.name,
              itemGroup: p.category?.name || 'General',
              uom: p.unit?.name || 'Nos',
              location: p.location || '-',
              costPrice: Number(p.cost_price || 0),
              systemQty: Number(p.quantity || 0),
              countedQty: null,
              varianceQty: 0,
              varianceValue: 0,
              status: 'Pending',
            })),
          });

          // Reload updated session
          session = await prisma.stockCountSession.findUnique({
            where: { id: session.id },
            include: {
              items: {
                orderBy: [
                  { itemGroup: 'asc' },
                  { itemCode: 'asc' },
                ],
              },
            },
          });
        }
      }
    }

    res.json(session);
  } catch (error: any) {
    console.error('Error fetching stock count session:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch stock count session' });
  }
});

// POST Save Stock Count Draft (Batch update counted quantities & notes)
router.post('/save', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { sessionId, items, notes, title } = req.body;

    if (!sessionId || !Array.isArray(items)) {
      return res.status(400).json({ error: 'sessionId and items array are required' });
    }

    const session = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Stock count session not found' });
    }

    if (session.status === 'Reconciled') {
      return res.status(400).json({ error: 'Cannot edit a stock count session that has already been reconciled' });
    }

    // Update each item
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const existing = session.items.find((i) => i.id === item.id || i.productId === item.productId);
        if (!existing) continue;

        const countedVal = item.countedQty !== undefined && item.countedQty !== null && item.countedQty !== ''
          ? Number(item.countedQty)
          : null;

        const varianceQty = countedVal !== null ? (countedVal - existing.systemQty) : 0;
        const cost = Number(existing.costPrice || 0);
        const varianceValue = varianceQty * cost;

        let status = 'Pending';
        if (countedVal !== null) {
          if (varianceQty === 0) status = 'Matched';
          else if (varianceQty < 0) status = 'Shortage';
          else status = 'Surplus';
        }

        await tx.stockCountItem.update({
          where: { id: existing.id },
          data: {
            countedQty: countedVal,
            varianceQty,
            varianceValue,
            status,
            reason: item.reason || existing.reason || null,
          },
        });
      }

      // Recalculate session totals
      const updatedItems = await tx.stockCountItem.findMany({
        where: { sessionId },
      });

      const totalItems = updatedItems.length;
      const matchedItems = updatedItems.filter((i) => i.status === 'Matched').length;
      const discrepantItems = updatedItems.filter((i) => i.status === 'Shortage' || i.status === 'Surplus').length;
      const netVarianceQty = updatedItems.reduce((sum, i) => sum + i.varianceQty, 0);
      const netVarianceValue = updatedItems.reduce((sum, i) => sum + Number(i.varianceValue), 0);

      const hasAnyCounts = updatedItems.some((i) => i.countedQty !== null);
      const sessionStatus = hasAnyCounts ? 'In Progress' : 'Draft';

      await tx.stockCountSession.update({
        where: { id: sessionId },
        data: {
          title: title || session.title,
          notes: notes !== undefined ? notes : session.notes,
          status: sessionStatus,
          totalItems,
          matchedItems,
          discrepantItems,
          netVarianceQty,
          netVarianceValue,
        },
      });
    });

    const refreshed = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: {
        items: {
          orderBy: [
            { itemGroup: 'asc' },
            { itemCode: 'asc' },
          ],
        },
      },
    });

    res.json(refreshed);
  } catch (error: any) {
    console.error('Error saving stock count:', error);
    res.status(500).json({ error: error.message || 'Failed to save stock count' });
  }
});

// POST Auto-Populate System Stock to Counted (Helper to pre-fill count with current book stock)
router.post('/auto-populate', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { sessionId, mode = 'ALL' } = req.body; // 'ALL' or 'ONLY_EMPTY'

    const session = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'Reconciled') {
      return res.status(400).json({ error: 'Cannot modify a reconciled session' });
    }

    await prisma.$transaction(async (tx) => {
      for (const item of session.items) {
        if (mode === 'ONLY_EMPTY' && item.countedQty !== null) continue;

        await tx.stockCountItem.update({
          where: { id: item.id },
          data: {
            countedQty: item.systemQty,
            varianceQty: 0,
            varianceValue: 0,
            status: 'Matched',
          },
        });
      }

      await tx.stockCountSession.update({
        where: { id: sessionId },
        data: {
          status: 'In Progress',
          matchedItems: session.items.length,
          discrepantItems: 0,
          netVarianceQty: 0,
          netVarianceValue: 0,
        },
      });
    });

    const refreshed = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: {
        items: {
          orderBy: [
            { itemGroup: 'asc' },
            { itemCode: 'asc' },
          ],
        },
      },
    });

    res.json(refreshed);
  } catch (error: any) {
    console.error('Error auto-populating stock count:', error);
    res.status(500).json({ error: error.message || 'Failed to auto-populate stock count' });
  }
});

// POST Reconcile Stock (Executes adjustments in StockLedger & updates Product.quantity)
router.post('/reconcile', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { sessionId, notes, user } = req.body;

    const session = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: { items: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'Reconciled') {
      return res.status(400).json({ error: 'Session has already been reconciled' });
    }

    const itemsToReconcile = session.items.filter(
      (i) => i.countedQty !== null && i.varianceQty !== 0
    );

    const reconcileDate = new Date();

    await prisma.$transaction(async (tx) => {
      for (const item of itemsToReconcile) {
        const change = item.varianceQty;
        const productId = item.productId;

        // Calculate running balance
        const currentBalanceResult: any = await tx.$queryRaw`
          SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
          FROM "StockLedger"
          WHERE "productId" = ${productId}
            AND date < ${reconcileDate}::TIMESTAMP
        `;
        const rawBefore = currentBalanceResult[0]?.balance_before;
        const balanceBefore = rawBefore !== undefined && rawBefore !== null ? Number(rawBefore) : 0;
        const newRunningBalance = balanceBefore + change;

        // Create adjustment entry in StockLedger
        await tx.stockLedger.create({
          data: {
            productId,
            date: reconcileDate,
            type: 'ADJUSTMENT',
            quantityChange: change,
            runningBalance: newRunningBalance,
          },
        });

        // Update product current stock quantity
        await tx.product.update({
          where: { id: productId },
          data: {
            quantity: item.countedQty!,
          },
        });
      }

      // Mark session as Reconciled
      await tx.stockCountSession.update({
        where: { id: sessionId },
        data: {
          status: 'Reconciled',
          reconciledAt: reconcileDate,
          reconciledBy: user || 'Store Administrator',
          notes: notes ? `${session.notes ? session.notes + ' | ' : ''}${notes}` : session.notes,
        },
      });
    });

    const refreshed = await prisma.stockCountSession.findUnique({
      where: { id: sessionId },
      include: {
        items: {
          orderBy: [
            { itemGroup: 'asc' },
            { itemCode: 'asc' },
          ],
        },
      },
    });

    res.json({
      success: true,
      message: `Stock successfully reconciled! ${itemsToReconcile.length} inventory discrepancy adjustment(s) recorded in Stock Ledger.`,
      reconciledAdjustmentsCount: itemsToReconcile.length,
      session: refreshed,
    });
  } catch (error: any) {
    console.error('Error reconciling stock count:', error);
    res.status(500).json({ error: error.message || 'Failed to reconcile stock count' });
  }
});

// GET Stock Count History / Sessions list
router.get('/history', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const sessions = await prisma.stockCountSession.findMany({
      orderBy: { countDate: 'desc' },
      include: {
        _count: {
          select: { items: true },
        },
      },
    });

    res.json(sessions);
  } catch (error: any) {
    console.error('Error fetching stock count history:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch history' });
  }
});

// GET specific historical session by ID
router.get('/session/:id', async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const { id } = req.params;
    const session = await prisma.stockCountSession.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: [
            { itemGroup: 'asc' },
            { itemCode: 'asc' },
          ],
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session);
  } catch (error: any) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch session' });
  }
});

export default router;

