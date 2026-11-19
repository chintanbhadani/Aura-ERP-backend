import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Helper to ensure RepackEntry table exists in the database
let tableEnsured = false;
async function ensureRepackTable() {
  if (tableEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RepackEntry" (
        "id" TEXT PRIMARY KEY,
        "repackNumber" TEXT UNIQUE NOT NULL,
        "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "sourceProductId" TEXT NOT NULL REFERENCES "Product"("id"),
        "sourceQuantity" DECIMAL(10, 2) NOT NULL,
        "targetProductId" TEXT NOT NULL REFERENCES "Product"("id"),
        "targetQuantity" DECIMAL(10, 2) NOT NULL,
        "purchaseItemId" TEXT,
        "purchaseInvoiceNo" TEXT,
        "packagingCost" DECIMAL(10, 2) DEFAULT 0,
        "calculatedCost" DECIMAL(10, 2) DEFAULT 0,
        "notes" TEXT,
        "status" TEXT NOT NULL DEFAULT 'Completed',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`ALTER TABLE "RepackEntry" ADD COLUMN IF NOT EXISTS "purchaseItemId" TEXT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "RepackEntry" ADD COLUMN IF NOT EXISTS "purchaseInvoiceNo" TEXT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "RepackEntry" ADD COLUMN IF NOT EXISTS "poAllocations" JSONB`);
    tableEnsured = true;
  } catch (err) {
    console.error('Error ensuring RepackEntry table:', err);
  }
}

// Helper to generate next repack number e.g. RPK-2026-0001
async function generateRepackNumber(): Promise<string> {
  await ensureRepackTable();
  const year = new Date().getFullYear();
  const prefix = `RPK-${year}-`;

  const lastEntry = await prisma.repackEntry.findFirst({
    where: {
      repackNumber: { startsWith: prefix }
    },
    orderBy: {
      repackNumber: 'desc'
    }
  });

  if (!lastEntry) {
    return `${prefix}0001`;
  }

  const lastNumStr = lastEntry.repackNumber.replace(prefix, '');
  const nextNum = (parseInt(lastNumStr, 10) || 0) + 1;
  return `${prefix}${nextNum.toString().padStart(4, '0')}`;
}

// GET all available PO items from Purchase Invoices with remaining stock
router.get('/available-po-items', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();

    // 1. Fetch all purchase items with supplier and product details
    const purchaseItems = await prisma.invoiceItem.findMany({
      where: {
        invoice: {
          type: 'PURCHASE',
        },
      },
      include: {
        invoice: {
          include: {
            supplier: true,
          },
        },
        product: {
          include: {
            unit: true,
            category: true,
          },
        },
      },
      orderBy: {
        invoice: {
          date: 'desc',
        },
      },
    });

    // 2. Fetch sales consumption linked to purchase items
    const salesItems = await prisma.invoiceItem.findMany({
      where: {
        invoice: {
          type: 'SALES',
        },
        OR: [
          { purchaseItemId: { not: null } },
          { poAllocations: { not: Prisma.JsonNull } },
        ],
      },
      select: {
        purchaseItemId: true,
        quantity: true,
        poAllocations: true,
      },
    });

    const consumedMap = new Map<string, number>();
    for (const s of salesItems) {
      if (Array.isArray(s.poAllocations) && s.poAllocations.length > 0) {
        for (const alloc of s.poAllocations as any[]) {
          if (alloc.purchaseItemId && alloc.quantity) {
            consumedMap.set(
              alloc.purchaseItemId,
              (consumedMap.get(alloc.purchaseItemId) || 0) + Number(alloc.quantity)
            );
          }
        }
      } else if (s.purchaseItemId) {
        consumedMap.set(
          s.purchaseItemId,
          (consumedMap.get(s.purchaseItemId) || 0) + s.quantity
        );
      }
    }

    // 3. Fetch repack deductions linked to purchase items
    const repacks = await prisma.repackEntry.findMany({
      where: {
        purchaseItemId: { not: null },
      },
      select: {
        purchaseItemId: true,
        sourceQuantity: true,
      },
    });

    for (const r of repacks) {
      if (r.purchaseItemId) {
        consumedMap.set(
          r.purchaseItemId,
          (consumedMap.get(r.purchaseItemId) || 0) + Number(r.sourceQuantity)
        );
      }
    }

    const availableItems = [];
    for (const pi of purchaseItems) {
      const consumed = consumedMap.get(pi.id) || 0;
      const initialQty = Number(pi.quantity);
      const availableQty = Math.max(0, initialQty - consumed);

      if (availableQty > 0) {
        availableItems.push({
          purchaseItemId: pi.id,
          poNumber: pi.invoice.invoiceNumber,
          poId: pi.invoice.id,
          date: pi.invoice.date,
          supplierName: pi.invoice.supplier?.name || 'Direct Purchase',
          productId: pi.product.id,
          productName: pi.product.name,
          sku: pi.product.sku,
          unitName: pi.product.unit?.name || 'Units',
          unitCost: Number(pi.unitPrice),
          initialQuantity: initialQty,
          availableQuantity: availableQty,
        });
      }
    }

    res.json(availableItems);
  } catch (error: any) {
    console.error('Error fetching available PO items:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch PO items' });
  }
});

// GET all repack entries
router.get('/', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const { search, startDate, endDate } = req.query;

    const where: any = {};
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(String(startDate));
      if (endDate) where.date.lte = new Date(String(endDate));
    }

    if (search) {
      const q = String(search).trim();
      where.OR = [
        { repackNumber: { contains: q, mode: 'insensitive' } },
        { purchaseInvoiceNo: { contains: q, mode: 'insensitive' } },
        { notes: { contains: q, mode: 'insensitive' } },
        { sourceProduct: { name: { contains: q, mode: 'insensitive' } } },
        { sourceProduct: { sku: { contains: q, mode: 'insensitive' } } },
        { targetProduct: { name: { contains: q, mode: 'insensitive' } } },
        { targetProduct: { sku: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const repacks = await prisma.repackEntry.findMany({
      where,
      include: {
        sourceProduct: {
          include: { unit: true, category: true }
        },
        targetProduct: {
          include: { unit: true, category: true }
        }
      },
      orderBy: { date: 'desc' }
    });

    res.json(repacks);
  } catch (error: any) {
    console.error('Error fetching repacks:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch repack entries' });
  }
});

// GET single repack entry
router.get('/:id', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const repack = await prisma.repackEntry.findUnique({
      where: { id: req.params.id },
      include: {
        sourceProduct: { include: { unit: true, category: true } },
        targetProduct: { include: { unit: true, category: true } }
      }
    });

    if (!repack) return res.status(404).json({ error: 'Repack entry not found' });
    res.json(repack);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch repack entry' });
  }
});

// POST create repack entry (Atomic stock conversion)
router.post('/', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const {
      sourceProductId,
      sourceQuantity,
      targetProductId,
      targetQuantity,
      purchaseItemId,
      purchaseInvoiceNo,
      poAllocations,
      packagingCost = 0,
      date,
      notes,
      status = 'Submitted'
    } = req.body;

    if (!sourceProductId || !targetProductId) {
      return res.status(400).json({ error: 'Source bulk item and Target packed item are required' });
    }

    const srcQty = Number(sourceQuantity);
    const tgtQty = Number(targetQuantity);
    const extraCost = Number(packagingCost || 0);

    if (srcQty <= 0 || tgtQty <= 0) {
      return res.status(400).json({ error: 'Source quantity and Target quantity must be greater than 0' });
    }

    if (sourceProductId === targetProductId) {
      return res.status(400).json({ error: 'Source item and Target item cannot be the same product' });
    }

    const isDraft = status === 'Draft';
    const repackDate = date ? new Date(date) : new Date();
    const repackNumber = await generateRepackNumber();

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch Source and Target Products
      const sourceProd = await tx.product.findUnique({ where: { id: sourceProductId } });
      if (!sourceProd) {
        throw new Error('Source bulk product not found');
      }

      if (!isDraft && sourceProd.quantity < srcQty) {
        throw new Error(
          `Insufficient bulk stock for "${sourceProd.name}". Current available: ${sourceProd.quantity}, required: ${srcQty}`
        );
      }

      const targetProd = await tx.product.findUnique({ where: { id: targetProductId } });
      if (!targetProd) {
        throw new Error('Target packed product not found');
      }

      // 2. Determine Unit Cost (use PO allocations/item purchase price if provided, otherwise source product cost_price)
      let bulkUnitCost = Number(sourceProd.cost_price || 0);
      let resolvedPoNumber = purchaseInvoiceNo || null;
      let primaryPurchaseItemId = purchaseItemId || null;

      if (Array.isArray(poAllocations) && poAllocations.length > 0) {
        let totalAllocValuation = 0;
        let totalAllocQty = 0;
        const poNumbers: string[] = [];
        
        for (const alloc of poAllocations) {
          const qty = Number(alloc.allocatedQty || alloc.quantity || 0);
          const cost = Number(alloc.unitCost || 0);
          totalAllocValuation += cost * qty;
          totalAllocQty += qty;
          if (alloc.poNumber && !poNumbers.includes(alloc.poNumber)) {
            poNumbers.push(alloc.poNumber);
          }
          if (!primaryPurchaseItemId && alloc.purchaseItemId) {
            primaryPurchaseItemId = alloc.purchaseItemId;
          }
        }

        if (totalAllocQty > 0) {
          bulkUnitCost = totalAllocValuation / totalAllocQty;
        }
        if (poNumbers.length > 0) {
          resolvedPoNumber = poNumbers.join(', ');
        }
      } else if (purchaseItemId && purchaseItemId !== 'INITIAL') {
        const poItem = await tx.invoiceItem.findUnique({
          where: { id: purchaseItemId },
          include: { invoice: true }
        });
        if (poItem) {
          bulkUnitCost = Number(poItem.unitPrice);
          if (!resolvedPoNumber && poItem.invoice) {
            resolvedPoNumber = poItem.invoice.invoiceNumber;
          }
        }
      }

      // 3. Calculate new unit cost for target product
      const totalBulkValuation = bulkUnitCost * srcQty;
      const totalRepackCost = totalBulkValuation + extraCost;
      const calculatedUnitCost = Math.round((totalRepackCost / tgtQty) * 100) / 100;

      // 4. Create Repack Entry Record
      const entry = await tx.repackEntry.create({
        data: {
          repackNumber,
          date: repackDate,
          sourceProductId,
          sourceQuantity: srcQty,
          targetProductId,
          targetQuantity: tgtQty,
          purchaseItemId: primaryPurchaseItemId,
          purchaseInvoiceNo: resolvedPoNumber,
          poAllocations: poAllocations ? (poAllocations as any) : Prisma.JsonNull,
          packagingCost: extraCost,
          calculatedCost: calculatedUnitCost,
          notes: notes || `Repacked ${srcQty} of ${sourceProd.name} from ${resolvedPoNumber || 'Bulk'} into ${tgtQty} of ${targetProd.name}`,
          status: isDraft ? 'Draft' : 'Submitted'
        },
        include: {
          sourceProduct: { include: { unit: true } },
          targetProduct: { include: { unit: true } }
        }
      });

      // If Draft, do not execute stock movements yet
      if (isDraft) {
        return entry;
      }

      // 5. Stock Ledger: Deduct Source Bulk Item (-srcQty)
      const srcCurrentBalanceRes: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
        FROM "StockLedger"
        WHERE "productId" = ${sourceProductId}
          AND date < ${repackDate}::TIMESTAMP
      `;
      const srcBalanceBefore = Number(srcCurrentBalanceRes[0]?.balance_before || 0);
      const srcRunningBalance = srcBalanceBefore - srcQty;

      await tx.stockLedger.create({
        data: {
          productId: sourceProductId,
          date: repackDate,
          type: 'REPACK_OUT',
          quantityChange: -srcQty,
          runningBalance: srcRunningBalance
        }
      });

      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" - ${srcQty}
        WHERE "productId" = ${sourceProductId}
          AND date > ${repackDate}::TIMESTAMP
      `;

      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${sourceProductId}), 0)
        WHERE id = ${sourceProductId}
      `;

      // 6. Stock Ledger: Add Target Packed Item (+tgtQty)
      const tgtCurrentBalanceRes: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
        FROM "StockLedger"
        WHERE "productId" = ${targetProductId}
          AND date < ${repackDate}::TIMESTAMP
      `;
      const tgtBalanceBefore = Number(tgtCurrentBalanceRes[0]?.balance_before || 0);
      const tgtRunningBalance = tgtBalanceBefore + tgtQty;

      await tx.stockLedger.create({
        data: {
          productId: targetProductId,
          date: repackDate,
          type: 'REPACK_IN',
          quantityChange: tgtQty,
          runningBalance: tgtRunningBalance
        }
      });

      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" + ${tgtQty}
        WHERE "productId" = ${targetProductId}
          AND date > ${repackDate}::TIMESTAMP
      `;

      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${targetProductId}), 0),
            cost_price = ${calculatedUnitCost}
        WHERE id = ${targetProductId}
      `;

      return entry;
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Error creating repack entry:', error);
    res.status(500).json({ error: error.message || 'Failed to process repack' });
  }
});

// GET single repack entry by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const { id } = req.params;
    const entry = await prisma.repackEntry.findUnique({
      where: { id },
      include: {
        sourceProduct: { include: { unit: true } },
        targetProduct: { include: { unit: true } }
      }
    });

    if (!entry) {
      return res.status(404).json({ error: 'Repack entry not found' });
    }

    res.json(entry);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch repack entry' });
  }
});

// POST submit a draft repack entry
router.post('/:id/submit', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const { id } = req.params;

    const existing = await prisma.repackEntry.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Repack entry not found' });

    if (existing.status === 'Submitted' || existing.status === 'Completed') {
      return res.status(400).json({ error: 'Repack entry is already submitted' });
    }
    if (existing.status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot submit a cancelled repack entry' });
    }

    const srcQty = Number(existing.sourceQuantity);
    const tgtQty = Number(existing.targetQuantity);
    const repackDate = new Date(existing.date);

    const result = await prisma.$transaction(async (tx) => {
      const sourceProd = await tx.product.findUnique({ where: { id: existing.sourceProductId } });
      if (!sourceProd || sourceProd.quantity < srcQty) {
        throw new Error(`Insufficient bulk stock for "${sourceProd?.name || existing.sourceProductId}". Available: ${sourceProd?.quantity || 0}, requested: ${srcQty}`);
      }

      // Deduct source bulk
      const srcCurrentBalanceRes: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
        FROM "StockLedger"
        WHERE "productId" = ${existing.sourceProductId}
          AND date < ${repackDate}::TIMESTAMP
      `;
      const srcBalanceBefore = Number(srcCurrentBalanceRes[0]?.balance_before || 0);
      const srcRunningBalance = srcBalanceBefore - srcQty;

      await tx.stockLedger.create({
        data: {
          productId: existing.sourceProductId,
          date: repackDate,
          type: 'REPACK_OUT',
          quantityChange: -srcQty,
          runningBalance: srcRunningBalance
        }
      });

      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" - ${srcQty}
        WHERE "productId" = ${existing.sourceProductId}
          AND date > ${repackDate}::TIMESTAMP
      `;

      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${existing.sourceProductId}), 0)
        WHERE id = ${existing.sourceProductId}
      `;

      // Add target packed item
      const tgtCurrentBalanceRes: any = await tx.$queryRaw`
        SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
        FROM "StockLedger"
        WHERE "productId" = ${existing.targetProductId}
          AND date < ${repackDate}::TIMESTAMP
      `;
      const tgtBalanceBefore = Number(tgtCurrentBalanceRes[0]?.balance_before || 0);
      const tgtRunningBalance = tgtBalanceBefore + tgtQty;

      await tx.stockLedger.create({
        data: {
          productId: existing.targetProductId,
          date: repackDate,
          type: 'REPACK_IN',
          quantityChange: tgtQty,
          runningBalance: tgtRunningBalance
        }
      });

      await tx.$queryRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" + ${tgtQty}
        WHERE "productId" = ${existing.targetProductId}
          AND date > ${repackDate}::TIMESTAMP
      `;

      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${existing.targetProductId}), 0)
        WHERE id = ${existing.targetProductId}
      `;

      return tx.repackEntry.update({
        where: { id },
        data: { status: 'Submitted' },
        include: {
          sourceProduct: { include: { unit: true } },
          targetProduct: { include: { unit: true } }
        }
      });
    });

    res.json(result);
  } catch (error: any) {
    console.error('Error submitting repack entry:', error);
    res.status(500).json({ error: error.message || 'Failed to submit repack entry' });
  }
});

// POST cancel a repack entry
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const { id } = req.params;

    const entry = await prisma.repackEntry.findUnique({ where: { id } });
    if (!entry) return res.status(404).json({ error: 'Repack entry not found' });

    if (entry.status === 'Cancelled') {
      return res.status(400).json({ error: 'Repack entry is already cancelled' });
    }

    const isSubmitted = entry.status === 'Submitted' || entry.status === 'Completed';

    const result = await prisma.$transaction(async (tx) => {
      if (isSubmitted) {
        const srcQty = Number(entry.sourceQuantity);
        const tgtQty = Number(entry.targetQuantity);

        // Check if target product produced by this repack has already been consumed/sold
        const targetProd = await tx.product.findUnique({ where: { id: entry.targetProductId } });
        if (targetProd && targetProd.quantity < tgtQty) {
          throw new Error(`Cannot cancel Repack: Produced items for "${targetProd.name}" have already been consumed or sold. Current stock is ${targetProd.quantity}, required to revert: ${tgtQty}`);
        }

        // Delete the corresponding repack ledger entries
        await tx.$executeRaw`
          DELETE FROM "StockLedger"
          WHERE id IN (
            SELECT id FROM "StockLedger"
            WHERE "productId" = ${entry.sourceProductId}
              AND type = 'REPACK_OUT'
              AND "quantityChange" = -${srcQty}
              AND date = ${entry.date}::TIMESTAMP
            LIMIT 1
          )
        `;
        await tx.$executeRaw`
          DELETE FROM "StockLedger"
          WHERE id IN (
            SELECT id FROM "StockLedger"
            WHERE "productId" = ${entry.targetProductId}
              AND type = 'REPACK_IN'
              AND "quantityChange" = ${tgtQty}
              AND date = ${entry.date}::TIMESTAMP
            LIMIT 1
          )
        `;

        // Update future running balances
        await tx.$executeRaw`
          UPDATE "StockLedger"
          SET "runningBalance" = "runningBalance" + ${srcQty}
          WHERE "productId" = ${entry.sourceProductId}
            AND date > ${entry.date}::TIMESTAMP
        `;
        await tx.$executeRaw`
          UPDATE "StockLedger"
          SET "runningBalance" = "runningBalance" - ${tgtQty}
          WHERE "productId" = ${entry.targetProductId}
            AND date > ${entry.date}::TIMESTAMP
        `;

        // Sync Product.quantity for both products to match true StockLedger sum
        await tx.$executeRaw`
          UPDATE "Product"
          SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${entry.sourceProductId}), 0)
          WHERE id = ${entry.sourceProductId}
        `;
        await tx.$executeRaw`
          UPDATE "Product"
          SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${entry.targetProductId}), 0)
          WHERE id = ${entry.targetProductId}
        `;
      }

      return tx.repackEntry.update({
        where: { id },
        data: { status: 'Cancelled' },
        include: {
          sourceProduct: { include: { unit: true } },
          targetProduct: { include: { unit: true } }
        }
      });
    });

    res.json({ message: 'Repack entry cancelled successfully. Stock has been restored.', entry: result });
  } catch (error: any) {
    console.error('Error cancelling repack entry:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel repack entry' });
  }
});

// DELETE revert repack entry
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await ensureRepackTable();
    const { id } = req.params;

    const entry = await prisma.repackEntry.findUnique({ where: { id } });
    if (!entry) return res.status(404).json({ error: 'Repack entry not found' });

    await prisma.$transaction(async (tx) => {
      const srcQty = Number(entry.sourceQuantity);
      const tgtQty = Number(entry.targetQuantity);

      // Revert StockLedger: delete the corresponding repack ledger entries
      await tx.$executeRaw`
        DELETE FROM "StockLedger"
        WHERE id IN (
          SELECT id FROM "StockLedger"
          WHERE "productId" = ${entry.sourceProductId}
            AND type = 'REPACK_OUT'
            AND "quantityChange" = -${srcQty}
            AND date = ${entry.date}::TIMESTAMP
          LIMIT 1
        )
      `;
      await tx.$executeRaw`
        DELETE FROM "StockLedger"
        WHERE id IN (
          SELECT id FROM "StockLedger"
          WHERE "productId" = ${entry.targetProductId}
            AND type = 'REPACK_IN'
            AND "quantityChange" = ${tgtQty}
            AND date = ${entry.date}::TIMESTAMP
          LIMIT 1
        )
      `;

      // Update future running balances
      await tx.$executeRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" + ${srcQty}
        WHERE "productId" = ${entry.sourceProductId}
          AND date > ${entry.date}::TIMESTAMP
      `;
      await tx.$executeRaw`
        UPDATE "StockLedger"
        SET "runningBalance" = "runningBalance" - ${tgtQty}
        WHERE "productId" = ${entry.targetProductId}
          AND date > ${entry.date}::TIMESTAMP
      `;

      // Sync Product.quantity for both products to match true StockLedger sum
      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${entry.sourceProductId}), 0)
        WHERE id = ${entry.sourceProductId}
      `;
      await tx.$executeRaw`
        UPDATE "Product"
        SET quantity = COALESCE((SELECT SUM("quantityChange") FROM "StockLedger" WHERE "productId" = ${entry.targetProductId}), 0)
        WHERE id = ${entry.targetProductId}
      `;

      // Clean up Repack record
      await tx.repackEntry.delete({ where: { id } });
    });

    res.json({ message: 'Repack entry reverted successfully' });
  } catch (error: any) {
    console.error('Error reverting repack entry:', error);
    res.status(500).json({ error: error.message || 'Failed to revert repack entry' });
  }
});

export default router;
