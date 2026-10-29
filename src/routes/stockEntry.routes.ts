import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all stock ledger entries
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, type, productId, startDate, endDate } = req.query;

    const whereClause: any = {};

    if (type && type !== 'ALL') {
      whereClause.type = String(type);
    }

    if (productId) {
      whereClause.productId = String(productId);
    }

    if (startDate || endDate) {
      whereClause.date = {};
      if (startDate) {
        whereClause.date.gte = new Date(String(startDate));
      }
      if (endDate) {
        whereClause.date.lte = new Date(String(endDate));
      }
    }

    if (search) {
      const q = String(search).trim();
      whereClause.OR = [
        { product: { name: { contains: q, mode: 'insensitive' } } },
        { product: { sku: { contains: q, mode: 'insensitive' } } },
        { invoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const ledgers = await prisma.stockLedger.findMany({
      where: whereClause,
      include: {
        product: {
          include: {
            category: true,
            unit: true,
          },
        },
        invoice: {
          include: {
            customer: true,
            supplier: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    const formatted = ledgers.map((l) => ({
      id: l.id,
      productId: l.productId,
      product: l.product
        ? {
            id: l.product.id,
            name: l.product.name,
            sku: l.product.sku,
            quantity: l.product.quantity,
            location: l.product.location || '',
            category: l.product.category ? { name: l.product.category.name } : undefined,
            unit: l.product.unit ? { name: l.product.unit.name } : undefined,
          }
        : undefined,
      date: l.date.toISOString(),
      type: l.type,
      quantityChange: l.quantityChange,
      runningBalance: l.runningBalance,
      invoiceId: l.invoiceId,
      invoice: l.invoice
        ? {
            id: l.invoice.id,
            invoiceNumber: l.invoice.invoiceNumber,
            type: l.invoice.type,
            date: l.invoice.date.toISOString(),
            client: l.invoice.customer ? { companyName: l.invoice.customer.name } : null,
            supplier: l.invoice.supplier ? { name: l.invoice.supplier.name } : null,
          }
        : null,
      createdAt: l.createdAt.toISOString(),
    }));

    res.json(formatted);
  } catch (error: any) {
    console.error('Error fetching stock entries:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch stock entries' });
  }
});

// GET single stock ledger entry
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const l = await prisma.stockLedger.findUnique({
      where: { id },
      include: {
        product: {
          include: {
            category: true,
            unit: true,
          },
        },
        invoice: {
          include: {
            customer: true,
            supplier: true,
          },
        },
      },
    });

    if (!l) {
      return res.status(404).json({ error: 'Stock entry not found' });
    }

    const formatted = {
      id: l.id,
      productId: l.productId,
      product: l.product
        ? {
            id: l.product.id,
            name: l.product.name,
            sku: l.product.sku,
            quantity: l.product.quantity,
            location: l.product.location || '',
            category: l.product.category ? { name: l.product.category.name } : undefined,
            unit: l.product.unit ? { name: l.product.unit.name } : undefined,
          }
        : undefined,
      date: l.date.toISOString(),
      type: l.type,
      quantityChange: l.quantityChange,
      runningBalance: l.runningBalance,
      invoiceId: l.invoiceId,
      invoice: l.invoice
        ? {
            id: l.invoice.id,
            invoiceNumber: l.invoice.invoiceNumber,
            type: l.invoice.type,
            date: l.invoice.date.toISOString(),
            client: l.invoice.customer ? { companyName: l.invoice.customer.name } : null,
            supplier: l.invoice.supplier ? { name: l.invoice.supplier.name } : null,
          }
        : null,
      createdAt: l.createdAt.toISOString(),
    };

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch stock entry' });
  }
});

// POST create manual stock entry / adjustment
router.post('/', async (req: Request, res: Response) => {
  try {
    const { productId, type = 'ADJUSTMENT', quantityChange, date, notes } = req.body;

    if (!productId || quantityChange === undefined) {
      return res.status(400).json({ error: 'productId and quantityChange are required' });
    }

    const change = Number(quantityChange);
    const entryDate = date ? new Date(date) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) {
        throw new Error('Product not found');
      }

      // Calculate running balance
      const currentBalanceResult: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
        FROM "StockLedger"
        WHERE "productId" = ${productId}
          AND date < ${entryDate}::TIMESTAMP
      `;
      const rawBefore = currentBalanceResult[0]?.balance_before;
      const balanceBefore = rawBefore !== undefined && rawBefore !== null ? Number(rawBefore) : 0;
      const newRunningBalance = balanceBefore + change;

      const newEntry = await tx.stockLedger.create({
        data: {
          productId,
          date: entryDate,
          type: type || 'ADJUSTMENT',
          quantityChange: change,
          runningBalance: newRunningBalance,
        },
        include: {
          product: {
            include: {
              category: true,
              unit: true,
            },
          },
        },
      });

      // Update future entries if backdated
      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" + ${change}
        WHERE "productId" = ${productId}
          AND date > ${entryDate}::TIMESTAMP
      `;

      // Update cached product quantity
      await tx.product.update({
        where: { id: productId },
        data: {
          quantity: product.quantity + change,
        },
      });

      return newEntry;
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Failed to create stock entry:', error);
    res.status(500).json({ error: error.message || 'Failed to create stock entry' });
  }
});

// PUT update manual stock entry
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quantityChange, type, date } = req.body;

    const existing = await prisma.stockLedger.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Stock entry not found' });
    }

    const diff = quantityChange !== undefined ? Number(quantityChange) - existing.quantityChange : 0;
    const newDate = date ? new Date(date) : existing.date;

    const updated = await prisma.$transaction(async (tx) => {
      const entry = await tx.stockLedger.update({
        where: { id },
        data: {
          type: type || existing.type,
          quantityChange: quantityChange !== undefined ? Number(quantityChange) : existing.quantityChange,
          date: newDate,
        },
        include: {
          product: true,
        },
      });

      if (diff !== 0) {
        await tx.product.update({
          where: { id: existing.productId },
          data: {
            quantity: { increment: diff },
          },
        });

        await tx.$queryRaw`
          UPDATE "StockLedger"
          SET "runningBalance" = "runningBalance" + ${diff}
          WHERE "productId" = ${existing.productId}
            AND date >= ${newDate}::TIMESTAMP
        `;
      }

      return entry;
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update stock entry' });
  }
});

// DELETE stock entry
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.stockLedger.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Stock entry not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: existing.productId },
        data: {
          quantity: { decrement: existing.quantityChange },
        },
      });

      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" - ${existing.quantityChange}
        WHERE "productId" = ${existing.productId}
          AND date > ${existing.date}::TIMESTAMP
      `;

      await tx.stockLedger.delete({ where: { id } });
    });

    res.json({ message: 'Stock entry deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete stock entry' });
  }
});

export default router;
