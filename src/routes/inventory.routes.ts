import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';
import logger from '../utils/logger';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// Helper to calculate WAC and FIFO for a product
async function calculateValuationsForProduct(product: any, ledgers: any[]) {
  const productLedgers = ledgers.filter(l => l.productId === product.id);
  
  let wacQty = 0;
  let wacPrice = 0;
  
  let fifoQueue: {qty: number, price: number}[] = [];

  for (const l of productLedgers) {
    if (l.type === 'PURCHASE' && l.invoice) {
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
        unit: true
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
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// GET Bin Report (Stock Balance)
router.get('/bin-report', async (req: Request, res: Response) => {
  try {
    const { search, warehouse, itemGroup, filter } = req.query;

    const whereClause: any = {};

    if (search) {
      const q = String(search).trim();
      whereClause.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { location: { contains: q, mode: 'insensitive' } },
        { category: { name: { contains: q, mode: 'insensitive' } } },
      ];
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
      },
      orderBy: { name: 'asc' },
    });

    const parts = await prisma.partOf.findMany();
    const subParts = await prisma.subPartOf.findMany();

    const binReport = products.map((p, idx) => {
      const part = parts.length > 0 ? parts[idx % parts.length].name : 'Standard';
      const subPart = subParts.length > 0 ? subParts[idx % subParts.length].name : 'General';

      return {
        id: p.id,
        itemCode: p.sku,
        itemName: p.name,
        itemGroup: p.category?.name || 'Finished Goods',
        partOf: part,
        subPartOf: subPart,
        uom: p.unit?.name || 'Pcs',
        actualQuantity: Number(p.quantity) || 0,
        warehouse: p.location || 'Main Warehouse',
        assignedTo: 'Plant Store',
        tags: p.quantity <= p.min_stock ? 'LOW STOCK' : 'IN STOCK',
      };
    });

    if (filter === 'low') {
      return res.json(binReport.filter((item) => item.actualQuantity <= 0));
    }

    res.json(binReport);
  } catch (error: any) {
    console.error('Failed to generate bin report:', error);
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
        unit: true
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
  } catch (error) {
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
          invoiceDate: null,
          location: data.location || '',
          status: data.status || 'Active',
        },
        include: {
          category: true,
          supplier: true,
          unit: true
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

    res.status(201).json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    console.error('Failed to create product:', error);
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

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: {
          sku: data.sku !== undefined ? data.sku.toString().trim() : undefined,
          name: data.name !== undefined ? data.name.toString().trim() : undefined,
          quantity: data.quantity !== undefined && data.quantity !== null && data.quantity !== '' ? parseInt(data.quantity) : undefined,
          cost_price: data.cost_price !== undefined && data.cost_price !== null && data.cost_price !== '' ? parseFloat(data.cost_price) : undefined,
          selling_price: data.selling_price !== undefined && data.selling_price !== null && data.selling_price !== '' ? parseFloat(data.selling_price) : undefined,
          min_stock: data.min_stock !== undefined && data.min_stock !== null && data.min_stock !== '' ? parseInt(data.min_stock) : undefined,
          categoryId,
          supplierId,
          unitId,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : undefined,
          location: data.location !== undefined ? data.location : undefined,
          status: data.status !== undefined ? data.status : undefined,
        },
        include: {
          category: true,
          supplier: true,
          unit: true
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

    res.json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    console.error('Failed to update product:', error);
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
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// POST bulk upload
router.post('/bulk-upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    console.log(" call bulk-upload :: ");
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

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

    res.json({ message: `Successfully processed ${successCount} rows.`, errors });
  } catch (error) {
    logger.error('Bulk upload error', { error });
    res.status(500).json({ error: 'Failed to process bulk upload' });
  }
});

export default router;
