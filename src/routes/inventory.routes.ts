import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

/**
 * Self-healing stock reconciler:
 * Keeps Product.quantity 100% in sync with the audit trail in StockLedger.
 * 1. For any product with initial quantity > 0 and 0 stock ledger records, creates an INITIAL entry.
 * 2. For all products with entries in StockLedger, synchronizes Product.quantity to equal SUM(quantityChange).
 */
export async function syncProductQuantitiesWithLedger() {
  try {
    // 0. Remove any StockLedger, CashLedger, or Payment entries mistakenly linked to Draft or Cancelled invoices
    await prisma.$executeRaw`
      DELETE FROM "StockLedger" sl
      USING "Invoice" inv
      WHERE sl."invoiceId" = inv.id
        AND inv."status" IN ('Draft', 'Cancelled')
    `;

    await prisma.$executeRaw`
      DELETE FROM "CashLedger" cl
      USING "Invoice" inv
      WHERE cl."invoiceId" = inv.id
        AND inv."status" IN ('Draft', 'Cancelled')
    `;

    await prisma.$executeRaw`
      DELETE FROM "Payment" p
      USING "Invoice" inv
      WHERE p."invoiceId" = inv.id
        AND inv."status" IN ('Draft', 'Cancelled')
    `;

    // 1. Sync Product.quantity strictly with the exact sum of valid StockLedger entries for ALL products
    await prisma.$executeRaw`
      UPDATE "Product" p
      SET quantity = COALESCE((
        SELECT SUM(sl."quantityChange")
        FROM "StockLedger" sl
        LEFT JOIN "Invoice" inv ON inv.id = sl."invoiceId"
        WHERE sl."productId" = p.id
          AND (inv.id IS NULL OR inv."status" NOT IN ('Draft', 'Cancelled'))
      ), 0);
    `;
  } catch (err: any) {
    logger.error('[Inventory Reconcile] Error syncing product quantities with StockLedger:', { error: err?.message || err, stack: err?.stack });
  }
}

// Helper to calculate WAC and FIFO for a product
async function calculateValuationsForProduct(product: any, ledgers: any[]) {
  const productLedgers = ledgers.filter(l => l.productId === product.id);
  const ledgerQty = productLedgers.reduce((sum, l) => sum + Number(l.quantityChange || 0), 0);
  const effectiveQty = productLedgers.length > 0 ? ledgerQty : Number(product.quantity || 0);
  
  let wacQty = 0;
  let wacPrice = 0;
  
  let fifoQueue: {qty: number, price: number}[] = [];

  for (const l of productLedgers) {
    if (l.type === 'PURCHASE' && l.invoice && l.invoice.status !== 'Cancelled' && l.invoice.status !== 'Draft') {
      const item = l.invoice.items.find((i: any) => i.productId === product.id);
      if (item) {
        const qty = Number(item.quantity);
        const price = Number(item.unitPrice);
        
        // WAC
        const newTotalValue = (wacQty * wacPrice) + (qty * price);
        wacQty += qty;
        wacPrice = wacQty > 0 ? newTotalValue / wacQty : 0;
        
        // FIFO
        fifoQueue.push({ qty, price });
      }
    } else if (l.type === 'SALES' || l.quantityChange < 0) {
      const qtyToDeduct = Math.abs(l.quantityChange);
      
      // WAC
      wacQty = Math.max(0, wacQty - qtyToDeduct);
      
      // FIFO
      let remainingToDeduct = qtyToDeduct;
      while (remainingToDeduct > 0 && fifoQueue.length > 0) {
        if (fifoQueue[0].qty <= remainingToDeduct) {
          remainingToDeduct -= fifoQueue[0].qty;
          fifoQueue.shift();
        } else {
          fifoQueue[0].qty -= remainingToDeduct;
          remainingToDeduct = 0;
        }
      }
    }
  }
  
  const fifoValue = fifoQueue.reduce((sum, batch) => sum + (batch.qty * batch.price), 0);
  const fifoPrice = fifoQueue.length > 0 ? fifoQueue[0].price : 0;
  
  return {
    ...product,
    quantity: effectiveQty,
    disabled: product.status === 'Inactive',
    wacPrice,
    wacValue: wacQty * wacPrice,
    fifoPrice,
    fifoValue
  };
}

// GET all items (with optional search)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, stockFilter } = req.query;
    
    const products = await prisma.product.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search as string, mode: 'insensitive' } },
              { sku: { contains: search as string, mode: 'insensitive' } },
            ],
          }
        : undefined,
      include: {
        category: true,
        supplier: true,
        unit: true,
        partOf: true,
        subPartOf: true,
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Fetch all relevant ledgers once to avoid N+1 queries
    const ledgers = await prisma.stockLedger.findMany({
      orderBy: { date: 'asc' },
      include: {
        invoice: {
          include: { items: true }
        }
      }
    });

    let productsWithValuation = await Promise.all(
      products.map(p => calculateValuationsForProduct(p, ledgers))
    );
    
    if (stockFilter === 'low_stock') {
      productsWithValuation = productsWithValuation.filter(p => p.quantity <= p.min_stock);
    } else if (stockFilter === 'healthy') {
      productsWithValuation = productsWithValuation.filter(p => p.quantity > p.min_stock);
    }
    
    res.json(productsWithValuation);
  } catch (error: any) {
    logger.error('Failed to fetch inventory:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// GET Point-in-time stock for all products as of a specific date (Strict Audit)
router.get('/stock-as-of-date', async (req: Request, res: Response) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }
    const targetDate = new Date(String(date));
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Set target date to end of that day (23:59:59.999) to cover all transactions on that date
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const stockRows: any = await prisma.$queryRaw`
      SELECT 
        p.id,
        p.name,
        p.sku,
        p.quantity AS "currentStock",
        p."createdAt" AS "productCreatedAt",
        -- Cumulative stock ledger balance on or before target date
        COALESCE((
          SELECT SUM(sl."quantityChange") 
          FROM "StockLedger" sl 
          WHERE sl."productId" = p.id AND sl.date <= ${endOfDay}::TIMESTAMP
        ), 0)::INTEGER AS "ledgerSumAtDate",
        -- Earliest stock arrival date in the FUTURE (after target date)
        (
          SELECT MIN(d.dt) FROM (
            SELECT sl.date AS dt 
            FROM "StockLedger" sl 
            WHERE sl."productId" = p.id AND sl."quantityChange" > 0 AND sl.date > ${endOfDay}::TIMESTAMP
            UNION ALL
            SELECT inv.date AS dt 
            FROM "InvoiceItem" ii
            JOIN "Invoice" inv ON inv.id = ii."invoiceId"
            WHERE ii."productId" = p.id AND inv.type = 'PURCHASE' AND inv.status NOT IN ('Cancelled', 'Draft') AND inv.date > ${endOfDay}::TIMESTAMP
          ) d
        ) AS "nextFutureStockDate",
        -- Earliest stock arrival date ever
        (
          SELECT MIN(d.dt) FROM (
            SELECT sl.date AS dt 
            FROM "StockLedger" sl 
            WHERE sl."productId" = p.id AND sl."quantityChange" > 0
            UNION ALL
            SELECT inv.date AS dt 
            FROM "InvoiceItem" ii
            JOIN "Invoice" inv ON inv.id = ii."invoiceId"
            WHERE ii."productId" = p.id AND inv.type = 'PURCHASE' AND inv.status NOT IN ('Cancelled', 'Draft')
          ) d
        ) AS "earliestStockDate",
        -- Total inward transactions count ever
        (
          SELECT COUNT(*)::INTEGER FROM (
            SELECT sl.id 
            FROM "StockLedger" sl 
            WHERE sl."productId" = p.id AND sl."quantityChange" > 0
            UNION ALL
            SELECT ii.id 
            FROM "InvoiceItem" ii
            JOIN "Invoice" inv ON inv.id = ii."invoiceId"
            WHERE ii."productId" = p.id AND inv.type = 'PURCHASE' AND inv.status NOT IN ('Cancelled', 'Draft')
          ) t
        ) AS "totalInwardCount"
      FROM "Product" p
    `;

    const resultMap: Record<string, {
      stockAsOfDate: number;
      currentStock: number;
      isAvailable: boolean;
      nextStockDate: string | null;
      formattedNextStockDate: string | null;
      earliestStockDate: string | null;
      statusMessage: string;
      name: string;
      sku: string;
    }> = {};

    const targetDateFormatted = targetDate.toLocaleDateString('en-GB');

    for (const row of stockRows) {
      const currentStock = Number(row.currentStock) || 0;
      const ledgerSumAtDate = Number(row.ledgerSumAtDate) || 0;
      const totalInwardCount = Number(row.totalInwardCount) || 0;

      let stockAsOfDate = 0;
      if (totalInwardCount > 0) {
        stockAsOfDate = Math.max(0, ledgerSumAtDate);
      } else {
        // Pure opening stock product with no purchase/inward records
        const isCreatedBefore = row.productCreatedAt && new Date(row.productCreatedAt) <= endOfDay;
        stockAsOfDate = isCreatedBefore ? currentStock : 0;
      }

      const nextDate = row.nextFutureStockDate ? new Date(row.nextFutureStockDate) : null;
      const earliestDate = row.earliestStockDate ? new Date(row.earliestStockDate) : null;
      const formattedNextDate = nextDate ? nextDate.toLocaleDateString('en-GB') : null;

      let statusMessage = '';
      if (stockAsOfDate > 0) {
        statusMessage = `${stockAsOfDate} in stock on ${targetDateFormatted}`;
      } else if (formattedNextDate) {
        statusMessage = `Stock not available on ${targetDateFormatted}. Stock will be available on ${formattedNextDate}.`;
      } else {
        statusMessage = 'Stock not available';
      }

      resultMap[row.id] = {
        stockAsOfDate,
        currentStock,
        isAvailable: stockAsOfDate > 0,
        nextStockDate: nextDate ? nextDate.toISOString() : null,
        formattedNextStockDate: formattedNextDate,
        earliestStockDate: earliestDate ? earliestDate.toISOString() : null,
        statusMessage,
        name: row.name,
        sku: row.sku || ''
      };
    }

    res.json(resultMap);
  } catch (error: any) {
    logger.error('Error fetching point-in-time stock:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: error.message || 'Failed to fetch point-in-time stock' });
  }
});

// GET Bin Report (Stock Balance)
router.get('/bin-report', async (req: Request, res: Response) => {
  try {
    // Proactively heal any desynchronization between Product.quantity and StockLedger
    await syncProductQuantitiesWithLedger();

    const { search, warehouse, itemGroup, filter, companyId } = req.query;

    const whereClause: any = {};

    if (companyId && companyId !== 'ALL') {
      whereClause.OR = [
        { companyId: String(companyId) },
        { invoiceItems: { some: { invoice: { companyId: String(companyId), status: { notIn: ['Cancelled', 'Draft'] } } } } },
        { stockLedgers: { some: { invoice: { companyId: String(companyId), status: { notIn: ['Cancelled', 'Draft'] } } } } }
      ];
    }

    if (search) {
      const q = String(search).trim();
      const searchConditions = [
        { name: { contains: q, mode: 'insensitive' as const } },
        { sku: { contains: q, mode: 'insensitive' as const } },
        { location: { contains: q, mode: 'insensitive' as const } },
        { category: { name: { contains: q, mode: 'insensitive' as const } } },
        { company: { name: { contains: q, mode: 'insensitive' as const } } },
      ];
      if (whereClause.OR) {
        whereClause.AND = [{ OR: searchConditions }];
      } else {
        whereClause.OR = searchConditions;
      }
    }

    if (warehouse && warehouse !== 'ALL') {
      whereClause.location = { contains: String(warehouse), mode: 'insensitive' };
    }

    if (itemGroup && itemGroup !== 'ALL') {
      whereClause.category = { name: { contains: String(itemGroup), mode: 'insensitive' } };
    }

    const products = await prisma.product.findMany({
      where: whereClause,
      include: {
        category: true,
        unit: true,
        company: true,
        invoiceItems: {
          where: { invoice: { status: { notIn: ['Cancelled', 'Draft'] } } },
          include: { invoice: { include: { company: true } } },
          take: 1,
          orderBy: { invoice: { date: 'desc' } }
        }
      },
      orderBy: { name: 'asc' },
    });

    // Also fetch live cumulative StockLedger sums for all these products to guarantee 100% audit consistency
    const productIds = products.map((p) => p.id);
    const ledgerMap = new Map<string, number>();
    const purchaseRatesMap = new Map<string, number>();
    const sellingRatesMap = new Map<string, number>();
    const purchasedTotalsMap = new Map<string, number>();
    const soldTotalsMap = new Map<string, number>();

    if (productIds.length > 0) {
      let ledgerSums: any;
      if (companyId && companyId !== 'ALL') {
        ledgerSums = await prisma.$queryRaw`
          SELECT 
            sl."productId", 
            SUM(sl."quantityChange") AS "ledgerSum"
          FROM "StockLedger" sl
          LEFT JOIN "Invoice" inv ON inv.id = sl."invoiceId"
          WHERE sl."productId" IN (${Prisma.join(productIds)})
            AND (inv."companyId" = ${String(companyId)} OR (sl."invoiceId" IS NULL AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id = sl."productId" AND p."companyId" = ${String(companyId)})))
            AND (inv.id IS NULL OR inv."status" NOT IN ('Draft', 'Cancelled'))
          GROUP BY sl."productId"
        `;
      } else {
        ledgerSums = await prisma.$queryRaw`
          SELECT 
            sl."productId", 
            SUM(sl."quantityChange") AS "ledgerSum"
          FROM "StockLedger" sl
          LEFT JOIN "Invoice" inv ON inv.id = sl."invoiceId"
          WHERE sl."productId" IN (${Prisma.join(productIds)})
            AND (inv.id IS NULL OR inv."status" NOT IN ('Draft', 'Cancelled'))
          GROUP BY sl."productId"
        `;
      }
      for (const row of ledgerSums) {
        ledgerMap.set(row.productId, Number(row.ledgerSum) || 0);
      }

      // Fetch invoice items for both PURCHASE and SALES to compute rates and invoiced totals
      const invoiceItems = await prisma.invoiceItem.findMany({
        where: {
          productId: { in: productIds },
          invoice: {
            status: { notIn: ['Cancelled', 'Draft'] },
            ...(companyId && companyId !== 'ALL' ? { companyId: String(companyId) } : {})
          }
        },
        select: {
          productId: true,
          unitPrice: true,
          totalPrice: true,
          invoice: {
            select: {
              type: true,
              totalAmount: true,
              date: true
            }
          }
        },
        orderBy: {
          invoice: {
            date: 'desc'
          }
        }
      });

      for (const item of invoiceItems) {
        const pId = item.productId;
        const uPrice = Number(item.unitPrice) || 0;
        const tPrice = Number(item.totalPrice) || 0;

        if (item.invoice.type === 'PURCHASE') {
          if (!purchaseRatesMap.has(pId)) {
            purchaseRatesMap.set(pId, uPrice);
          }
          purchasedTotalsMap.set(pId, (purchasedTotalsMap.get(pId) || 0) + tPrice);
        } else if (item.invoice.type === 'SALES') {
          if (!sellingRatesMap.has(pId)) {
            sellingRatesMap.set(pId, uPrice);
          }
          soldTotalsMap.set(pId, (soldTotalsMap.get(pId) || 0) + tPrice);
        }
      }
    }

    const parts = await prisma.partOf.findMany();
    const subParts = await prisma.subPartOf.findMany();

    const binReport = products.map((p, idx) => {
      const part = parts.length > 0 ? parts[idx % parts.length].name : 'Standard';
      const subPart = subParts.length > 0 ? subParts[idx % subParts.length].name : 'General';

      // Always display the true cumulative stock ledger balance if ledger entries exist, fallback to 0 if none
      const actualQuantity = ledgerMap.has(p.id) ? ledgerMap.get(p.id)! : 0;
      const resolvedCompany = p.company?.name || p.invoiceItems?.[0]?.invoice?.company?.name || 'All Companies';
      const resolvedCompanyId = p.companyId || p.invoiceItems?.[0]?.invoice?.companyId || null;
      const resolvedCompanyCode = p.company?.code || p.invoiceItems?.[0]?.invoice?.company?.code || '';

      // Determine purchase rate from latest purchase invoice, fallback to product cost_price
      const purchaseRate = purchaseRatesMap.has(p.id)
        ? purchaseRatesMap.get(p.id)!
        : (Number(p.cost_price) || 0);
      
      // Determine selling rate from latest sales invoice, fallback to product selling_price
      const sellingRate = sellingRatesMap.has(p.id)
        ? sellingRatesMap.get(p.id)!
        : (Number(p.selling_price) || 0);

      // Invoiced totals for net invoiced balance calculation (Purchased Value - Sold Value)
      const totalPurchasedValue = purchasedTotalsMap.get(p.id) || 0;
      const totalSoldValue = soldTotalsMap.get(p.id) || 0;
      const netInvoicedBalance = totalPurchasedValue - totalSoldValue;

      // Valuation based on purchase cost of in-stock items
      const stockValuation = actualQuantity > 0 ? actualQuantity * purchaseRate : 0;
      // Valuation based on retail selling price of in-stock items
      const salesValuation = actualQuantity > 0 ? actualQuantity * sellingRate : 0;

      return {
        id: p.id,
        itemCode: p.sku,
        itemName: p.name,
        itemGroup: p.category?.name || 'Finished Goods',
        partOf: part,
        subPartOf: subPart,
        uom: p.unit?.name || 'Pcs',
        actualQuantity,
        purchaseRate,
        sellingRate,
        stockValuation,
        salesValuation,
        totalPurchasedValue,
        totalSoldValue,
        netInvoicedBalance,
        warehouse: p.location || 'Main Warehouse',
        companyId: resolvedCompanyId,
        companyName: resolvedCompany,
        companyCode: resolvedCompanyCode,
        assignedTo: 'Plant Store',
        tags: actualQuantity <= p.min_stock ? 'LOW STOCK' : 'IN STOCK',
      };
    });

    if (filter === 'low') {
      return res.json(binReport.filter((item) => item.actualQuantity <= 0));
    }

    res.json(binReport);
  } catch (error: any) {
    logger.error('Failed to generate bin report:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: error.message || 'Failed to generate bin report' });
  }
});

// GET single item by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        supplier: true,
        unit: true,
        partOf: true,
        subPartOf: true,
      },
    });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const ledgers = await prisma.stockLedger.findMany({
      where: { productId: id },
      orderBy: { date: 'asc' },
      include: {
        invoice: {
          include: { items: true }
        }
      }
    });

    const productWithValuation = await calculateValuationsForProduct(product, ledgers);
    res.json(productWithValuation);
  } catch (error: any) {
    logger.error('Failed to fetch product:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Helper to ensure SKU uniqueness and auto-increment sequential codes if duplicate
async function resolveUniqueSku(rawSku: string): Promise<string> {
  let sku = (rawSku && rawSku.toString().trim()) || `SKU-${Date.now()}`;
  const existing = await prisma.product.findUnique({ where: { sku } });
  if (!existing) return sku;

  const match = sku.match(/^(.*?)(\d+)$/);
  if (match) {
    const prefix = match[1];
    const padLen = match[2].length;
    const similar = await prisma.product.findMany({
      where: { sku: { startsWith: prefix } },
      select: { sku: true }
    });
    let maxNum = parseInt(match[2], 10);
    const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
    for (const item of similar) {
      const m = item.sku.match(regex);
      if (m) {
        const num = parseInt(m[1], 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
    return `${prefix}${String(maxNum + 1).padStart(padLen, '0')}`;
  }

  let counter = 1;
  while (await prisma.product.findUnique({ where: { sku: `${sku}-${counter}` } })) {
    counter++;
  }
  return `${sku}-${counter}`;
}

// POST new item
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = req.body;
    
    // Only item name is strictly required
    if (!data.name || !data.name.toString().trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }

    const name = data.name.toString().trim();
    const sku = await resolveUniqueSku(data.sku);
    const cost_price = data.cost_price !== undefined && data.cost_price !== null && data.cost_price !== ''
      ? parseFloat(data.cost_price)
      : 0;
    const selling_price = data.selling_price !== undefined && data.selling_price !== null && data.selling_price !== ''
      ? parseFloat(data.selling_price)
      : 0;
    const min_stock = data.min_stock !== undefined && data.min_stock !== null && data.min_stock !== ''
      ? parseInt(data.min_stock)
      : 0;
    const initialQty = data.quantity !== undefined && data.quantity !== null && data.quantity !== ''
      ? parseInt(data.quantity)
      : 0;

    let categoryId = typeof data.categoryId === 'object' && data.categoryId ? data.categoryId.id : (data.categoryId || null);
    if (!categoryId && data.categoryName) {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: data.categoryName.trim(), mode: 'insensitive' } }
      });
      if (cat) categoryId = cat.id;
    }

    let supplierId = typeof data.supplierId === 'object' && data.supplierId ? data.supplierId.id : (data.supplierId || null);
    if (!supplierId) {
      const defaultSupplier = await prisma.supplier.findFirst();
      if (defaultSupplier) supplierId = defaultSupplier.id;
    }

    const unitId = typeof data.unitId === 'object' && data.unitId ? data.unitId.id : (data.unitId || null);

    // Resolve partOf
    let partOfId = typeof data.partOfId === 'object' && data.partOfId ? data.partOfId.id : (data.partOfId || null);
    if (!partOfId && data.partOf) {
      const partName = (typeof data.partOf === 'object' && data.partOf ? data.partOf.name : data.partOf.toString()).trim();
      if (partName) {
        let part = await prisma.partOf.findFirst({
          where: { name: { equals: partName, mode: 'insensitive' } }
        });
        if (!part) {
          part = await prisma.partOf.create({ data: { name: partName } });
        }
        partOfId = part.id;
      }
    }

    // Resolve subPartOf
    let subPartOfId = typeof data.subPartOfId === 'object' && data.subPartOfId ? data.subPartOfId.id : (data.subPartOfId || null);
    if (!subPartOfId && data.subPartOf) {
      const subPartName = (typeof data.subPartOf === 'object' && data.subPartOf ? data.subPartOf.name : data.subPartOf.toString()).trim();
      if (subPartName) {
        let subPart = await prisma.subPartOf.findFirst({
          where: { name: { equals: subPartName, mode: 'insensitive' } }
        });
        if (!subPart) {
          subPart = await prisma.subPartOf.create({ data: { name: subPartName } });
        }
        subPartOfId = subPart.id;
      }
    }

    const disabledVal = data.disabled !== undefined 
      ? Boolean(data.disabled) 
      : (data.status !== undefined ? (data.status === 'Inactive' || data.status === 'Disabled') : false);
    const statusVal = disabledVal ? 'Inactive' : (data.status || 'Active');

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          sku,
          name,
          quantity: initialQty,
          cost_price: isNaN(cost_price) ? 0 : cost_price,
          selling_price: isNaN(selling_price) ? 0 : selling_price,
          min_stock: isNaN(min_stock) ? 0 : min_stock,
          categoryId: categoryId || null,
          supplierId: supplierId || null,
          unitId: unitId || null,
          partOfId: partOfId || null,
          subPartOfId: subPartOfId || null,
          invoiceDate: null,
          location: data.location || '',
          status: statusVal,
          imageUrl: data.imageUrl || null,
          attachments: data.attachments || null,
        },
        include: {
          category: true,
          supplier: true,
          unit: true,
          partOf: true,
          subPartOf: true
        }
      });

      // Keep StockLedger in sync if initial quantity > 0
      if (initialQty > 0) {
        await tx.stockLedger.create({
          data: {
            productId: created.id,
            date: created.createdAt,
            quantityChange: initialQty,
            runningBalance: initialQty,
            type: 'INITIAL',
          }
        });
      }

      // Keep SkuMaster in sync
      try {
        await tx.skuMaster.upsert({
          where: { sku: created.sku },
          update: {
            name: created.name,
            categoryId: created.categoryId,
            status: created.status
          },
          create: {
            name: created.name,
            sku: created.sku,
            categoryId: created.categoryId,
            status: created.status
          }
        });
      } catch (err: any) {
        console.warn('Could not sync SkuMaster:', err?.message);
      }

      return created;
    });

    res.status(201).json({
      ...product,
      disabled: product.status === 'Inactive'
    });
  } catch (error: any) {
    logger.error('Failed to create product:', { error: error?.message || error, stack: error?.stack });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    res.status(500).json({ error: error?.message || 'Failed to create product' });
  }
});

// PUT update item
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const categoryId = data.categoryId !== undefined
      ? (typeof data.categoryId === 'object' && data.categoryId ? data.categoryId.id : (data.categoryId || null))
      : undefined;
    const supplierId = data.supplierId !== undefined
      ? (typeof data.supplierId === 'object' && data.supplierId ? data.supplierId.id : (data.supplierId || null))
      : undefined;
    const unitId = data.unitId !== undefined
      ? (typeof data.unitId === 'object' && data.unitId ? data.unitId.id : (data.unitId || null))
      : undefined;

    let partOfId: string | null | undefined = undefined;
    if (data.partOfId !== undefined) {
      partOfId = typeof data.partOfId === 'object' && data.partOfId ? data.partOfId.id : (data.partOfId || null);
    }
    if (partOfId === undefined && data.partOf !== undefined) {
      if (!data.partOf) {
        partOfId = null;
      } else {
        const partName = (typeof data.partOf === 'object' && data.partOf ? data.partOf.name : data.partOf.toString()).trim();
        if (partName) {
          let part = await prisma.partOf.findFirst({
            where: { name: { equals: partName, mode: 'insensitive' } }
          });
          if (!part) {
            part = await prisma.partOf.create({ data: { name: partName } });
          }
          partOfId = part.id;
        } else {
          partOfId = null;
        }
      }
    }

    let subPartOfId: string | null | undefined = undefined;
    if (data.subPartOfId !== undefined) {
      subPartOfId = typeof data.subPartOfId === 'object' && data.subPartOfId ? data.subPartOfId.id : (data.subPartOfId || null);
    }
    if (subPartOfId === undefined && data.subPartOf !== undefined) {
      if (!data.subPartOf) {
        subPartOfId = null;
      } else {
        const subPartName = (typeof data.subPartOf === 'object' && data.subPartOf ? data.subPartOf.name : data.subPartOf.toString()).trim();
        if (subPartName) {
          let subPart = await prisma.subPartOf.findFirst({
            where: { name: { equals: subPartName, mode: 'insensitive' } }
          });
          if (!subPart) {
            subPart = await prisma.subPartOf.create({ data: { name: subPartName } });
          }
          subPartOfId = subPart.id;
        } else {
          subPartOfId = null;
        }
      }
    }

    const disabledVal = data.disabled !== undefined 
      ? Boolean(data.disabled) 
      : (data.status !== undefined ? (data.status === 'Inactive' || data.status === 'Disabled') : undefined);
    const statusVal = disabledVal !== undefined 
      ? (disabledVal ? 'Inactive' : 'Active') 
      : (data.status ? data.status : undefined);

    const product = await prisma.$transaction(async (tx) => {
      let finalQuantity: number | undefined = undefined;
      if (data.quantity !== undefined && data.quantity !== null && data.quantity !== '') {
        const newQty = parseInt(data.quantity);
        finalQuantity = newQty;

        const ledgerAgg: any = await tx.$queryRaw`
          SELECT COALESCE(SUM("quantityChange"), 0) AS total_ledger_qty,
                 COUNT(*)::INTEGER AS ledger_count
          FROM "StockLedger"
          WHERE "productId" = ${id}
        `;
        const ledgerCount = Number(ledgerAgg[0]?.ledger_count || 0);
        const currentLedgerTotal = Number(ledgerAgg[0]?.total_ledger_qty || 0);

        if (ledgerCount > 0) {
          const diff = newQty - currentLedgerTotal;
          if (diff !== 0) {
            await tx.stockLedger.create({
              data: {
                productId: id,
                date: new Date(),
                type: 'ADJUSTMENT',
                quantityChange: diff,
                runningBalance: newQty,
              }
            });
          }
        } else if (newQty > 0) {
          await tx.stockLedger.create({
            data: {
              productId: id,
              date: new Date(),
              type: 'INITIAL',
              quantityChange: newQty,
              runningBalance: newQty,
            }
          });
        }
      }

      const updated = await tx.product.update({
        where: { id },
        data: {
          sku: data.sku !== undefined ? data.sku.toString().trim() : undefined,
          name: data.name !== undefined ? data.name.toString().trim() : undefined,
          quantity: finalQuantity,
          cost_price: data.cost_price !== undefined && data.cost_price !== null && data.cost_price !== '' ? parseFloat(data.cost_price) : undefined,
          selling_price: data.selling_price !== undefined && data.selling_price !== null && data.selling_price !== '' ? parseFloat(data.selling_price) : undefined,
          min_stock: data.min_stock !== undefined && data.min_stock !== null && data.min_stock !== '' ? parseInt(data.min_stock) : undefined,
          categoryId,
          supplierId,
          unitId,
          partOfId,
          subPartOfId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : undefined,
          location: data.location !== undefined ? data.location : undefined,
          status: statusVal,
          imageUrl: data.imageUrl !== undefined ? data.imageUrl : undefined,
          attachments: data.attachments !== undefined ? data.attachments : undefined,
        },
        include: {
          category: true,
          supplier: true,
          unit: true,
          partOf: true,
          subPartOf: true
        }
      });

      if (updated.sku) {
        try {
          await tx.skuMaster.upsert({
            where: { sku: updated.sku },
            update: {
              name: updated.name,
              categoryId: updated.categoryId,
              status: updated.status
            },
            create: {
              name: updated.name,
              sku: updated.sku,
              categoryId: updated.categoryId,
              status: updated.status
            }
          });
        } catch (err: any) {
          console.warn('Could not sync SkuMaster on update:', err?.message);
        }
      }

      return updated;
    });

    res.json({
      ...product,
      disabled: product.status === 'Inactive'
    });
  } catch (error: any) {
    logger.error('Failed to update product:', { error: error?.message || error, stack: error?.stack });
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    res.status(500).json({ error: error?.message || 'Failed to update product' });
  }
});

// DELETE item
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.product.delete({
      where: { id },
    });
    res.status(204).send();
  } catch (error: any) {
    logger.error('Failed to delete product:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// POST bulk upload
router.post('/bulk-upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Save uploaded Excel file to disk for audit & recovery
    const uploadDir = path.join(process.cwd(), 'uploads', 'bulk_imports', 'items');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const savedFileName = `${Date.now()}_${safeName}`;
    const savedFilePath = path.join(uploadDir, savedFileName);
    await fs.promises.writeFile(savedFilePath, req.file.buffer);
    const fileUrl = `/uploads/bulk_imports/items/${savedFileName}`;

    logger.info('Bulk upload items Excel file saved successfully', { originalName: req.file.originalname, fileUrl, size: req.file.size });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any>(sheet);

    let successCount = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Validation
        if (!row.sku || !row.name || row.quantity === undefined || !row.cost_price || !row.selling_price || !row.categoryName || !row.supplierName) {
          errors.push(`Row ${i + 2}: Missing required fields`);
          continue;
        }

        // Find or create Category
        let category = await prisma.category.findFirst({ where: { name: row.categoryName } });
        if (!category) {
          category = await prisma.category.create({ data: { name: row.categoryName } });
        }

        // Find or create Supplier
        let supplier = await prisma.supplier.findFirst({ where: { name: row.supplierName } });
        if (!supplier) {
          supplier = await prisma.supplier.create({ data: { name: row.supplierName } });
        }

        // Find or create Unit
        let unit = null;
        if (row.unitName) {
          unit = await prisma.unit.findFirst({ where: { name: row.unitName } });
          if (!unit) {
            unit = await prisma.unit.create({ data: { name: row.unitName } });
          }
        }

        // Find or create PartOf
        let partOf = null;
        const partOfName = (row.partOf || row['Part Of'] || row.part_of || row.partName || '').toString().trim();
        if (partOfName) {
          partOf = await prisma.partOf.findFirst({
            where: { name: { equals: partOfName, mode: 'insensitive' } }
          });
          if (!partOf) {
            partOf = await prisma.partOf.create({ data: { name: partOfName } });
          }
        }

        // Find or create SubPartOf
        let subPartOf = null;
        const subPartOfName = (row.subPartOf || row['Sub Part Of'] || row.sub_part_of || row.subPartName || '').toString().trim();
        if (subPartOfName) {
          subPartOf = await prisma.subPartOf.findFirst({
            where: { name: { equals: subPartOfName, mode: 'insensitive' } }
          });
          if (!subPartOf) {
            subPartOf = await prisma.subPartOf.create({ data: { name: subPartOfName } });
          }
        }

        // Upsert Product
        const upsertedProduct = await prisma.product.upsert({
          where: { sku: row.sku.toString() },
          update: {
            name: row.name,
            quantity: parseInt(row.quantity),
            cost_price: parseFloat(row.cost_price),
            selling_price: parseFloat(row.selling_price),
            min_stock: parseInt(row.min_stock) || 0,
            categoryId: category.id,
            supplierId: supplier.id,
            unitId: unit?.id || null,
            partOfId: partOf?.id || undefined,
            subPartOfId: subPartOf?.id || undefined,
            location: row.location || '',
            status: row.status || 'Active',
          },
          create: {
            sku: row.sku.toString(),
            name: row.name,
            quantity: parseInt(row.quantity),
            cost_price: parseFloat(row.cost_price),
            selling_price: parseFloat(row.selling_price),
            min_stock: parseInt(row.min_stock) || 0,
            categoryId: category.id,
            supplierId: supplier.id,
            unitId: unit?.id || null,
            partOfId: partOf?.id || null,
            subPartOfId: subPartOf?.id || null,
            location: row.location || '',
            status: row.status || 'Active',
          },
        });

        // Ensure StockLedger tracks initial quantity
        const initialQty = parseInt(row.quantity) || 0;
        if (initialQty > 0) {
          const ledgerAgg = await prisma.stockLedger.aggregate({
            where: { productId: upsertedProduct.id },
            _sum: { quantityChange: true },
          });
          const ledgerSum = ledgerAgg._sum.quantityChange || 0;
          const diff = upsertedProduct.quantity - ledgerSum;
          if (diff > 0) {
            await prisma.stockLedger.create({
              data: {
                productId: upsertedProduct.id,
                date: upsertedProduct.createdAt,
                type: 'INITIAL',
                quantityChange: diff,
                runningBalance: diff,
              },
            });
          }
        }

        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    res.json({ message: `Successfully processed ${successCount} rows.`, fileUrl, fileName: savedFileName, errors });
  } catch (error: any) {
    logger.error('Bulk upload error:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: 'Failed to process bulk upload' });
  }
});

// POST bulk import items (JSON)
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

    const defaultSupplier = await prisma.supplier.findFirst();

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const name = (row.name || row.itemName || row['Item Name'] || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Item Name is required`);
          continue;
        }

        // Resolve Category
        let categoryId = row.categoryId || null;
        const catName = (row.category || row.categoryName || row.itemGroup || row['Item Group'] || '').toString().trim();
        if (!categoryId && catName) {
          let cat = await prisma.category.findFirst({
            where: { name: { equals: catName, mode: 'insensitive' } }
          });
          if (!cat) {
            cat = await prisma.category.create({ data: { name: catName, status: 'Active' } });
          }
          categoryId = cat.id;
        }

        // Resolve Unit
        let unitId = row.unitId || null;
        const uomName = (row.uom || row.unit || row.unitName || row['Default Unit of Measure'] || '').toString().trim();
        if (!unitId && uomName) {
          let un = await prisma.unit.findFirst({
            where: { name: { equals: uomName, mode: 'insensitive' } }
          });
          if (!un) {
            un = await prisma.unit.create({ data: { name: uomName, status: 'Active' } });
          }
          unitId = un.id;
        }

        // Resolve Supplier
        let supplierId = row.supplierId || null;
        const supName = (row.supplier || row.supplierName || '').toString().trim();
        if (!supplierId && supName) {
          let sup = await prisma.supplier.findFirst({
            where: { name: { equals: supName, mode: 'insensitive' } }
          });
          if (!sup) {
            sup = await prisma.supplier.create({ data: { name: supName, status: 'Active' } });
          }
          supplierId = sup.id;
        }
        if (!supplierId && defaultSupplier) {
          supplierId = defaultSupplier.id;
        }

        // Resolve Part Of
        let partOfId = row.partOfId || null;
        const partName = (row.partOf || row.part_of || row['Part Of'] || row.partName || '').toString().trim();
        if (!partOfId && partName) {
          let part = await prisma.partOf.findFirst({
            where: { name: { equals: partName, mode: 'insensitive' } }
          });
          if (!part) {
            part = await prisma.partOf.create({ data: { name: partName } });
          }
          partOfId = part.id;
        }

        // Resolve Sub Part Of
        let subPartOfId = row.subPartOfId || null;
        const subPartName = (row.subPartOf || row.sub_part_of || row['Sub Part Of'] || row.subPartName || '').toString().trim();
        if (!subPartOfId && subPartName) {
          let subPart = await prisma.subPartOf.findFirst({
            where: { name: { equals: subPartName, mode: 'insensitive' } }
          });
          if (!subPart) {
            subPart = await prisma.subPartOf.create({ data: { name: subPartName } });
          }
          subPartOfId = subPart.id;
        }

        // Numeric fields
        const cost_price = row.cost_price !== undefined && row.cost_price !== null && row.cost_price !== ''
          ? parseFloat(row.cost_price)
          : (row.costPrice !== undefined ? parseFloat(row.costPrice) : 0);
        const selling_price = row.selling_price !== undefined && row.selling_price !== null && row.selling_price !== ''
          ? parseFloat(row.selling_price)
          : (row.sellingPrice !== undefined ? parseFloat(row.sellingPrice) : 0);
        const min_stock = row.min_stock !== undefined && row.min_stock !== null && row.min_stock !== ''
          ? parseInt(row.min_stock)
          : (row.minStock !== undefined ? parseInt(row.minStock) : 0);
        const quantity = row.quantity !== undefined && row.quantity !== null && row.quantity !== ''
          ? parseInt(row.quantity)
          : (row.qty !== undefined ? parseInt(row.qty) : 0);

        const location = (row.location || row.binLocation || row['Bin Location'] || '').toString().trim();
        const status = row.status === 'Inactive' || row.disabled === true || row.disabled === 'Yes' ? 'Inactive' : 'Active';

        // Resolve SKU and existing product
        let rawSku = (row.sku || row.itemCode || row['Item Code (SKU)'] || '').toString().trim();
        let targetProduct: any = null;

        let existing = null;
        if (rawSku) {
          existing = await prisma.product.findUnique({ where: { sku: rawSku } });
        }
        if (!existing && name) {
          existing = await prisma.product.findFirst({
            where: { name: { equals: name, mode: 'insensitive' } }
          });
        }

        if (existing) {
          // Existing product found: update all attributes including partOfId & subPartOfId
          targetProduct = await prisma.product.update({
            where: { id: existing.id },
            data: {
              name,
              quantity: isNaN(quantity) ? existing.quantity : quantity,
              cost_price: isNaN(cost_price) ? existing.cost_price : cost_price,
              selling_price: isNaN(selling_price) ? existing.selling_price : selling_price,
              min_stock: isNaN(min_stock) ? existing.min_stock : min_stock,
              categoryId: categoryId || existing.categoryId,
              supplierId: supplierId || existing.supplierId,
              unitId: unitId || existing.unitId,
              partOfId: partOfId !== null ? partOfId : existing.partOfId,
              subPartOfId: subPartOfId !== null ? subPartOfId : existing.subPartOfId,
              location: location || existing.location,
              status: status || existing.status,
            }
          });
          updatedCount++;
        } else {
          // New SKU / product
          let finalSku = rawSku;
          if (!finalSku) {
            finalSku = await resolveUniqueSku(`SKU-${Date.now()}`);
          } else {
            const skuCollision = await prisma.product.findUnique({ where: { sku: finalSku } });
            if (skuCollision) {
              finalSku = await resolveUniqueSku(finalSku);
            }
          }

          targetProduct = await prisma.product.create({
            data: {
              sku: finalSku,
              name,
              quantity: isNaN(quantity) ? 0 : quantity,
              cost_price: isNaN(cost_price) ? 0 : cost_price,
              selling_price: isNaN(selling_price) ? 0 : selling_price,
              min_stock: isNaN(min_stock) ? 0 : min_stock,
              categoryId: categoryId || null,
              supplierId: supplierId || null,
              unitId: unitId || null,
              partOfId: partOfId || null,
              subPartOfId: subPartOfId || null,
              location,
              status,
            }
          });
          createdCount++;
        }

        // Sync SkuMaster
        if (targetProduct) {
          try {
            await prisma.skuMaster.upsert({
              where: { sku: targetProduct.sku },
              update: {
                name: targetProduct.name,
                categoryId: targetProduct.categoryId,
                status: targetProduct.status
              },
              create: {
                name: targetProduct.name,
                sku: targetProduct.sku,
                categoryId: targetProduct.categoryId,
                status: targetProduct.status
              }
            });
          } catch (e: any) {
            console.warn('SkuMaster sync warning:', e?.message);
          }

          // Initial stock ledger tracking
          if (targetProduct.quantity > 0) {
            try {
              const ledgerAgg = await prisma.stockLedger.aggregate({
                where: { productId: targetProduct.id },
                _sum: { quantityChange: true },
              });
              const ledgerSum = ledgerAgg._sum.quantityChange || 0;
              const diff = targetProduct.quantity - ledgerSum;
              if (diff > 0) {
                await prisma.stockLedger.create({
                  data: {
                    productId: targetProduct.id,
                    date: targetProduct.createdAt || new Date(),
                    type: 'INITIAL',
                    quantityChange: diff,
                    runningBalance: targetProduct.quantity,
                  },
                });
              }
            } catch (e: any) {
              console.warn('StockLedger sync warning:', e?.message);
            }
          }
        }

        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    res.json({
      message: `Successfully processed ${successCount} items (${createdCount} created, ${updatedCount} updated).`,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    logger.error('Failed to bulk import products:', { error: error?.message || error, stack: error?.stack });
    res.status(500).json({ error: error.message || 'Failed to bulk import products' });
  }
});

export default router;
